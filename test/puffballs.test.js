import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seedUser } from './helpers.js';

async function cast(t) {
  const app = await startApp(t);
  const [alice, bob] = ['alice', 'bob'].map((handle) => seedUser(app, { email: `${handle}@example.com`, handle }));
  return { app, alice, bob, anon: app.client() };
}

const set = (user, text) => user.client.request('PUT', '/api/me/puffball', { body: { text } });

test('a puffball is one short line, replaced whenever it is set, and shown on the profile', async (t) => {
  const c = await cast(t);
  assert.equal((await c.anon.get('/api/spore/alice')).body.puffball, null);

  const first = await set(c.alice, '  out in the   woods\nthis week  ');
  assert.equal(first.status, 200);
  assert.equal(first.body.puffball.text, 'out in the woods this week', 'whitespace collapses to single spaces');
  assert.ok(Date.parse(first.body.puffball.set_at) > 0);
  assert.equal((await c.anon.get('/api/spore/alice')).body.puffball.text, 'out in the woods this week');
  assert.equal((await c.alice.client.get('/api/me')).body.user.puffball.text, 'out in the woods this week');

  await set(c.alice, 'back');
  assert.equal((await c.anon.get('/api/spore/alice')).body.puffball.text, 'back', 'one at a time');
  assert.equal(c.app.db.prepare('SELECT count(*) FROM users WHERE puffball_text IS NOT NULL').pluck().get(), 1);

  assert.equal((await c.alice.client.delete('/api/me/puffball')).status, 204);
  assert.equal((await c.anon.get('/api/spore/alice')).body.puffball, null);
  assert.equal((await c.alice.client.get('/api/me')).body.user.puffball, null);
});

test('a puffball keeps to its length and to people with a handle', async (t) => {
  const c = await cast(t);
  assert.equal((await set(c.alice, 'x'.repeat(140))).status, 200);
  assert.equal((await set(c.alice, 'x'.repeat(141))).status, 400);
  assert.equal((await set(c.alice, '🍄'.repeat(140))).status, 200, 'characters, not bytes');
  assert.equal((await set(c.alice, '   ')).status, 400);
  assert.equal((await c.alice.client.request('PUT', '/api/me/puffball', { body: { text: 7 } })).status, 400);
  assert.equal((await set({ client: c.anon }, 'hi')).status, 401);
  const nameless = seedUser(c.app, { email: 'new@example.com' });
  assert.equal((await set(nameless, 'hi')).status, 403);
});

test('a puffball goes where its profile goes, and only its owner changes it', async (t) => {
  const c = await cast(t);
  await set(c.alice, 'for hosts only');
  await c.alice.client.request('PATCH', '/api/me/settings', { body: { profile: 'followers' } });
  const refused = await c.anon.get('/api/spore/alice');
  assert.equal(refused.status, 403);
  assert.equal(JSON.stringify(refused.body).includes('for hosts only'), false, 'a profile you cannot see leaks no status');
  await c.bob.client.request('PUT', '/api/follows/alice');
  assert.equal((await c.bob.client.get('/api/spore/alice')).body.puffball.text, 'for hosts only');

  await set(c.bob, 'bob here');
  assert.equal((await c.bob.client.get('/api/spore/alice')).body.puffball.text, 'for hosts only', 'bob only sets his own');
  const html = await set(c.alice, '<img src=x onerror=alert(1)> & more');
  assert.equal(html.body.puffball.text, '<img src=x onerror=alert(1)> & more', 'stored as text; the page shows text');

  const print = (await c.alice.client.get('/api/me/export')).body;
  assert.equal(print.account.puffball.text, '<img src=x onerror=alert(1)> & more');
  await c.alice.client.delete('/api/me', { confirm: 'alice' });
  assert.equal((await c.anon.get('/api/spore/alice')).status, 404);
});
