import { once } from 'node:events';
import { openDb, newId, hashToken } from '../lib/db.js';
import { loadConfig } from '../lib/config.js';
import { createApp } from '../lib/app.js';
import { createMailer } from '../lib/mail.js';

export const DOMAIN = 'http://spore.test';

// app on rand port w/ console mail lands in `log` not stdout
export async function startApp(t, env = {}, { mailer, providers } = {}) {
  const db = openDb(':memory:');
  // cheap pw hash keeps suite fast; test/password.test.js checks the real cost once
  const config = loadConfig({ DOMAIN, MAIL_TRANSPORT: 'console', PASSWORD_COST: '10', ...env });
  const log = [];
  const app = createApp({
    db,
    config,
    mailer: mailer ?? createMailer(config, { log: (line) => log.push(line) }),
    ...(providers ? { providers: providers(config) } : {}),
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
    db.close();
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, config, log, base, client: () => new Client(base) };
}

export class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  async request(method, path, { body, origin = DOMAIN, type = 'application/json', headers = {} } = {}) {
    const sent = { ...headers };
    if (origin) sent.origin = origin;
    if (type && method !== 'GET' && method !== 'HEAD') sent['content-type'] = type;
    if (this.cookies.size) sent.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');

    const res = await fetch(this.base + path, {
      method,
      headers: sent,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      redirect: 'manual',
    });

    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const name = pair.slice(0, pair.indexOf('='));
      const value = pair.slice(pair.indexOf('=') + 1);
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, headers: res.headers, body: json, text };
  }

  get(path, options) {
    return this.request('GET', path, options);
  }

  post(path, body = {}, options) {
    return this.request('POST', path, { ...options, body });
  }

  delete(path, body = {}, options) {
    return this.request('DELETE', path, { ...options, body });
  }
}

export function mailsTo(log, email) {
  return log.filter((line) => line.startsWith(`mail to ${email}:`));
}

export function linkFor(log, email) {
  const mails = mailsTo(log, email);
  if (mails.length === 0) throw new Error(`no mail to ${email}`);
  return new URL(mails.at(-1).match(/https?:\/\/\S+/)[0]);
}

export const tokenFor = (log, email) => new URLSearchParams(linkFor(log, email).hash.slice(1)).get('token');

// entire mail flow for tests about sign-in
export async function signIn(app, email, handle) {
  const client = app.client();
  await client.post('/auth/request-link', { email });
  await client.post('/auth/verify', { token: tokenFor(app.log, email) });
  if (handle) await client.post('/api/me/handle', { handle });
  return client;
}

// usr w/ live session written straight to the db for tests
export function seedUser(app, { email, handle = null, disabled = false }) {
  const id = newId();
  const now = Date.now();
  app.db.prepare('INSERT INTO users (id, email, handle, created_at, disabled_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, email, handle, now, disabled ? now : null);
  const sid = `test-${id}`;
  app.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(sid), id, now + 60 * 60 * 1000, now);
  const client = app.client();
  client.cookies.set('sid', sid);
  return { id, email, handle, client };
}
