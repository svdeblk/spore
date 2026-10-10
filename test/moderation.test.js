import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seedUser, mailsTo } from './helpers.js';

const ADMIN = { ADMIN_EMAILS: 'matter@spore.bond' };

test('the 11th matter inside a minute is 429, and only for that person', async (t) => {
  const app = await startApp(t);
  const alice = seedUser(app, { email: 'alice@example.com', handle: 'alice' });
  const bob = seedUser(app, { email: 'bob@example.com', handle: 'bob' });
  for (let i = 1; i <= 10; i++) assert.equal((await alice.client.post('/api/matter', { content: `n ${i}` })).status, 201, `post ${i}`);
  const eleventh = await alice.client.post('/api/matter', { content: 'n 11' });
  assert.equal(eleventh.status, 429);
  assert.match(eleventh.body.error, /too many/);
  assert.equal((await bob.client.post('/api/matter', { content: 'mine' })).status, 201);
});

test('bodies cap at 16kb, and bad json answers in json', async (t) => {
  const app = await startApp(t);
  const alice = seedUser(app, { email: 'alice@example.com', handle: 'alice' });
  const big = await alice.client.post('/api/matter', { content: 'x'.repeat(17 * 1024) });
  assert.equal(big.status, 413);
  assert.deepEqual(big.body, { error: 'that\'s too large' });
  const broken = await alice.client.post('/api/matter', '{"content": ');
  assert.equal(broken.status, 400);
  assert.deepEqual(broken.body, { error: 'that isn\'t valid json' });
});

test('unexpected failure answers 500 in json w/ no stack trace', async (t) => {
  const app = await startApp(t);
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  app.db.close();
  const res = await app.client().get('/api/feed');
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'something went wrong' });
  assert.doesNotMatch(res.text, /at .*\.js|Error:/);
});

test('admins can delete any matter, and nobody else can', async (t) => {

  const app = await startApp(t, ADMIN);
  const admin = seedUser(app, { email: 'matter@spore.bond', handle: 'svde' });
  const alice = seedUser(app, { email: 'alice@example.com', handle: 'alice' });
  const bob = seedUser(app, { email: 'bob@example.com', handle: 'bob' });
  const open = (await alice.client.post('/api/matter', { content: 'open', tier: 'public' })).body;
  const hidden = (await alice.client.post('/api/matter', { content: 'hidden', tier: 'private' })).body;

  assert.equal((await bob.client.delete(`/api/matter/${open.id}`)).status, 403);
  assert.equal((await bob.client.delete(`/api/matter/${hidden.id}`)).status, 404);
  assert.equal((await admin.client.delete(`/api/matter/${open.id}`)).status, 204);
  assert.equal((await admin.client.delete(`/api/matter/${hidden.id}`)).status, 204, 'even what the admin cannot see');
  assert.equal(app.db.prepare('SELECT count(*) FROM posts').pluck().get(), 0);
});

test('an admin can disable and enable an account, and nobody else can', async (t) => {
  const app = await startApp(t, ADMIN);
  const admin = seedUser(app, { email: 'matter@spore.bond', handle: 'svde' });
  const alice = seedUser(app, { email: 'alice@example.com', handle: 'alice' });
  const bob = seedUser(app, { email: 'bob@example.com', handle: 'bob' });
  const post = (await alice.client.post('/api/matter', { content: 'hello', tier: 'public' })).body;

  assert.equal((await bob.client.post('/api/admin/users/alice/disable')).status, 403);
  assert.equal((await app.client().post('/api/admin/users/alice/disable')).status, 401);
  assert.equal((await admin.client.post('/api/admin/users/svde/disable')).status, 403, 'admins are not disabled from here');
  assert.equal((await admin.client.post('/api/admin/users/nobody/disable')).status, 404);

  const disabled = await admin.client.post('/api/admin/users/alice/disable');
  assert.deepEqual(disabled.body, { handle: 'alice', disabled: true });
  assert.equal(app.db.prepare('SELECT count(*) FROM sessions WHERE user_id = ?').pluck().get(alice.id), 0);
  assert.equal((await alice.client.get('/api/me')).status, 401);
  assert.equal((await app.client().get(`/api/matter/${post.id}`)).status, 404);
  await app.client().post('/auth/request-link', { email: 'alice@example.com' });
  assert.equal(mailsTo(app.log, 'alice@example.com').length, 0);

  assert.deepEqual((await admin.client.post('/api/admin/users/alice/enable')).body, { handle: 'alice', disabled: false });
  assert.equal((await app.client().get(`/api/matter/${post.id}`)).status, 200);
  assert.equal((await alice.client.get('/api/me')).status, 401, 'enabling does not bring old sessions back');
});

test('rate limits see the visitor behind the tunnel, and a forged entry does not help', async (t) => {
  const app = await startApp(t);
  const from = (chain) => ({ headers: { 'x-forwarded-for': chain } });
  for (let i = 1; i <= 5; i++) {
    const res = await app.client().post('/auth/request-link', { email: `v${i}@example.com` }, from(`6.6.6.${i}, 203.0.113.7`));
    assert.equal(res.status, 200, `request ${i}`);
  }
  const sixth = await app.client().post('/auth/request-link', { email: 'v6@example.com' }, from('1.2.3.4, 203.0.113.7'));
  assert.equal(sixth.status, 429, 'the forged first entry is ignored; the last one is the visitor');
  const elsewhere = await app.client().post('/auth/request-link', { email: 'v7@example.com' }, from('203.0.113.8'));
  assert.equal(elsewhere.status, 200, 'another visitor has their own count');
});
