import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashToken } from '../lib/db.js';
import { startApp, seedUser, tokenFor, linkFor, mailsTo } from './helpers.js';

const ALLOWLIST = { SIGNUP_MODE: 'allowlist', ADMIN_EMAILS: 'matter@spore.bond' };

async function beta(t) {
  const app = await startApp(t, ALLOWLIST);
  const admin = seedUser(app, { email: 'matter@spore.bond', handle: 'svde' });
  return { app, admin };
}

const ask = (app, email, note) => app.client().post('/auth/request-access', { email, ...(note === undefined ? {} : { note }) });

test('asking for access gets one reply per req & the req waits for the admin', async (t) => {
  const { app, admin } = await beta(t);
  seedUser(app, { email: 'member@example.com', handle: 'member' });

  const fresh = await ask(app, 'New@Example.com', '  heard about it from a friend  ');
  const again = await ask(app, 'new@example.com', 'second try');
  const member = await ask(app, 'member@example.com');
  for (const res of [fresh, again, member]) assert.deepEqual([res.status, res.body], [200, { status: 'received' }]);

  const pending = (await admin.client.get('/api/admin/requests')).body.requests;
  assert.equal(pending.length, 1, 'no duplicate for a second ask, no request for a member');
  assert.equal(pending[0].email, 'new@example.com');
  assert.equal(pending[0].note, 'heard about it from a friend');
  assert.equal(app.log.length, 0, 'asking sends no mail');

  assert.equal((await ask(app, 'x@example.com', 'n'.repeat(501))).status, 400);
  assert.equal((await ask(app, 'not an address')).status, 400);
  const foreign = await app.client().post('/auth/request-access', { email: 'y@example.com' }, { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
});

test('only admins see and decide requests', async (t) => {
  const { app } = await beta(t);
  const alice = seedUser(app, { email: 'alice@example.com', handle: 'alice' });
  await ask(app, 'new@example.com');
  const id = app.db.prepare('SELECT id FROM access_requests').pluck().get();

  assert.equal((await app.client().get('/api/admin/requests')).status, 401);
  assert.equal((await alice.client.get('/api/admin/requests')).status, 403);
  assert.equal((await alice.client.post(`/api/admin/requests/${id}/approve`)).status, 403);
  assert.equal((await alice.client.post(`/api/admin/requests/${id}/decline`)).status, 403);
  assert.equal(app.db.prepare('SELECT status FROM access_requests').pluck().get(), 'pending');
});

test('approval mails a week-long invite that signs the address in', async (t) => {
  const { app, admin } = await beta(t);
  await ask(app, 'new@example.com');
  assert.equal(mailsTo(app.log, 'new@example.com').length, 0);
  const before = await app.client().post('/auth/request-link', { email: 'new@example.com' });
  assert.equal(before.status, 200);
  assert.equal(mailsTo(app.log, 'new@example.com').length, 0, 'still waiting, so no link');

  const id = (await admin.client.get('/api/admin/requests')).body.requests[0].id;
  const approved = await admin.client.post(`/api/admin/requests/${id}/approve`);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.request.status, 'approved');
  assert.match(mailsTo(app.log, 'new@example.com')[0], /you're in/);

  const token = tokenFor(app.log, 'new@example.com');
  const row = app.db.prepare('SELECT * FROM login_tokens WHERE token_hash = ?').get(hashToken(token));
  assert.equal(row.expires_at - row.created_at, 7 * 24 * 60 * 60 * 1000);
  assert.equal(linkFor(app.log, 'new@example.com').pathname, '/auth');

  const verified = await app.client().post('/auth/verify', { token });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.needsHandle, true);

  await admin.client.post(`/api/admin/requests/${id}/approve`);
  assert.equal(mailsTo(app.log, 'new@example.com').length, 2, 'approving again resends invite');
  assert.deepEqual((await admin.client.get('/api/admin/requests')).body.requests, []);
  assert.equal((await admin.client.get('/api/admin/requests?status=approved')).body.requests.length, 1);
});

test('a declined address stays out it may ask again', async (t) => {
  const { app, admin } = await beta(t);
  await ask(app, 'no@example.com', 'first');
  const id = (await admin.client.get('/api/admin/requests')).body.requests[0].id;
  assert.equal((await admin.client.post(`/api/admin/requests/${id}/decline`)).status, 200);
  assert.equal((await admin.client.post(`/api/admin/requests/${id}/decline`)).status, 409);
  assert.equal((await admin.client.post(`/api/admin/requests/${id}/approve`)).status, 409);

  await app.client().post('/auth/request-link', { email: 'no@example.com' });
  assert.equal(mailsTo(app.log, 'no@example.com').length, 0);

  await ask(app, 'no@example.com', 'second');
  const pending = (await admin.client.get('/api/admin/requests')).body.requests;
  assert.deepEqual(pending.map((r) => r.note), ['second']);
  assert.equal((await admin.client.post('/api/admin/requests/nothing/approve')).status, 404);
});

test('admins can always sign up, even when not listed', async (t) => {
  const app = await startApp(t, { SIGNUP_MODE: 'closed', ADMIN_EMAILS: 'matter@spore.bond' });
  await app.client().post('/auth/request-link', { email: 'matter@spore.bond' });
  await app.client().post('/auth/request-link', { email: 'someone@example.com' });
  assert.equal(mailsTo(app.log, 'matter@spore.bond').length, 1);
  assert.equal(mailsTo(app.log, 'someone@example.com').length, 0);
  assert.equal((await app.client().post('/auth/verify', { token: tokenFor(app.log, 'matter@spore.bond') })).status, 200);
});

test('a failed invite leaves the approval standing and says so', async (t) => {
  const app = await startApp(t, ALLOWLIST, { mailer: { send: async () => { throw new Error('mail down'); } } });
  const admin = seedUser(app, { email: 'matter@spore.bond', handle: 'svde' });
  await ask(app, 'new@example.com');
  const id = app.db.prepare('SELECT id FROM access_requests').pluck().get();
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  const res = await admin.client.post(`/api/admin/requests/${id}/approve`);
  assert.equal(res.status, 502);
  assert.match(res.body.error, /approve again/);
  assert.equal(app.db.prepare('SELECT status FROM access_requests').pluck().get(), 'approved');
});
