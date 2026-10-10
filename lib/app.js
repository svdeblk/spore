import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { toIso } from './db.js';
import { authRoutes, requireUser, sameOriginJson, sessions } from './auth.js';
import { createMailer } from './mail.js';
import { matterRoutes } from './matter.js';
import { relationRoutes } from './relations.js';
import { accountRoutes } from './account.js';
import { accessRoutes, adminRoutes } from './access.js';
import { oauthProviders, oauthRoutes } from './oauth.js';

export function createApp({ db, config, mailer = createMailer(config), providers = oauthProviders(config) }) {
  const app = express();
  const publicDir = path.join(import.meta.dirname, '..', 'public');
  const relations = relationRoutes({ db });
  app.set('trust proxy', config.trustProxy);
  // helmet's own csp is off: api routes get a deny-all one below, the page gets its policy from public/_headers
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(['/api', '/auth', '/healthz'], (req, res, next) => {
    res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    next();
  });

  // the page's origin may call the api with its cookies
  const pageOrigin = new URL(config.domain).origin;
  app.use((req, res, next) => {
    if (req.get('origin') !== pageOrigin || pageOrigin === new URL(config.apiOrigin).origin) return next();
    res.set({ 'Access-Control-Allow-Origin': pageOrigin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' });
    if (req.method !== 'OPTIONS') return next();
    res.set({
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '600',
    });
    res.status(204).end();
  });

  // the page gets its own policy from CF pages from _headers
  const pagePolicy = fs.readFileSync(path.join(publicDir, '_headers'), 'utf8').match(/Content-Security-Policy: (.+)/)[1];
  const servePage = (res) => res.set('Content-Security-Policy', pagePolicy);
  app.use(express.static(publicDir, { setHeaders: (res, file) => { if (file.endsWith('.html')) servePage(res); } }));
  app.use(sameOriginJson(config.domain));
  // morel can be 20000 chars of up to 4 bytes; everything else stays small
  app.use('/api/morels', express.json({ limit: '96kb' }));
  app.use(express.json({ limit: '16kb' }));
  app.use(cookieParser());
  app.use(sessions(db));
  app.use(authRoutes({ db, config, mailer }));
  app.use(matterRoutes({ db, config }));
  app.use(relations.router);
  app.use(oauthRoutes({ db, config, providers }));
  app.use(accountRoutes({ db, config, signIn: ['link', 'password', ...Object.keys(providers)] }));
  app.use(accessRoutes({ db, config, mailer }));
  app.use(adminRoutes({ db, config }));

  app.get('/api/me', requireUser, (req, res) => {
    const { user } = req;
    res.json({
      user: {
        handle: user.handle,
        email: user.email,
        created_at: toIso(user.created_at),
        settings: relations.settingsOf(user),
        has_password: user.password_hash !== null,
        puffball: user.puffball_text ? { text: user.puffball_text, set_at: toIso(user.puffball_at) } : null,
        linked: db.prepare('SELECT provider FROM identities WHERE user_id = ? ORDER BY provider').pluck().all(user.id),
        admin: config.adminEmails.includes(user.email),
      },
    });
  });

  // page's urls, ahead of the json 404s. /auth is both the link's landing page & a prefix
  const pages = ['/', '/auth', '/request-access', '/admin', '/archive', '/bin', '/morel', '/substrate', '/settings', '/privacy', '/about', '/terms', '/contact', '/thread/:id', '/@:handle'];
  app.get(pages, (req, res) => {
    servePage(res);
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use(['/api', '/auth'], (req, res) => res.status(404).json({ error: 'not found' }));

  // errors answer in json, no stack trace
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'that isn\'t valid json' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'that\'s too large' });
    console.error(err);
    res.status(500).json({ error: 'something went wrong' });
  });

  return app;
}