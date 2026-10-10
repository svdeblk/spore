import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seedUser, signIn } from './helpers.js';

test('every page url serves the page, and unknown api and auth paths are json 404s', async (t) => {
  const app = await startApp(t);
  const client = app.client();
  for (const path of ['/', '/auth', '/archive', '/bin', '/morel', '/substrate', '/settings', '/privacy', '/about', '/terms', '/contact', '/thread/a1b2c3d4e5f6a1b2c3d4e5f6', '/@alice']) {
    const res = await client.get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), /text\/html/, path);
    assert.match(res.text, /<html/i, path);
    // the pg's policy; never api or /auth would block the page's own script
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/, path);
  }
  for (const path of ['/api/nope', '/api/matter', '/auth/nope', '/api/me/nothing']) {
    const res = await client.get(path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(res.body, { error: 'not found' }, path);
  }
  assert.equal((await client.get('/wp-admin')).status, 404);
  assert.equal((await client.post('/api/nope', {})).status, 404);
});

test('health and config answer', async (t) => {
  const app = await startApp(t, { SIGNUP_MODE: 'allowlist', MAX_POST_CHARS: '500' });
  assert.deepEqual((await app.client().get('/healthz')).body, { ok: true });
  assert.deepEqual((await app.client().get('/api/config')).body, {
    signupMode: 'allowlist',
    maxPostChars: 500,
    maxMorelChars: 20000,
    puffballChars: 140,
    tiers: ['public', 'followers', 'friends', 'private'],
    signIn: ['link', 'password'],
  });
  app.db.close();
  assert.equal((await app.client().get('/healthz')).status, 503, 'a dead database is not healthy');
});

test('a profile answers with its handle, join date and public matter, paginated', async (t) => {
  const app = await startApp(t);
  const alice = seedUser(app, { email: 'alice@example.com', handle: 'alice' });
  for (let i = 0; i < 3; i++) await alice.client.post('/api/matter', { content: `note ${i}`, tier: 'public' });
  await alice.client.post('/api/matter', { content: 'secret', tier: 'private' });

  const res = await app.client().get('/api/spore/alice?limit=2');
  assert.equal(res.status, 200);
  assert.equal(res.body.handle, 'alice');
  assert.match(res.body.joined, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.deepEqual(res.body.posts.map((p) => p.content), ['note 2', 'note 1']);
  assert.deepEqual((await app.client().get('/api/spore/alice?offset=2')).body.posts.map((p) => p.content), ['note 0']);
});

test('the export is a download holding every matter, private ones and replies included', async (t) => {
  const app = await startApp(t);
  const alice = seedUser(app, { email: 'alice@example.com', handle: 'alice' });
  const bob = seedUser(app, { email: 'bob@example.com', handle: 'bob' });
  await alice.client.post('/api/matter', { content: 'open', tier: 'public' });
  await alice.client.post('/api/matter', { content: 'just me', tier: 'private' });
  const bobs = (await bob.client.post('/api/matter', { content: 'bob here', tier: 'public' })).body;
  await alice.client.post('/api/matter', { content: 'a reply', parent_id: bobs.id });
  await alice.client.request('PUT', '/api/follows/bob');

  const res = await alice.client.get('/api/me/export');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="spore-print-alice\.json"/);
  assert.equal(res.body.account.handle, 'alice');
  assert.equal(res.body.account.email, 'alice@example.com');
  assert.deepEqual(res.body.matter.map((m) => [m.content, m.tier]), [['open', 'public'], ['just me', 'private'], ['a reply', 'public']]);
  assert.deepEqual(res.body.following, ['bob']);
  assert.doesNotMatch(res.text, /bob@example\.com|bob here/, "someone else's address and matter stay out");
  assert.equal((await app.client().get('/api/me/export')).status, 401);
});

test('deleting an account takes everything with it, and the address can start over', async (t) => {
  const app = await startApp(t);
  const alice = await signIn(app, 'alice@example.com', 'alice');
  const bob = seedUser(app, { email: 'bob@example.com', handle: 'bob' });
  const root = (await alice.post('/api/matter', { content: 'mine', tier: 'public' })).body;
  await bob.client.post('/api/matter', { content: 'bob replies', parent_id: root.id });
  const bobRoot = (await bob.client.post('/api/matter', { content: 'bob root', tier: 'public' })).body;
  await alice.post('/api/matter', { content: 'alice replies', parent_id: bobRoot.id });
  await alice.request('PUT', '/api/friends/bob');

  assert.equal((await alice.delete('/api/me', { confirm: 'wrong' })).status, 400);
  assert.equal((await alice.delete('/api/me', {}, { origin: 'https://evil.example' })).status, 403);

  const gone = await alice.delete('/api/me', { confirm: 'alice' });
  assert.equal(gone.status, 204);
  assert.match(gone.headers.getSetCookie()[0], /^sid=;/);
  assert.equal((await alice.get('/api/me')).status, 401);
  assert.equal((await app.client().get('/api/spore/alice')).status, 404);

  const count = (sql) => app.db.prepare(sql).pluck().get();
  assert.equal(count("SELECT count(*) FROM users WHERE email = 'alice@example.com'"), 0);
  assert.equal(count('SELECT count(*) FROM sessions'), 1, "only bob's session is left");
  assert.equal(count("SELECT count(*) FROM login_tokens WHERE email = 'alice@example.com'"), 0);
  assert.equal(count('SELECT count(*) FROM friends'), 0);
  assert.deepEqual(app.db.prepare('SELECT content FROM posts ORDER BY content').pluck().all(), ['bob root'],
    'her matter, the replies under it, and her replies elsewhere are all gone');

  const again = await signIn(app, 'alice@example.com');
  const me = (await again.get('/api/me')).body.user;
  assert.equal(me.handle, null, 'a new account, no handle yet');
  assert.equal((await again.post('/api/me/handle', { handle: 'alice' })).status, 200, 'and the old handle is free');
});

test('an account without a handle confirms deletion with its address', async (t) => {
  const app = await startApp(t);
  const nameless = await signIn(app, 'new@example.com');
  assert.equal((await nameless.delete('/api/me', { confirm: 'null' })).status, 400);
  assert.equal((await nameless.delete('/api/me', { confirm: 'new@example.com' })).status, 204);
});
