import { test } from 'node:test';
import assert from 'node:assert/strict';
import { purgeExpired } from '../lib/db.js';
import { startApp, seedUser } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

async function cast(t) {
  const app = await startApp(t, { ADMIN_EMAILS: 'admin@example.com' });
  const [alice, bob, admin] = ['alice', 'bob', 'admin'].map((handle) => seedUser(app, { email: `${handle}@example.com`, handle }));
  await bob.client.request('PUT', '/api/follows/alice');
  return { app, alice, bob, admin, anon: app.client() };
}

async function write(user, content, extra = {}) {
  const res = await user.client.post('/api/matter', { content, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

// all places matter can show up as each viewer sees it
async function placesShowing(c, id) {
  const found = [];
  for (const [name, client] of [['anon', c.anon], ['bob', c.bob.client], ['alice', c.alice.client]]) {
    if ((await client.get(`/api/matter/${id}`)).status === 200) found.push(`${name} matter`);
    if ((await client.get(`/api/thread/${id}`)).status === 200) found.push(`${name} thread`);
    if ((await client.get('/api/feed')).body.posts.some((p) => p.id === id)) found.push(`${name} feed`);
    if ((await client.get('/api/spore/alice')).body.posts.some((p) => p.id === id)) found.push(`${name} profile`);
    if (name !== 'anon' && (await client.get('/api/substrate')).body.posts.some((p) => p.id === id)) found.push(`${name} substrate`);
  }
  return found;
}

for (const [move, list] of [['archive', 'archive'], ['bin', 'bin']]) {
  test(`${move} takes matter and its germinations out of every view, its author's too, and restore brings them back`, async (t) => {
    const c = await cast(t);
    const post = await write(c.alice, 'here for now');
    const reply = await write(c.bob, 'a germination', { parent_id: post.id });
    const everywhere = await placesShowing(c, post.id);
    assert.equal(everywhere.length, 14);

    const moved = await c.alice.client.post(`/api/matter/${post.id}/${move}`);
    assert.equal(moved.status, 200);
    assert.ok(moved.body[move === 'archive' ? 'archived_at' : 'binned_at']);
    assert.deepEqual(await placesShowing(c, post.id), []);
    assert.equal((await c.bob.client.get(`/api/matter/${reply.id}`)).status, 404, 'its germination goes with it');
    assert.equal((await c.bob.client.post('/api/matter', { content: 'late', parent_id: post.id })).status, 404, 'it takes no new germinations');

    const listed = await c.alice.client.get(`/api/me/${list}`);
    assert.deepEqual(listed.body.posts.map((p) => p.id), [post.id]);
    assert.equal(listed.body.posts[0].html, '<p>here for now</p>');
    assert.deepEqual((await c.bob.client.get(`/api/me/${list}`)).body.posts, [], "nobody sees anyone else's");

    assert.equal((await c.alice.client.post(`/api/matter/${post.id}/restore`)).status, 200);
    assert.deepEqual(await placesShowing(c, post.id), everywhere);
    assert.equal((await c.anon.get(`/api/thread/${post.id}`)).body.replies[0].id, reply.id);
    assert.deepEqual((await c.alice.client.get(`/api/me/${list}`)).body.posts, []);
  });
}

test('a germination can go on its own. the count under its root follows', async (t) => {
  const c = await cast(t);
  const post = await write(c.alice, 'root');
  const reply = await write(c.bob, 'mine to keep', { parent_id: post.id });
  assert.equal((await c.bob.client.post(`/api/matter/${reply.id}/archive`)).status, 200);
  const thread = (await c.anon.get(`/api/thread/${post.id}`)).body;
  assert.deepEqual(thread.replies, []);
  assert.equal(thread.root.replies, 0);
  assert.equal((await c.bob.client.get('/api/me/archive')).body.posts[0].parent_id, post.id);
});

test("only the author moves matter: not the root's author, not an admin, not a stranger, no one else", async (t) => {
  const c = await cast(t);
  const post = await write(c.alice, 'root');
  const reply = await write(c.bob, 'a germination', { parent_id: post.id });
  const hidden = await write(c.alice, 'private', { tier: 'private' });
  for (const action of ['archive', 'bin', 'restore']) {
    assert.equal((await c.alice.client.post(`/api/matter/${reply.id}/${action}`)).status, 403, `root author ${action}`);
    assert.equal((await c.admin.client.post(`/api/matter/${post.id}/${action}`)).status, 403, `admin ${action}`);
    assert.equal((await c.bob.client.post(`/api/matter/${hidden.id}/${action}`)).status, 404, `${action} of unseen matter`);
    assert.equal((await c.anon.post(`/api/matter/${post.id}/${action}`)).status, 401);
    assert.equal((await c.bob.client.post(`/api/matter/ffffffffffffffffffffffff/${action}`)).status, 404);
  }
  // rot still works on matter out of view
  await c.alice.client.post(`/api/matter/${post.id}/bin`);
  assert.equal((await c.alice.client.delete(`/api/matter/${post.id}`)).status, 204);
  assert.deepEqual((await c.alice.client.get('/api/me/bin')).body.posts, []);
});

test('matter is in the archive or the bin, never both. it moves between them', async (t) => {
  const c = await cast(t);
  const post = await write(c.alice, 'moving');
  await c.alice.client.post(`/api/matter/${post.id}/archive`);
  const binned = (await c.alice.client.post(`/api/matter/${post.id}/bin`)).body;
  assert.equal(binned.archived_at, null);
  assert.ok(binned.binned_at);
  assert.deepEqual((await c.alice.client.get('/api/me/archive')).body.posts, []);
  assert.throws(() => c.app.db.prepare('UPDATE posts SET archived_at = 1, binned_at = 1').run(), /CHECK/);
});

test('the bin empties itself after the chosen days, or never, and can be emptied by hand', async (t) => {
  const c = await cast(t);
  const now = Date.now();
  const binAt = async (user, ageDays) => {
    const post = await write(user, `binned ${ageDays} days ago`);
    await user.client.post(`/api/matter/${post.id}/bin`);
    c.app.db.prepare('UPDATE posts SET binned_at = ? WHERE id = ?').run(now - ageDays * DAY, post.id);
    return post.id;
  };

  const me = (user) => user.client.get('/api/me').then((res) => res.body.user.settings.bin_days);
  assert.equal(await me(c.alice), 30, 'thirty days unless changed');
  const fresh = await binAt(c.alice, 29);
  const old = await binAt(c.alice, 30);
  assert.equal((await c.alice.client.get('/api/me/bin')).body.posts.find((p) => p.id === fresh).gone_at, new Date(now + DAY).toISOString());

  assert.equal(purgeExpired(c.app.db, now).binned, 1);
  assert.deepEqual((await c.alice.client.get('/api/me/bin')).body.posts.map((p) => p.id), [fresh]);
  assert.equal(c.app.db.prepare('SELECT count(*) FROM posts WHERE id = ?').pluck().get(old), 0);

  // shorter setting applies to what's already there
  assert.equal((await c.alice.client.request('PATCH', '/api/me/settings', { body: { bin_days: 7 } })).status, 200);
  assert.equal(purgeExpired(c.app.db, now).binned, 1);

  // never keeps it until emptied
  assert.equal((await c.bob.client.request('PATCH', '/api/me/settings', { body: { bin_days: null } })).status, 200);
  assert.equal(await me(c.bob), null);
  const kept = await binAt(c.bob, 3650);
  assert.equal((await c.bob.client.get('/api/me/bin')).body.posts[0].gone_at, null);
  assert.equal(purgeExpired(c.app.db, now).binned, 0);
  const shown = await write(c.bob, 'not in the bin');

  const emptied = await c.bob.client.delete('/api/me/bin');
  assert.deepEqual(emptied.body, { removed: 1 });
  assert.equal(c.app.db.prepare('SELECT count(*) FROM posts WHERE id = ?').pluck().get(kept), 0);
  assert.equal((await c.anon.get(`/api/matter/${shown.id}`)).status, 200, 'emptying leaves everything else');

  for (const bad of [0, 5, '7', 31, 'never']) {
    assert.equal((await c.bob.client.request('PATCH', '/api/me/settings', { body: { bin_days: bad } })).status, 400, `bin_days ${bad}`);
  }
});

test('a spore print holds archived & binned matter and is marked as such', async (t) => {
  const c = await cast(t);
  const kept = await write(c.alice, 'kept');
  const archived = await write(c.alice, 'archived');
  const binned = await write(c.alice, 'binned');
  await c.alice.client.post(`/api/matter/${archived.id}/archive`);
  await c.alice.client.post(`/api/matter/${binned.id}/bin`);
  const print = (await c.alice.client.get('/api/me/export')).body;
  const byId = Object.fromEntries(print.matter.map((m) => [m.id, m]));
  assert.equal(byId[kept.id].archived_at, null);
  assert.equal(byId[kept.id].binned_at, null);
  assert.ok(byId[archived.id].archived_at);
  assert.ok(byId[binned.id].binned_at);
  assert.equal(print.account.settings.bin_days, 30);
});
