import { test } from 'node:test';
import assert from 'node:assert/strict';
import { excerpt } from '../lib/parser.js';
import { startApp, seedUser } from './helpers.js';

async function cast(t, env) {
  const app = await startApp(t, env);
  const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((handle) => seedUser(app, { email: `${handle}@example.com`, handle }));
  await bob.client.request('PUT', '/api/follows/alice');
  return { app, alice, bob, carol, anon: app.client() };
}

const morel = (user, extra = {}) => user.client.post('/api/morels', { title: 'on moss', content: 'a *long* thought about moss.\n\nand more of it.', ...extra });
const ids = (res) => res.body.posts.map((p) => p.id);

test('a morel keeps to its limits and needs a title', async (t) => {
  const c = await cast(t, { MAX_MOREL_CHARS: '30' });
  assert.equal((await morel(c.alice, { title: '   ' })).status, 400);
  assert.equal((await morel(c.alice, { title: 'x'.repeat(121) })).status, 400);
  assert.equal((await morel(c.alice, { content: '  ' })).status, 400);
  assert.equal((await morel(c.alice, { content: 'x'.repeat(31) })).status, 400);
  assert.equal((await morel(c.alice, { content: 'x'.repeat(30) })).status, 201);
  assert.equal((await morel(c.alice, { tier: 'secret' })).status, 400);
  assert.equal((await morel(c.alice, { share: 'yes' })).status, 400);
  assert.equal((await c.anon.post('/api/morels', { title: 't', content: 'c' })).status, 401);
  const nameless = seedUser(c.app, { email: 'new@example.com' });
  assert.equal((await morel(nameless)).status, 403, 'a handle comes first');
  // chars not bytes: emoji = 1; body cap leaves room for 20000 of them
  const big = await startApp(t);
  const dora = seedUser(big, { email: 'dora@example.com', handle: 'dora' });
  assert.equal((await dora.client.post('/api/morels', { title: 'long', content: '🍄'.repeat(20000) })).status, 201);
  assert.equal((await dora.client.post('/api/morels', { title: 'long', content: '🍄'.repeat(20001) })).status, 400);
  assert.equal((await dora.client.post('/api/matter', { content: 'x'.repeat(20000) })).status, 413, 'other routes keep the small cap');
});

test('a morel is a card in lists and whole on its own page, and goes to the feeds only when shared', async (t) => {
  const c = await cast(t);
  const kept = (await morel(c.alice)).body;
  assert.equal(kept.kind, 'morel');
  assert.equal(kept.title, 'on moss');
  assert.equal(kept.shared, false);
  assert.equal(kept.excerpt, 'a long thought about moss. and more of it.');
  assert.equal(kept.html, undefined, 'a card carries no body');
  assert.equal(kept.content, undefined);

  const shared = (await morel(c.alice, { title: 'shared one', share: true })).body;
  assert.equal(shared.shared, true);

  for (const [name, client] of [['anon', c.anon], ['bob', c.bob.client]]) {
    assert.deepEqual(ids(await client.get('/api/feed')), [shared.id], `${name}: the feed holds the shared card only`);
    assert.deepEqual(ids(await client.get('/api/spore/alice')).sort(), [kept.id, shared.id].sort(), `${name}: the profile holds both`);
  }
  assert.deepEqual(ids(await c.bob.client.get('/api/substrate')), [shared.id]);
  assert.deepEqual(ids(await c.alice.client.get('/api/substrate')), [shared.id], 'your own substrate too');
  assert.deepEqual(ids(await c.carol.client.get('/api/substrate')), [], 'a stranger who does not follow sees none');

  const whole = (await c.anon.get(`/api/thread/${kept.id}`)).body.root;
  assert.equal(whole.html, '<p>a <b>long</b> thought about moss.</p>\n<p>and more of it.</p>');
  assert.equal(whole.content.startsWith('a *long*'), true);
  assert.equal((await c.anon.get(`/api/matter/${kept.id}`)).body.title, 'on moss');
});

test('sharing is the author\'s alone, and can be taken back', async (t) => {
  const c = await cast(t);
  const post = (await morel(c.alice)).body;
  assert.deepEqual(ids(await c.anon.get('/api/feed')), []);

  const on = await c.alice.client.request('PATCH', `/api/morels/${post.id}`, { body: { shared: true } });
  assert.equal(on.status, 200);
  assert.equal(on.body.shared, true);
  assert.deepEqual(ids(await c.anon.get('/api/feed')), [post.id]);
  assert.equal((await c.alice.client.request('PATCH', `/api/morels/${post.id}`, { body: { shared: false } })).status, 200);
  assert.deepEqual(ids(await c.anon.get('/api/feed')), []);

  assert.equal((await c.bob.client.request('PATCH', `/api/morels/${post.id}`, { body: { shared: true } })).status, 403);
  assert.equal((await c.anon.request('PATCH', `/api/morels/${post.id}`, { body: { shared: true } })).status, 401);
  assert.equal((await c.alice.client.request('PATCH', `/api/morels/${post.id}`, { body: { shared: 'on' } })).status, 400);
  assert.equal((await c.alice.client.request('PATCH', '/api/morels/ffffffffffffffffffffffff', { body: { shared: true } })).status, 404);
  const matter = (await c.alice.client.post('/api/matter', { content: 'plain matter' })).body;
  assert.equal((await c.alice.client.request('PATCH', `/api/morels/${matter.id}`, { body: { shared: true } })).status, 404, 'matter is not a morel');
});

test('tiers hold for morels, shared or not, and germinations work under them', async (t) => {
  const c = await cast(t);
  const hidden = (await morel(c.alice, { tier: 'private', share: true })).body;
  for (const client of [c.anon, c.bob.client]) {
    assert.deepEqual(ids(await client.get('/api/feed')), []);
    assert.equal((await client.get(`/api/thread/${hidden.id}`)).status, 404);
  }
  assert.deepEqual(ids(await c.alice.client.get('/api/spore/alice')), [hidden.id]);

  const open = (await morel(c.alice)).body;
  const reply = await c.bob.client.post('/api/matter', { content: 'germinating on a morel', parent_id: open.id });
  assert.equal(reply.status, 201);
  assert.equal((await c.anon.get(`/api/thread/${open.id}`)).body.replies.length, 1);
  assert.equal((await c.anon.get('/api/spore/alice')).body.posts[0].replies, 1);
});

test('a morel decays and decomposes like matter, and the spore print keeps it', async (t) => {
  const c = await cast(t);
  const post = (await morel(c.alice, { share: true })).body;
  assert.equal((await c.alice.client.post(`/api/matter/${post.id}/archive`)).status, 200);
  assert.deepEqual(ids(await c.anon.get('/api/feed')), []);
  const listed = (await c.alice.client.get('/api/me/archive')).body.posts[0];
  assert.equal(listed.kind, 'morel');
  assert.equal(listed.title, 'on moss');
  assert.equal((await c.alice.client.post(`/api/matter/${post.id}/restore`)).status, 200);
  assert.deepEqual(ids(await c.anon.get('/api/feed')), [post.id]);

  const print = (await c.alice.client.get('/api/me/export')).body;
  const entry = print.matter.find((m) => m.id === post.id);
  assert.equal(entry.kind, 'morel');
  assert.equal(entry.title, 'on moss');
  assert.equal(entry.shared, true);
  assert.equal(entry.content.startsWith('a *long*'), true);
  const plain = (await c.alice.client.post('/api/matter', { content: 'plain' })).body;
  const plainEntry = (await c.alice.client.get('/api/me/export')).body.matter.find((m) => m.id === plain.id);
  assert.equal(plainEntry.kind, 'matter');
  assert.equal('title' in plainEntry, false);
});

test('an excerpt is plain text: no markup, no entities, cut at a word, nothing that can run', () => {
  assert.equal(excerpt('*bold* and ~slanted~ with `code` and [[alice]]'), 'bold and slanted with code and @alice');
  assert.equal(excerpt('5 < 6 & "quotes" \'single\''), '5 < 6 & "quotes" \'single\'');
  assert.equal(excerpt('<script>alert(1)</script> hi'), '<script>alert(1)</script> hi', 'tags in the text stay text, for the page to show as text');
  assert.equal(excerpt('one\n\n\ntwo\tthree'), 'one two three');
  const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
  const cut = excerpt(words);
  assert.ok(cut.endsWith('...'));
  assert.ok([...cut].length <= 283);
  assert.equal(cut.slice(0, -3).split(' ').every((w) => /^word\d+$/.test(w)), true, 'it never cuts a word in half');
  assert.equal(excerpt('🍄'.repeat(400)).length > 0, true);
});
