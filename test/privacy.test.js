import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seedUser } from './helpers.js';

// alice has one of each relation: bob follows her, carol is her friend, dave is blocked, erin is a stranger
async function cast(t, env) {
  const app = await startApp(t, env);
  const [alice, bob, carol, dave, erin] = ['alice', 'bob', 'carol', 'dave', 'erin']
    .map((handle) => seedUser(app, { email: `${handle}@example.com`, handle }));
  await bob.client.request('PUT', '/api/follows/alice');
  await carol.client.request('PUT', '/api/friends/alice');
  await alice.client.request('PUT', '/api/friends/carol');
  await alice.client.request('PUT', '/api/blocks/dave');
  return { app, alice, bob, carol, dave, erin, anon: app.client() };
}

async function write(user, content, extra = {}) {
  const res = await user.client.post('/api/matter', { content, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const seen = async (client, id) => (await client.get(`/api/matter/${id}`)).status === 200;

test('each tier reaches exactly the right viewers', async (t) => {
  const c = await cast(t);
  const expected = {
    public: { anon: true, erin: true, bob: true, carol: true, dave: false, alice: true },
    followers: { anon: false, erin: false, bob: true, carol: true, dave: false, alice: true },
    friends: { anon: false, erin: false, bob: false, carol: true, dave: false, alice: true },
    private: { anon: false, erin: false, bob: false, carol: false, dave: false, alice: true },
  };
  for (const [tier, viewers] of Object.entries(expected)) {
    const post = await write(c.alice, `a ${tier} matter`, { tier });
    assert.equal(post.tier, tier);
    for (const [name, visible] of Object.entries(viewers)) {
      const client = name === 'anon' ? c.anon : c[name].client;
      assert.equal(await seen(client, post.id), visible, `${tier} matter seen by ${name}`);
    }
  }
});

test('the profile tier is a ceiling on every matter, and a private profile turns everyone away', async (t) => {
  const c = await cast(t);
  const post = await write(c.alice, 'public matter', { tier: 'public' });

  await c.alice.client.request('PATCH', '/api/me/settings', { body: { profile: 'friends' } });
  assert.equal(await seen(c.anon, post.id), false);
  assert.equal(await seen(c.bob.client, post.id), false, 'a follower is not a friend');
  assert.equal(await seen(c.carol.client, post.id), true);
  const forBob = await c.bob.client.get('/api/spore/alice');
  assert.equal(forBob.status, 403);
  assert.equal(forBob.body.visibility, 'friends');
  assert.equal(forBob.body.relation.following, true);

  await c.alice.client.request('PATCH', '/api/me/settings', { body: { profile: 'private' } });
  for (const client of [c.anon, c.bob.client, c.carol.client, c.erin.client]) {
    assert.equal(await seen(client, post.id), false);
    const res = await client.get('/api/spore/alice');
    assert.equal(res.status, 403);
    assert.match(res.body.error, /isn't accepting views right now/);
    assert.equal(res.body.posts, undefined);
  }
  assert.equal(await seen(c.alice.client, post.id), true, 'the owner always sees their own matter');
  assert.equal((await c.alice.client.get('/api/spore/alice')).status, 200);
  assert.equal((await c.anon.get('/api/feed')).body.posts.length, 0);
});

test('no response outside /api/me carries an address unless its email tier allows it', async (t) => {
  const c = await cast(t);
  const root = await write(c.alice, 'hello', { tier: 'public' });
  await write(c.bob, 'hi back', { parent_id: root.id });
  await write(c.carol, 'friends thing', { tier: 'friends' });

  const addresses = /@example\.com/;
  for (const [name, client] of [['anon', c.anon], ['alice', c.alice.client], ['bob', c.bob.client], ['carol', c.carol.client], ['erin', c.erin.client]]) {
    const profiles = ['alice', 'bob', 'carol'].filter((handle) => handle !== name).map((handle) => `/api/spore/${handle}`);
    for (const path of ['/api/feed', `/api/thread/${root.id}`, `/api/matter/${root.id}`, ...profiles]) {
      const res = await client.get(path);
      assert.doesNotMatch(res.text, addresses, `${name} ${path}`);
    }
  }
  assert.doesNotMatch((await c.bob.client.get('/api/substrate')).text, addresses);
  assert.doesNotMatch((await c.alice.client.get('/api/me/relations')).text, addresses);
  assert.match((await c.alice.client.get('/api/me')).text, /alice@example\.com/);
  assert.doesNotMatch((await c.alice.client.get('/api/me')).text, /bob@|carol@/);
});

test('an email shows only to the tier its owner picks, and defaults to private', async (t) => {
  const c = await cast(t);
  assert.equal((await c.alice.client.get('/api/me')).body.user.settings.email, 'private');
  assert.equal((await c.carol.client.get('/api/spore/alice')).body.email, undefined);
  assert.equal((await c.alice.client.get('/api/spore/alice')).body.email, 'alice@example.com');

  await c.alice.client.request('PATCH', '/api/me/settings', { body: { email: 'friends' } });
  assert.equal((await c.carol.client.get('/api/spore/alice')).body.email, 'alice@example.com');
  assert.equal((await c.bob.client.get('/api/spore/alice')).body.email, undefined);

  await c.alice.client.request('PATCH', '/api/me/settings', { body: { email: 'public' } });
  assert.equal((await c.anon.get('/api/spore/alice')).body.email, 'alice@example.com');
  assert.equal((await c.dave.client.get('/api/spore/alice')).status, 404, 'a block outranks a public email');
});

test('the feed holds only public roots, and the substrate holds what you follow and your friends', async (t) => {
  const c = await cast(t);
  const open = await write(c.alice, 'open', { tier: 'public' });
  await write(c.alice, 'for followers', { tier: 'followers' });
  await write(c.carol, 'carol for friends', { tier: 'friends' });
  await write(c.erin, 'erin public', { tier: 'public' });
  await write(c.bob, 'a reply', { parent_id: open.id });

  const feed = (await c.anon.get('/api/feed')).body.posts.map((p) => p.content);
  assert.deepEqual(feed.sort(), ['erin public', 'open']);
  const feedPost = (await c.anon.get('/api/feed')).body.posts.find((p) => p.id === open.id);
  assert.deepEqual(feedPost.author, { handle: 'alice' });
  assert.equal(feedPost.replies, 1);

  assert.deepEqual((await c.bob.client.get('/api/substrate')).body.posts.map((p) => p.content).sort(), ['for followers', 'open']);
  assert.deepEqual((await c.alice.client.get('/api/substrate')).body.posts.map((p) => p.content).sort(), ['carol for friends', 'for followers', 'open']);
  assert.deepEqual((await c.erin.client.get('/api/substrate')).body.posts.map((p) => p.content), ['erin public']);
  assert.equal((await c.anon.get('/api/substrate')).status, 401);
  assert.ok(!(await c.dave.client.get('/api/feed')).body.posts.some((p) => p.author.handle === 'alice'), 'blocked people vanish from the feed');
});

test('replies live where their root lives', async (t) => {
  const c = await cast(t);
  const friendsOnly = await write(c.alice, 'friends only', { tier: 'friends' });
  const open = await write(c.alice, 'open', { tier: 'public' });

  assert.equal((await c.bob.client.post('/api/matter', { content: 'let me in', parent_id: friendsOnly.id })).status, 404);
  const reply = await write(c.carol, 'from a friend', { parent_id: friendsOnly.id, tier: 'public' });
  assert.equal(reply.tier, 'public', 'a reply stores no tier of its own');
  assert.equal(await seen(c.carol.client, reply.id), true);
  assert.equal(await seen(c.bob.client, reply.id), false, 'the reply hides with its root');
  assert.equal(await seen(c.anon, reply.id), false);

  const nested = await c.bob.client.post('/api/matter', { content: 'reply to a reply', parent_id: reply.id });
  assert.equal(nested.status, 404, 'one level of replies');
  assert.equal((await c.dave.client.post('/api/matter', { content: 'hi', parent_id: open.id })).status, 404, 'blocked people cannot reply');
  assert.equal((await c.erin.client.post('/api/matter', { content: 'x', parent_id: 'a'.repeat(24) })).status, 404);

  const thread = (await c.carol.client.get(`/api/thread/${friendsOnly.id}`)).body;
  assert.deepEqual(thread.replies.map((r) => r.content), ['from a friend']);
  assert.equal((await c.bob.client.get(`/api/thread/${friendsOnly.id}`)).status, 404);
  assert.equal((await c.carol.client.get(`/api/thread/${reply.id}`)).status, 404, 'threads start at a root');
});

test('another viewer never sees replies they are not allowed to', async (t) => {
  const c = await cast(t);
  const open = await write(c.alice, 'open', { tier: 'public' });
  await write(c.erin, 'erin replies', { parent_id: open.id });
  await c.erin.client.request('PATCH', '/api/me/settings', { body: { profile: 'private' } });

  assert.deepEqual((await c.bob.client.get(`/api/thread/${open.id}`)).body.replies, [], "a private account's replies hide too");
  assert.equal((await c.bob.client.get(`/api/thread/${open.id}`)).body.root.replies, 0);
  assert.equal((await c.erin.client.get(`/api/thread/${open.id}`)).body.replies.length, 1, 'but not from their author');
});

test('a root author can clear replies, including from someone they later blocked', async (t) => {
  const c = await cast(t);
  const open = await write(c.alice, 'open', { tier: 'public' });
  const fromErin = await write(c.erin, 'erin replies', { parent_id: open.id });
  const fromBob = await write(c.bob, 'bob replies', { parent_id: open.id });

  assert.equal((await c.bob.client.delete(`/api/matter/${fromErin.id}`)).status, 403);
  assert.equal((await c.erin.client.delete(`/api/matter/${open.id}`)).status, 403);
  assert.equal((await c.dave.client.delete(`/api/matter/${open.id}`)).status, 404);

  await c.alice.client.request('PUT', '/api/blocks/erin');
  assert.equal(await seen(c.alice.client, fromErin.id), false);
  assert.equal((await c.alice.client.delete(`/api/matter/${fromErin.id}`)).status, 204);
  assert.equal((await c.bob.client.delete(`/api/matter/${fromBob.id}`)).status, 204, 'and authors clear their own');
  assert.equal((await c.alice.client.get(`/api/thread/${open.id}`)).body.replies.length, 0);
});

test('a block cuts every tie and hides both people from each other', async (t) => {
  const c = await cast(t);
  await c.erin.client.request('PUT', '/api/follows/bob');
  await c.bob.client.request('PUT', '/api/follows/erin');
  await c.bob.client.request('PUT', '/api/friends/erin');
  const erinPost = await write(c.erin, 'erin public', { tier: 'public' });

  const blocked = await c.bob.client.request('PUT', '/api/blocks/erin');
  assert.equal(blocked.status, 200);
  assert.deepEqual(blocked.body.relation, { following: false, followed_by: false, mutual: false, friend: 'none', blocking: true });

  assert.equal((await c.erin.client.get('/api/spore/bob')).status, 404);
  assert.equal((await c.bob.client.get('/api/spore/erin')).status, 404);
  assert.equal(await seen(c.bob.client, erinPost.id), false);
  assert.equal((await c.erin.client.request('PUT', '/api/follows/bob')).status, 404);
  assert.equal((await c.erin.client.request('PUT', '/api/friends/bob')).status, 404);
  assert.deepEqual((await c.bob.client.get('/api/me/relations')).body.blocked, ['erin']);

  assert.equal((await c.bob.client.request('DELETE', '/api/blocks/erin')).status, 200);
  assert.equal(await seen(c.bob.client, erinPost.id), true);
  assert.equal((await c.bob.client.get('/api/me/relations')).body.following.includes('erin'), false, 'unblocking does not restore follows');
});

test('friend requests need accepting, and mutuals are two follows', async (t) => {
  const c = await cast(t);
  const asked = await c.bob.client.request('PUT', '/api/friends/erin');
  assert.equal(asked.body.relation.friend, 'requested');
  assert.deepEqual((await c.erin.client.get('/api/me/relations')).body.requests.incoming, ['bob']);
  assert.equal((await c.bob.client.get('/api/spore/erin')).body.relation.friend, 'requested');

  const again = await c.bob.client.request('PUT', '/api/friends/erin');
  assert.equal(again.body.relation.friend, 'requested', 'asking twice does not accept your own request');

  const accepted = await c.erin.client.request('PUT', '/api/friends/bob');
  assert.equal(accepted.body.relation.friend, 'friends');
  assert.deepEqual((await c.bob.client.get('/api/me/relations')).body.friends, ['erin']);

  await c.erin.client.request('DELETE', '/api/friends/bob');
  assert.deepEqual((await c.bob.client.get('/api/me/relations')).body.friends, []);

  await c.erin.client.request('PUT', '/api/friends/bob');
  await c.bob.client.request('DELETE', '/api/friends/erin');
  assert.deepEqual((await c.erin.client.get('/api/me/relations')).body.requests.outgoing, [], 'declining clears the request');

  await c.erin.client.request('PUT', '/api/follows/bob');
  assert.equal((await c.erin.client.get('/api/spore/bob')).body.relation.mutual, false);
  const back = await c.bob.client.request('PUT', '/api/follows/erin');
  assert.equal(back.body.relation.mutual, true);
  assert.deepEqual((await c.bob.client.get('/api/me/relations')).body.mutuals, ['erin']);

  await c.bob.client.request('DELETE', '/api/followers/erin');
  assert.equal((await c.bob.client.get('/api/spore/erin')).body.relation.followed_by, false, 'you can remove a follower');

  assert.equal((await c.bob.client.request('PUT', '/api/follows/bob')).status, 400);
  assert.equal((await c.bob.client.request('PUT', '/api/follows/nobody_here')).status, 404);
});

test('limit and offset clamp', async (t) => {
  const c = await cast(t);
  const insert = c.app.db.prepare('INSERT INTO posts (id, user_id, content, tier, created_at) VALUES (?, ?, ?, 0, ?)');
  for (let i = 0; i < 60; i++) insert.run(i.toString(16).padStart(24, '0'), c.erin.id, `post ${i}`, Date.now() + i);

  const size = async (query) => (await c.anon.get(`/api/feed${query}`)).body;
  assert.equal((await size('')).posts.length, 20);
  assert.equal((await size('?limit=-1')).posts.length, 1);
  assert.equal((await size('?limit=0')).posts.length, 1);
  assert.equal((await size('?limit=1000')).posts.length, 50);
  assert.equal((await size('?limit=abc')).posts.length, 20);
  assert.equal((await size('?offset=-5')).offset, 0);
  assert.equal((await size('?offset=99999')).offset, 10000);
  assert.equal((await size('?offset=55')).posts.length, 5);
  assert.equal((await size('?limit=5')).posts[0].content, 'post 59', 'newest first');
});

test("a disabled account's matter disappears everywhere", async (t) => {
  const c = await cast(t);
  const post = await write(c.erin, 'soon gone', { tier: 'public' });
  const open = await write(c.alice, 'open', { tier: 'public' });
  await write(c.erin, 'a reply', { parent_id: open.id });
  c.app.db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(Date.now(), c.erin.id);

  assert.equal(await seen(c.anon, post.id), false);
  assert.equal((await c.anon.get('/api/feed')).body.posts.some((p) => p.author.handle === 'erin'), false);
  assert.equal((await c.anon.get('/api/spore/erin')).status, 404);
  assert.equal((await c.bob.client.get(`/api/thread/${open.id}`)).body.replies.length, 0);
});

test('matter is 1000 characters at most, counted as characters, and tiers are checked', async (t) => {
  const c = await cast(t);
  assert.equal((await c.erin.client.post('/api/matter', { content: 'x'.repeat(1000) })).status, 201);
  assert.equal((await c.erin.client.post('/api/matter', { content: 'x'.repeat(1001) })).status, 400);
  assert.equal((await c.erin.client.post('/api/matter', { content: '🍄'.repeat(1000) })).status, 201, 'an emoji is one character');
  assert.equal((await c.erin.client.post('/api/matter', { content: '   ' })).status, 400);
  assert.equal((await c.erin.client.post('/api/matter', { content: 'x', tier: 'everyone' })).status, 400);
  assert.equal((await c.erin.client.request('PATCH', '/api/me/settings', { body: { profile: 'secret' } })).status, 400);

  await c.erin.client.request('PATCH', '/api/me/settings', { body: { matter: 'friends' } });
  assert.equal((await write(c.erin, 'uses my default')).tier, 'friends');
});
