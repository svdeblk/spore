// throwaway server in-mem database. alice dummy & one pub matter already there

import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { createApp } from '../../lib/app.js';
import { loadConfig } from '../../lib/config.js';
import { newId, openDb } from '../../lib/db.js';
import { createMailer } from '../../lib/mail.js';

export const executablePath = process.env.CHROMIUM_PATH ?? (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

export async function startServer(env = {}) {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const db = openDb(':memory:');
  const log = [];
  const config = loadConfig({ DOMAIN: origin, MAIL_TRANSPORT: 'console', PASSWORD_COST: '10', ADMIN_EMAILS: 'matter@spore.bond', ...env });
  const app = createApp({ db, config, mailer: createMailer(config, { log: (line) => log.push(line) }) });
  server.on('request', app);

  const alice = newId();
  const now = Date.now();
  db.prepare("INSERT INTO users (id, email, handle, created_at) VALUES (?, 'alice@example.com', 'alice', ?)").run(alice, now - 86400000);
  db.prepare('INSERT INTO posts (id, user_id, content, tier, created_at) VALUES (?, ?, ?, 0, ?)')
    .run(newId(), alice, 'welcome to the **feed**. this is ~matter~, with ::highlights::, `code` and a link back to [[alice]].\n\n> quoted, too', now - 3600000);
  const lastLink = () => log.findLast((line) => /https?:\/\//.test(line)).match(/https?:\/\/\S+/)[0];
  return { server, db, log, origin, alice, lastLink, close: () => new Promise((resolve) => server.close(() => { db.close(); resolve(); })) };
}
