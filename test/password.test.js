import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { startApp, signIn } from './helpers.js';

const GOOD = 'correct horse battery';

// sessions older than 15 minutes have to prove the current password
const age = (app) => app.db.prepare('UPDATE sessions SET created_at = ?').run(Date.now() - 16 * 60 * 1000);

test('the real cost hashes and verifies, and its parameters travel with the hash', async () => {
  const started = performance.now();
  const hash = await hashPassword(GOOD);
  const took = performance.now() - started;
  assert.match(hash, /^scrypt\$17\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
  assert.ok(await verifyPassword(GOOD, hash));
  assert.ok(!await verifyPassword('wrong horse battery', hash));
  assert.ok(took < 5000, `one hash took ${Math.round(took)} ms`);

  const cheap = await hashPassword(GOOD, 10);
  assert.ok(await verifyPassword(GOOD, cheap), 'an old cost still verifies after the default changes');
  assert.notEqual(await hashPassword(GOOD, 10), cheap, 'every hash gets its own salt');
});

test('unicode is normalized, so the same password typed two ways matches', async () => {
  const composed = 'café au lait please';
  const decomposed = 'café au lait please';
  assert.ok(await verifyPassword(decomposed, await hashPassword(composed, 10)));
});

test('a password is added after a link sign-in, then signs in on its own', async (t) => {
  const app = await startApp(t);
  const alice = await signIn(app, 'alice@example.com', 'alice');
  assert.equal((await alice.get('/api/me')).body.user.has_password, false);

  assert.equal((await alice.post('/api/me/password', { password: 'short' })).status, 400);
  assert.equal((await alice.post('/api/me/password', { password: 'x'.repeat(257) })).status, 400);
  assert.equal((await alice.post('/api/me/password', { password: GOOD })).status, 204);
  assert.equal((await alice.get('/api/me')).body.user.has_password, true);
  assert.doesNotMatch((await alice.get('/api/me')).text, /scrypt/, 'the hash never leaves the server');

  const fresh = app.client();
  const res = await fresh.post('/auth/password', { email: ' Alice@Example.com ', password: GOOD });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { user: { handle: 'alice', email: 'alice@example.com' }, needsHandle: false });
  assert.match(res.headers.getSetCookie()[0], /^sid=.*HttpOnly/);
  assert.equal((await fresh.get('/api/me')).status, 200);
});

test('wrong password, unknown address, no password and disabled all get the same answer', async (t) => {
  const app = await startApp(t);
  const alice = await signIn(app, 'alice@example.com', 'alice');
  await alice.post('/api/me/password', { password: GOOD });
  await signIn(app, 'nopass@example.com', 'nopass');
  const dora = await signIn(app, 'dora@example.com', 'dora');
  await dora.post('/api/me/password', { password: GOOD });
  app.db.prepare("UPDATE users SET disabled_at = 1 WHERE email = 'dora@example.com'").run();

  const answers = [];
  for (const [email, password] of [['alice@example.com', 'wrong horse battery'], ['nobody@example.com', GOOD],
    ['nopass@example.com', GOOD], ['dora@example.com', GOOD]]) {
    const res = await app.client().post('/auth/password', { email, password });
    answers.push([res.status, res.text]);
    assert.equal(res.headers.getSetCookie().length, 0);
  }
  assert.ok(answers.every((a) => a[0] === 401 && a[1] === answers[0][1]), JSON.stringify(answers));
});

test('an older session has to prove the current password to change or remove it', async (t) => {
  const app = await startApp(t);
  const alice = await signIn(app, 'alice@example.com', 'alice');
  await alice.post('/api/me/password', { password: GOOD });
  age(app);

  assert.equal((await alice.post('/api/me/password', { password: 'another good one' })).status, 403);
  assert.equal((await alice.post('/api/me/password', { password: 'another good one', current: 'nope nope nope' })).status, 403);
  assert.equal((await alice.post('/api/me/password', { password: 'another good one', current: GOOD })).status, 204);
  assert.equal((await app.client().post('/auth/password', { email: 'alice@example.com', password: GOOD })).status, 401);
  assert.equal((await app.client().post('/auth/password', { email: 'alice@example.com', password: 'another good one' })).status, 200);

  age(app);
  assert.equal((await alice.delete('/api/me/password')).status, 403);
  assert.equal((await alice.delete('/api/me/password', { current: 'another good one' })).status, 204);
  assert.equal((await app.client().post('/auth/password', { email: 'alice@example.com', password: 'another good one' })).status, 401);
});

test('a forgotten password resets by signing in with a link, and a new password signs out other sessions', async (t) => {
  const app = await startApp(t);
  const laptop = await signIn(app, 'alice@example.com', 'alice');
  await laptop.post('/api/me/password', { password: GOOD });
  const phone = app.client();
  await phone.post('/auth/password', { email: 'alice@example.com', password: GOOD });
  age(app);

  const relinked = await signIn(app, 'alice@example.com');
  assert.equal((await relinked.post('/api/me/password', { password: 'brand new passphrase' })).status, 204, 'a fresh link session needs no current password');
  assert.equal((await relinked.get('/api/me')).status, 200, 'the session that changed it stays');
  assert.equal((await laptop.get('/api/me')).status, 401);
  assert.equal((await phone.get('/api/me')).status, 401);
});

test('password sign-in is limited to 5 attempts per address per 15 minutes', async (t) => {
  const app = await startApp(t);
  for (let i = 1; i <= 5; i++) {
    assert.equal((await app.client().post('/auth/password', { email: 'alice@example.com', password: `guess ${i} guess` })).status, 401);
  }
  assert.equal((await app.client().post('/auth/password', { email: 'alice@example.com', password: 'guess 6 guess' })).status, 429);
});
