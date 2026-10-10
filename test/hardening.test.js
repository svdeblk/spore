import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, productionProblems } from '../lib/config.js';
import { startApp } from './helpers.js';

test('api answers carry the security headers and a policy that allows nothing', async (t) => {
  const app = await startApp(t);
  for (const path of ['/api/feed', '/api/nope', '/auth/nope', '/healthz']) {
    const res = await app.client().get(path);
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'", path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    assert.match(res.headers.get('strict-transport-security'), /max-age=\d+/, path);
    assert.equal(res.headers.get('x-powered-by'), null, path);
  }
});

test('prod refuses to start until every piece of config is in place & with naming each one', () => {
  const problems = productionProblems(loadConfig({ NODE_ENV: 'production', GITHUB_CLIENT_ID: 'x' }));
  assert.deepEqual(problems, [
    'DOMAIN has to be https, not http://localhost:3000',
    'RESEND_API_KEY is missing',
    'SIGNUP_MODE has to be set on purpose: open, allowlist or closed',
    'ADMIN_EMAILS is empty',
    'github sign-in is half configured',
  ]);
  assert.deepEqual(productionProblems(loadConfig({
    NODE_ENV: 'production', DOMAIN: 'https://spore.bond', RESEND_API_KEY: 're_test', SIGNUP_MODE: 'allowlist',
    ADMIN_EMAILS: 'matter@spore.bond',
  })), []);
  assert.deepEqual(productionProblems(loadConfig({})), [], 'dev never refuses');
});

test('with the api on its own host only the page may call it with cookies', async (t) => {
  const app = await startApp(t, { API_ORIGIN: 'http://api.spore.test' });
  const preflight = await app.client().request('OPTIONS', '/api/matter', {
    headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://spore.test');
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
  assert.match(preflight.headers.get('access-control-allow-methods'), /DELETE/);

  const read = await app.client().get('/api/feed');
  assert.equal(read.headers.get('access-control-allow-origin'), 'http://spore.test');

  const stranger = await app.client().get('/api/feed', { origin: 'https://evil.example' });
  assert.equal(stranger.headers.get('access-control-allow-origin'), null);
  const strangerPreflight = await app.client().request('OPTIONS', '/api/matter', { origin: 'https://evil.example' });
  assert.equal(strangerPreflight.headers.get('access-control-allow-origin'), null);
});

test('on cur host there are no cors headers at all', async (t) => {
  const app = await startApp(t);
  assert.equal((await app.client().get('/api/feed')).headers.get('access-control-allow-origin'), null);
});

test('production needs api host on https too', () => {
  const problems = productionProblems(loadConfig({
    NODE_ENV: 'production', DOMAIN: 'https://spore.bond', API_ORIGIN: 'http://api.spore.bond', RESEND_API_KEY: 're_x',
    SIGNUP_MODE: 'allowlist', ADMIN_EMAILS: 'matter@spore.bond',
  }));
  assert.deepEqual(problems, ['API_ORIGIN has to be https, not http://api.spore.bond']);
});
