import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashToken } from '../lib/db.js';
import { createMailer } from '../lib/mail.js';
import { normalizeEmail } from '../lib/auth.js';
import { DOMAIN, startApp, signIn, seedUser, linkFor, tokenFor, mailsTo } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

test('a link redeems once and the second try is 401', async (t) => {
  const app = await startApp(t);
  const client = app.client();

  const sent = await client.post('/auth/request-link', { email: 'alice@example.com' });
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.body, { status: 'sent' });

  const link = linkFor(app.log, 'alice@example.com');
  assert.equal(link.origin, DOMAIN);
  assert.equal(link.pathname, '/auth');
  assert.equal(link.search, '', 'the token rides in the fragment, never the query');
  assert.equal(new URLSearchParams(link.hash.slice(1)).get('email'), 'alice@example.com');

  const token = tokenFor(app.log, 'alice@example.com');
  const first = await client.post('/auth/verify', { token });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { user: { handle: null, email: 'alice@example.com' }, needsHandle: true });

  const second = await app.client().post('/auth/verify', { token });
  assert.equal(second.status, 401);
  assert.equal(second.headers.getSetCookie().length, 0);
});

test('an expired link is 401', async (t) => {
  const app = await startApp(t);
  await app.client().post('/auth/request-link', { email: 'alice@example.com' });
  const token = tokenFor(app.log, 'alice@example.com');

  const row = app.db.prepare('SELECT * FROM login_tokens WHERE token_hash = ?').get(hashToken(token));
  assert.equal(row.expires_at - row.created_at, 15 * 60 * 1000);

  app.db.prepare('UPDATE login_tokens SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1, hashToken(token));
  const res = await app.client().post('/auth/verify', { token });
  assert.equal(res.status, 401);
  assert.equal(app.db.prepare('SELECT count(*) FROM users').pluck().get(), 0);
});

test('a missing or junk token is refused', async (t) => {
  const app = await startApp(t);
  const client = app.client();
  assert.equal((await client.post('/auth/verify', {})).status, 400);
  assert.equal((await client.post('/auth/verify', { token: 42 })).status, 400);
  assert.equal((await client.post('/auth/verify', { token: 'x'.repeat(500) })).status, 400);
  assert.equal((await client.post('/auth/verify', { token: 'not-a-real-token' })).status, 401);
});

test('only hashes of tokens reach the database', async (t) => {
  const app = await startApp(t);
  const client = app.client();
  await client.post('/auth/request-link', { email: 'alice@example.com' });
  const token = tokenFor(app.log, 'alice@example.com');
  await client.post('/auth/verify', { token });
  const sid = client.cookies.get('sid');

  const dump = JSON.stringify([
    app.db.prepare('SELECT * FROM login_tokens').all(),
    app.db.prepare('SELECT * FROM sessions').all(),
  ]);
  assert.ok(!dump.includes(token));
  assert.ok(!dump.includes(sid));
  assert.ok(dump.includes(hashToken(token)));
  assert.ok(dump.includes(hashToken(sid)));
});

test('the session cookie carries the right flags', async (t) => {
  const dev = await startApp(t);
  await dev.client().post('/auth/request-link', { email: 'alice@example.com' });
  const devRes = await dev.client().post('/auth/verify', { token: tokenFor(dev.log, 'alice@example.com') });
  const [devCookie] = devRes.headers.getSetCookie();
  assert.match(devCookie, /^sid=[A-Za-z0-9_-]{43};/);
  assert.match(devCookie, /; Max-Age=2592000;/);
  assert.match(devCookie, /; Path=\//);
  assert.match(devCookie, /; HttpOnly/);
  assert.match(devCookie, /; SameSite=Lax/);
  assert.doesNotMatch(devCookie, /Secure/);

  const session = dev.db.prepare('SELECT * FROM sessions').get();
  assert.equal(session.expires_at - session.created_at, 30 * DAY);

  const prod = await startApp(t, { NODE_ENV: 'production' });
  await prod.client().post('/auth/request-link', { email: 'alice@example.com' });
  const prodRes = await prod.client().post('/auth/verify', { token: tokenFor(prod.log, 'alice@example.com') });
  const [prodCookie] = prodRes.headers.getSetCookie();
  assert.match(prodCookie, /; HttpOnly/);
  assert.match(prodCookie, /; Secure/);
  assert.match(prodCookie, /; SameSite=Lax/);
});

test('logout kills the session', async (t) => {
  const app = await startApp(t);
  const client = await signIn(app, 'alice@example.com');
  const sid = client.cookies.get('sid');
  assert.equal((await client.get('/api/me')).status, 200);

  const out = await client.post('/auth/logout');
  assert.equal(out.status, 204);
  assert.match(out.headers.getSetCookie()[0], /^sid=;.*Expires=Thu, 01 Jan 1970/);
  assert.equal(app.db.prepare('SELECT count(*) FROM sessions').pluck().get(), 0);

  const replay = app.client();
  replay.cookies.set('sid', sid);
  assert.equal((await replay.get('/api/me')).status, 401);
});

test('the handle rules hold', async (t) => {
  const app = await startApp(t);
  const alice = await signIn(app, 'alice@example.com');

  const post = await alice.post('/api/matter', { content: 'hello', public: true });
  assert.equal(post.status, 403, 'no posting before a handle');

  for (const [handle, reason] of [
    ['ab', /3 to 20/],
    ['a'.repeat(21), /3 to 20/],
    ['Alice', /a to z/],
    ['al-ice', /a to z/],
    ['al ice', /a to z/],
    ['ålice', /a to z/],
  ]) {
    const res = await alice.post('/api/me/handle', { handle });
    assert.equal(res.status, 400, handle);
    assert.match(res.body.error, reason, handle);
  }
  for (const handle of ['admin', 'user', 'api', 'settings', 'substrate', 'www']) {
    const res = await alice.post('/api/me/handle', { handle });
    assert.equal(res.status, 400, handle);
    assert.match(res.body.error, /reserved/, handle);
  }
  const slur = await alice.post('/api/me/handle', { handle: 'f4ggot' });
  assert.equal(slur.status, 400);
  assert.match(slur.body.error, /isn't allowed/);
  assert.equal((await alice.post('/api/me/handle', {})).status, 400);

  const picked = await alice.post('/api/me/handle', { handle: '  alice_01  ' });
  assert.equal(picked.status, 200);
  assert.deepEqual(picked.body, { user: { handle: 'alice_01', email: 'alice@example.com' } });

  const again = await alice.post('/api/me/handle', { handle: 'alice_02' });
  assert.equal(again.status, 409, 'a handle is picked once');

  const bob = await signIn(app, 'bob@example.com');
  const taken = await bob.post('/api/me/handle', { handle: 'alice_01' });
  assert.equal(taken.status, 409);
  assert.match(taken.body.error, /taken/);

  assert.equal((await app.client().post('/api/me/handle', { handle: 'nobody' })).status, 401);
  assert.equal((await alice.post('/api/matter', { content: 'hello', public: true })).status, 201);
});

test('the 6th link request inside 15 minutes is 429', async (t) => {
  const app = await startApp(t);
  const client = app.client();
  for (let i = 1; i <= 5; i++) {
    const res = await client.post('/auth/request-link', { email: `user${i}@example.com` });
    assert.equal(res.status, 200, `request ${i}`);
  }
  const sixth = await client.post('/auth/request-link', { email: 'user6@example.com' });
  assert.equal(sixth.status, 429);
  assert.ok(sixth.headers.get('ratelimit-policy'));
  assert.equal(mailsTo(app.log, 'user6@example.com').length, 0);
});

test('one address gets 3 links per 15 minutes, however many ips ask', async (t) => {
  const app = await startApp(t);
  for (let i = 1; i <= 3; i++) {
    assert.equal((await app.client().post('/auth/request-link', { email: 'alice@example.com' })).status, 200);
  }
  assert.equal((await app.client().post('/auth/request-link', { email: ' ALICE@example.com ' })).status, 429);
  assert.equal(mailsTo(app.log, 'alice@example.com').length, 3);
});

test('redeeming is limited to 20 tries per ip per 15 minutes', async (t) => {
  const app = await startApp(t);
  const client = app.client();
  for (let i = 1; i <= 20; i++) {
    assert.equal((await client.post('/auth/verify', { token: `guess-${i}` })).status, 401);
  }
  assert.equal((await client.post('/auth/verify', { token: 'guess-21' })).status, 429);
});

test('bad addresses are refused, good ones are trimmed and lowercased', async (t) => {
  for (const email of ['', 'no-at-sign', 'a@b@c.io', 'a@nodot', 'a b@c.io', '@c.io', 'a@.', `${'x'.repeat(250)}@a.io`, 42, null]) {
    assert.equal(normalizeEmail(email), null, String(email));
  }
  assert.equal(normalizeEmail(`${'x'.repeat(249)}@a.io`), `${'x'.repeat(249)}@a.io`, '254 characters is the limit');
  assert.equal(normalizeEmail('  Alice@Example.COM '), 'alice@example.com');

  const app = await startApp(t);
  for (const email of ['no-at-sign', 'a@b@c.io', 42]) {
    const res = await app.client().post('/auth/request-link', { email });
    assert.equal(res.status, 400, String(email));
  }
  assert.equal((await app.client().post('/auth/request-link', { email: '  Alice@Example.COM ' })).status, 200);
  assert.equal(mailsTo(app.log, 'alice@example.com').length, 1);
});

test('the reply is identical whether or not the address has an account', async (t) => {
  const app = await startApp(t);
  seedUser(app, { email: 'alice@example.com', handle: 'alice' });
  const known = await app.client().post('/auth/request-link', { email: 'alice@example.com' });
  const unknown = await app.client().post('/auth/request-link', { email: 'newcomer@example.com' });
  assert.equal(known.status, unknown.status);
  assert.equal(known.text, unknown.text);
});

test('allowlist and closed modes refuse unknown addresses with the same reply everyone gets', async (t) => {
  const allow = await startApp(t, { SIGNUP_MODE: 'allowlist', SIGNUP_ALLOWLIST: 'Listed@example.com, other@example.com' });
  seedUser(allow, { email: 'member@example.com', handle: 'member' });
  const listed = await allow.client().post('/auth/request-link', { email: 'listed@example.com' });
  const member = await allow.client().post('/auth/request-link', { email: 'member@example.com' });
  const stranger = await allow.client().post('/auth/request-link', { email: 'stranger@example.com' });
  assert.equal(listed.text, stranger.text);
  assert.equal(member.text, stranger.text);
  assert.equal(listed.status, stranger.status);
  assert.equal(mailsTo(allow.log, 'listed@example.com').length, 1);
  assert.equal(mailsTo(allow.log, 'member@example.com').length, 1);
  assert.equal(mailsTo(allow.log, 'stranger@example.com').length, 0);
  assert.equal((await allow.client().post('/auth/verify', { token: tokenFor(allow.log, 'listed@example.com') })).status, 200);

  const closed = await startApp(t, { SIGNUP_MODE: 'closed' });
  seedUser(closed, { email: 'member@example.com', handle: 'member' });
  const known = await closed.client().post('/auth/request-link', { email: 'member@example.com' });
  const unknown = await closed.client().post('/auth/request-link', { email: 'stranger@example.com' });
  assert.equal(known.text, unknown.text);
  assert.equal(known.status, unknown.status);
  assert.equal(mailsTo(closed.log, 'member@example.com').length, 1);
  assert.equal(mailsTo(closed.log, 'stranger@example.com').length, 0);
});

test('a link for an address the signup mode no longer allows is refused at redemption', async (t) => {
  const app = await startApp(t, { SIGNUP_MODE: 'closed' });
  const now = Date.now();
  app.db.prepare('INSERT INTO login_tokens (token_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(hashToken('issued-while-open'), 'stranger@example.com', now + 60_000, now);
  const res = await app.client().post('/auth/verify', { token: 'issued-while-open' });
  assert.equal(res.status, 403);
  assert.equal(app.db.prepare('SELECT count(*) FROM users').pluck().get(), 0);
});

test('a post from a foreign origin is 403', async (t) => {
  const app = await startApp(t);
  const alice = seedUser(app, { email: 'alice@example.com', handle: 'alice' });

  const foreign = await app.client().post('/auth/request-link', { email: 'alice@example.com' }, { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  const missing = await app.client().post('/auth/request-link', { email: 'alice@example.com' }, { origin: null });
  assert.equal(missing.status, 403);
  const lookalike = await app.client().post('/auth/request-link', { email: 'alice@example.com' }, { origin: 'http://spore.test.evil.example' });
  assert.equal(lookalike.status, 403);
  assert.equal(mailsTo(app.log, 'alice@example.com').length, 0);

  const form = await alice.client.post('/api/matter', 'content=hi&public=1', { type: 'application/x-www-form-urlencoded' });
  assert.equal(form.status, 415);
  const plain = await alice.client.post('/api/matter', '{"content":"hi"}', { type: 'text/plain' });
  assert.equal(plain.status, 415);
  const crossDelete = await alice.client.delete('/api/matter/abc', {}, { origin: 'https://evil.example' });
  assert.equal(crossDelete.status, 403);
  const crossLogout = await alice.client.post('/auth/logout', {}, { origin: 'https://evil.example' });
  assert.equal(crossLogout.status, 403);
  assert.equal((await alice.client.get('/api/me')).status, 200, 'the refused logout left the session alone');

  const read = await app.client().get('/api/feed', { origin: 'https://evil.example' });
  assert.equal(read.status, 200, 'reads are not writes');
});

test('a disabled account cannot request links, redeem them, or use a session', async (t) => {
  const app = await startApp(t);
  const alice = await signIn(app, 'alice@example.com', 'alice');
  await app.client().post('/auth/request-link', { email: 'alice@example.com' });
  const pending = tokenFor(app.log, 'alice@example.com');
  const mailsBefore = mailsTo(app.log, 'alice@example.com').length;

  app.db.prepare('UPDATE users SET disabled_at = ? WHERE email = ?').run(Date.now(), 'alice@example.com');

  assert.equal((await alice.get('/api/me')).status, 401);
  assert.equal((await alice.post('/api/matter', { content: 'hi', public: true })).status, 401);

  const ask = await app.client().post('/auth/request-link', { email: 'alice@example.com' });
  assert.deepEqual([ask.status, ask.body], [200, { status: 'sent' }]);
  assert.equal(mailsTo(app.log, 'alice@example.com').length, mailsBefore);

  assert.equal((await app.client().post('/auth/verify', { token: pending })).status, 403);
});

test('a resend error counts as a failure, and the reply says so', async (t) => {
  const refusing = { emails: { send: async () => ({ data: null, error: { message: 'domain not verified' } }) } };
  const mailer = createMailer({ mailTransport: 'resend', fromEmail: 'noreply@spore.test' }, { resend: refusing });
  await assert.rejects(mailer.send({ to: 'alice@example.com', subject: 's', text: 't' }), /domain not verified/);

  const app = await startApp(t, {}, { mailer });
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  const res = await app.client().post('/auth/request-link', { email: 'alice@example.com' });
  assert.equal(res.status, 502);
  assert.match(res.body.error, /couldn't be sent/);
});

test('an unknown mail transport stops startup', () => {
  assert.throws(() => createMailer({ mailTransport: 'carrier-pigeon' }), /console or resend/);
});
