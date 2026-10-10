import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { oauthProviders } from '../lib/oauth.js';
import { startApp, seedUser } from './helpers.js';

const KEYS = {
  GITHUB_CLIENT_ID: 'gh-client', GITHUB_CLIENT_SECRET: 'gh-secret',
  GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret',
};

const jwt = (claims) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

// stand-in for gh/google: token endpoints, github's api, and whatever the test sets
async function fakeProviders(t) {
  const fake = {
    requests: [],
    github: { id: 4242, emails: [{ email: 'alice@example.com', primary: true, verified: true }] },
    google: { sub: 'g-1', email: 'alice@example.com', email_verified: true },
    nonce: null,
  };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const form = Object.fromEntries(new URLSearchParams(body));
    fake.requests.push({ path: req.url, form, headers: req.headers });
    const json = (value) => res.setHeader('content-type', 'application/json').end(JSON.stringify(value));
    const [, provider, what] = req.url.split('/');

    if (what === 'token') {
      if (form.code !== 'good') return json({ error: 'bad_verification_code' });
      if (provider === 'github') return json({ access_token: 'gh-token', token_type: 'bearer' });
      return json({ access_token: 'at', id_token: jwt({ iss: 'https://accounts.google.com', aud: 'google-client', exp: inAnHour(), nonce: fake.nonce, ...fake[provider] }) });
    }
    if (req.headers.authorization !== 'Bearer gh-token') return res.writeHead(401).end();
    if (req.url === '/github/api/user') return json({ id: fake.github.id, login: 'someone' });
    if (req.url === '/github/api/user/emails') return json(fake.github.emails);
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  fake.providers = (config) => oauthProviders(config, {
    github: { authorize: 'https://github.test/authorize', token: `${base}/github/token`, api: `${base}/github/api` },
    google: { authorize: 'https://google.test/authorize', token: `${base}/google/token` },
  });
  return fake;
}

async function setup(t, env = {}) {
  const fake = await fakeProviders(t);
  const app = await startApp(t, { ...KEYS, ...env }, { providers: fake.providers });
  return { app, fake };
}

async function begin(client, provider, fake) {
  const res = await client.get(`/auth/oauth/${provider}`);
  assert.equal(res.status, 302);
  const url = new URL(res.headers.get('location'));
  fake.nonce = url.searchParams.get('nonce');
  return { url, cookie: res.headers.getSetCookie()[0] };
}

const finish = (client, provider, url, code = 'good') =>
  client.get(`/auth/oauth/${provider}/callback?code=${code}&state=${url.searchParams.get('state')}`);

const lands = (res) => res.headers.get('location');

test('only providers with keys switch on', async (t) => {
  const bare = await startApp(t);
  assert.deepEqual((await bare.client().get('/api/config')).body.signIn, ['link', 'password']);
  assert.equal((await bare.client().get('/auth/oauth/github')).status, 404);

  const some = await startApp(t, { GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'y' });
  assert.deepEqual((await some.client().get('/api/config')).body.signIn, ['link', 'password', 'github']);
  assert.equal((await some.client().get('/auth/oauth/google')).status, 404);
});

test('github signs a new person up, links the account, and asks for a handle', async (t) => {
  const { app, fake } = await setup(t);
  const client = app.client();
  const { url, cookie } = await begin(client, 'github', fake);
  assert.equal(url.origin + url.pathname, 'https://github.test/authorize');
  assert.equal(url.searchParams.get('client_id'), 'gh-client');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://spore.test/auth/oauth/github/callback');
  assert.equal(url.searchParams.get('scope'), 'read:user user:email');
  assert.match(url.searchParams.get('state'), /^[\w-]{43}$/);
  assert.match(cookie, /^oauth=.*; Path=\/auth\/oauth; .*HttpOnly; SameSite=Lax/);

  const done = await finish(client, 'github', url);
  assert.equal(lands(done), 'http://spore.test/auth#pick-handle');
  const me = (await client.get('/api/me')).body.user;
  assert.equal(me.email, 'alice@example.com');
  assert.deepEqual(me.linked, ['github']);
  const exchange = fake.requests.find((r) => r.path === '/github/token');
  assert.equal(exchange.form.client_secret, 'gh-secret');
  assert.equal(exchange.form.redirect_uri, 'http://spore.test/auth/oauth/github/callback');

  await client.post('/api/me/handle', { handle: 'alice' });
  const again = app.client();
  const second = await begin(again, 'github', fake);
  assert.equal(lands(await finish(again, 'github', second.url)), 'http://spore.test/');
  assert.equal(app.db.prepare('SELECT count(*) FROM users').pluck().get(), 1);
});

test('a forged or missing state, a cancelled prompt and a failed exchange sign no one in', async (t) => {
  const { app, fake } = await setup(t);

  const client = app.client();
  const { url } = await begin(client, 'github', fake);
  const forged = await client.get('/auth/oauth/github/callback?code=good&state=forged-state-forged-state-forged-state-xxx');
  assert.equal(lands(forged), 'http://spore.test/auth#error=expired');
  assert.equal((await finish(client, 'github', url)).headers.get('location'), 'http://spore.test/auth#error=expired', 'the state cookie is spent on any callback');

  const stranger = app.client();
  const other = await begin(app.client(), 'github', fake);
  assert.equal(lands(await finish(stranger, 'github', other.url)), 'http://spore.test/auth#error=expired', 'a callback from another browser');

  const cancelled = app.client();
  const c = await begin(cancelled, 'github', fake);
  assert.equal(lands(await cancelled.get(`/auth/oauth/github/callback?error=access_denied&state=${c.url.searchParams.get('state')}`)), 'http://spore.test/auth#error=cancelled');

  const bad = app.client();
  const b = await begin(bad, 'github', fake);
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  assert.equal(lands(await finish(bad, 'github', b.url, 'bad')), 'http://spore.test/auth#error=provider');

  assert.equal(app.db.prepare('SELECT count(*) FROM users').pluck().get(), 0);
  assert.equal(app.db.prepare('SELECT count(*) FROM sessions').pluck().get(), 0);
});

test('an unverified address is refused', async (t) => {
  const { app, fake } = await setup(t);
  fake.github.emails = [{ email: 'alice@example.com', primary: true, verified: false }];
  const client = app.client();
  const { url } = await begin(client, 'github', fake);
  assert.equal(lands(await finish(client, 'github', url)), 'http://spore.test/auth#error=unverified-email');
  assert.equal(app.db.prepare('SELECT count(*) FROM users').pluck().get(), 0);
});

test('a verified address signs into the account that already has it', async (t) => {
  const { app, fake } = await setup(t);
  seedUser(app, { email: 'alice@example.com', handle: 'alice' });
  const client = app.client();
  const { url } = await begin(client, 'github', fake);
  assert.equal(lands(await finish(client, 'github', url)), 'http://spore.test/');
  assert.equal((await client.get('/api/me')).body.user.handle, 'alice');
});

test('a linked provider account still signs in after its address changes there', async (t) => {
  const { app, fake } = await setup(t);
  const first = app.client();
  await finish(first, 'github', (await begin(first, 'github', fake)).url);

  fake.github.emails = [{ email: 'new-address@example.com', primary: true, verified: true }];
  const later = app.client();
  await finish(later, 'github', (await begin(later, 'github', fake)).url);
  assert.equal((await later.get('/api/me')).body.user.email, 'alice@example.com');
  assert.equal(app.db.prepare('SELECT count(*) FROM users').pluck().get(), 1);
});

test('the signup mode and disabled accounts hold for providers too', async (t) => {
  const { app, fake } = await setup(t, { SIGNUP_MODE: 'allowlist' });
  const client = app.client();
  assert.equal(lands(await finish(client, 'github', (await begin(client, 'github', fake)).url)), 'http://spore.test/auth#error=refused');

  seedUser(app, { email: 'alice@example.com', handle: 'alice', disabled: true });
  const again = app.client();
  assert.equal(lands(await finish(again, 'github', (await begin(again, 'github', fake)).url)), 'http://spore.test/auth#error=disabled');
});

test('google uses pkce and a nonce, and checks who the id token is for', async (t) => {
  const { app, fake } = await setup(t);
  const client = app.client();
  const { url } = await begin(client, 'google', fake);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'openid email');
  assert.match(url.searchParams.get('nonce'), /^[\w-]{43}$/);

  assert.equal(lands(await finish(client, 'google', url)), 'http://spore.test/auth#pick-handle');
  const verifier = fake.requests.find((r) => r.path === '/google/token').form.code_verifier;
  assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.deepEqual((await client.get('/api/me')).body.user.linked, ['google']);

  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  const replay = app.client();
  const r = await begin(replay, 'google', fake);
  fake.nonce = 'someone elses nonce';
  assert.equal(lands(await finish(replay, 'google', r.url)), 'http://spore.test/auth#error=provider');

  const wrongAudience = app.client();
  const w = await begin(wrongAudience, 'google', fake);
  fake.google.aud = 'another-app';
  assert.equal(lands(await finish(wrongAudience, 'google', w.url)), 'http://spore.test/auth#error=provider');
});

test('deleting an account unlinks its providers', async (t) => {
  const { app, fake } = await setup(t);
  const client = app.client();
  await finish(client, 'github', (await begin(client, 'github', fake)).url);
  await client.delete('/api/me', { confirm: 'alice@example.com' });
  assert.equal(app.db.prepare('SELECT count(*) FROM identities').pluck().get(), 0);
});

test('with the api on its own host, providers call back there and people land on the page', async (t) => {
  const { app, fake } = await setup(t, { API_ORIGIN: 'http://api.spore.test' });
  const client = app.client();
  const { url } = await begin(client, 'github', fake);
  assert.equal(url.searchParams.get('redirect_uri'), 'http://api.spore.test/auth/oauth/github/callback');
  assert.equal(lands(await finish(client, 'github', url)), 'http://spore.test/auth#pick-handle');
});
