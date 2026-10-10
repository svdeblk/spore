import crypto from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { hashToken, newId } from './db.js';
import { isReserved, isSlur } from './names.js';
import { hashPassword, passwordProblem, verifyPassword } from './password.js';

const MINUTE = 60 * 1000;
const LINK_TTL = 15 * MINUTE;
export const INVITE_TTL = 7 * 24 * 60 * MINUTE;
const SESSION_TTL = 30 * 24 * 60 * MINUTE;
const LIMIT_WINDOW = 15 * MINUTE;
// a fresh sesh may set/rm password w/o current one
// forgotten password gets reset: sign in by link & set a new one
const FRESH_SESSION = 15 * MINUTE;


const newToken = () => crypto.randomBytes(32).toString('base64url');

export function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  const email = input.trim().toLowerCase();
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  return email;
}

export function handleProblem(handle) {
  if (handle.length < 3 || handle.length > 20) return 'handles are 3 to 20 characters';
  if (!/^[a-z0-9_]+$/.test(handle)) return 'handles use a to z, 0 to 9 and _ only';
  if (isReserved(handle)) return 'that handle is reserved';
  if (isSlur(handle)) return 'that handle isn\'t allowed';
  return null;
}

// with SameSite=Lax cookies, ref foreign origins & non-json bodies on every write closes csrf
export function sameOriginJson(domain) {
  const origin = new URL(domain).origin;
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('origin') !== origin) return res.status(403).json({ error: 'cross-origin request refused' });
    const type = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return res.status(415).json({ error: 'send json' });
    next();
  };
}

export function sessions(db) {
  const find = db.prepare(`
    SELECT users.id, users.email, users.handle, users.created_at, users.profile_tier, users.matter_tier, users.email_tier, users.bin_days,
      users.password_hash, sessions.created_at AS signed_in_at
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.disabled_at IS NULL
  `);
  return (req, res, next) => {
    req.sid = req.cookies?.sid;
    req.user = req.sid ? find.get(hashToken(req.sid), Date.now()) ?? null : null;
    next();
  };
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'sign in first' });
  next();
}

export function requireHandle(req, res, next) {
  if (!req.user.handle) return res.status(403).json({ error: 'pick a handle first' });
  next();
}

export function limiter(limit, keyGenerator, windowMs = LIMIT_WINDOW) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'too many requests. try again in a few minutes' },
  });
}

export function validEmail(req, res, next) {
  req.email = normalizeEmail(req.body?.email);
  if (!req.email) return res.status(400).json({ error: 'that email address doesn\'t look right' });
  next();
}

// admins always, allowlist lets in listed and approved addresses
// closed lets in no one new
export function canSignUp(db, config, email) {
  if (config.adminEmails.includes(email) || config.signupMode === 'open') return true;
  if (config.signupMode === 'closed') return false;
  return config.signupAllowlist.includes(email)
    || !!db.prepare("SELECT 1 FROM access_requests WHERE email = ? AND status = 'approved'").get(email);
}

// stores log-token & returns the mail that carries it
// invites live longer than sign-in links
export function issueLink(db, config, email, { ttl = LINK_TTL, invite = false } = {}) {
  const token = newToken();
  const now = Date.now();
  db.prepare('INSERT INTO login_tokens (token_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), email, now + ttl, now);

  const url = new URL('/auth', config.domain);
  // fragment will not reach server; token stays out of access logs & referrers
  url.hash = new URLSearchParams({ token, email }).toString();
  const site = url.host;
  const lasts = invite ? '7 days' : '15 minutes';
  const note = `the link works once and expires in ${lasts}. if you didn't ask for it, ignore this email.`;
  const href = url.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const opening = invite ? `you're in. come sign in to ${site}:` : `sign in to ${site}:`;
  return {
    to: email,
    subject: invite ? `you're invited to ${site}` : `your ${site} sign-in link`,
    text: `${opening}\n\n${url.href}\n\n${note}`,
    html: `<p>${opening}</p><p><a href="${href}">${href}</a></p><p>${note}</p>`,
  };
}

export const sessionCookie = (config) => ({ httpOnly: true, sameSite: 'lax', secure: config.production, path: '/' });

export function startSession(db, config, res, userId) {
  const sid = newToken();
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(sid), userId, now + SESSION_TTL, now);
  res.cookie('sid', sid, { ...sessionCookie(config), maxAge: SESSION_TTL });
}

export const signedIn = (user) => ({ user: { handle: user.handle, email: user.email }, needsHandle: user.handle === null });

// acct for addr w/ new approval created if signup allows it
// res string when address can't sign in
export function accountFor(db, config, email) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (user) return user.disabled_at === null ? user : 'disabled';
  // signup mode changes between asking to sign in & proving the address
  if (!canSignUp(db, config, email)) return 'refused';
  const created = { id: newId(), email, handle: null };
  db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(created.id, email, Date.now());
  return created;
}

export function authRoutes({ db, config, mailer }) {
  const router = express.Router();
  const cookieOptions = sessionCookie(config);

  const userByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  const redeem = db.prepare(`
    UPDATE login_tokens SET used_at = @now
    WHERE token_hash = @hash AND used_at IS NULL AND expires_at > @now
    RETURNING email
  `);
  const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const setHandle = db.prepare('UPDATE users SET handle = ? WHERE id = ? AND handle IS NULL');

  // same reply goes to every valid address, whether it has an account or may sign up
  router.post('/auth/request-link', limiter(5), validEmail, limiter(3, (req) => req.email), async (req, res) => {
    const user = userByEmail.get(req.email);
    const eligible = user ? user.disabled_at === null : canSignUp(db, config, req.email);
    if (eligible) {
      try {
        await mailer.send(issueLink(db, config, req.email));
      } catch (err) {
        console.error(err);
        return res.status(502).json({ error: 'the link couldn\'t be sent. try again in a minute' });
      }
    }
    res.json({ status: 'sent' });
  });

  router.post('/auth/verify', limiter(20), (req, res) => {
    const token = req.body?.token;
    if (typeof token !== 'string' || token.length === 0 || token.length > 128) {
      return res.status(400).json({ error: 'token required' });
    }

    const outcome = db.transaction(() => {
      const now = Date.now();
      const redeemed = redeem.get({ hash: hashToken(token), now });
      return redeemed ? accountFor(db, config, redeemed.email) : 'unknown';
    })();

    if (outcome === 'unknown') return res.status(401).json({ error: 'this link is used or expired. ask for a new one' });
    if (typeof outcome === 'string') return res.status(403).json({ error: 'this address can\'t sign in' });
    startSession(db, config, res, outcome.id);
    res.json(signedIn(outcome));
  });

  let decoy;
  router.post('/auth/password', limiter(10), validEmail, limiter(5, (req) => req.email), async (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const user = userByEmail.get(req.email);
    decoy ??= await hashPassword(newToken(), config.passwordCost);
    const matches = await verifyPassword(password, user?.password_hash ?? decoy);
    if (!user?.password_hash || !matches || user.disabled_at !== null) {
      return res.status(401).json({ error: 'wrong email or password' });
    }
    startSession(db, config, res, user.id);
    res.json(signedIn(user));
  });

  async function mayChangePassword(req, res) {
    if (!req.user.password_hash || Date.now() - req.user.signed_in_at < FRESH_SESSION) return true;
    const current = req.body?.current;
    if (typeof current === 'string' && await verifyPassword(current, req.user.password_hash)) return true;
    res.status(403).json({ error: 'enter your current password, or sign in again by link' });
    return false;
  }

  // new pw signs out every other session
  router.post('/api/me/password', requireUser, limiter(10), async (req, res) => {
    const problem = passwordProblem(req.body?.password);
    if (problem) return res.status(400).json({ error: problem });
    if (!await mayChangePassword(req, res)) return;
    const hash = await hashPassword(req.body.password, config.passwordCost);
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(req.user.id, hashToken(req.sid));
    })();
    res.status(204).end();
  });

  router.delete('/api/me/password', requireUser, limiter(10), async (req, res) => {
    if (!await mayChangePassword(req, res)) return;
    db.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').run(req.user.id);
    res.status(204).end();
  });

  router.post('/auth/logout', (req, res) => {
    if (req.sid) deleteSession.run(hashToken(req.sid));
    res.clearCookie('sid', cookieOptions);
    res.status(204).end();
  });

  // handles are permanent for beta
  // rename would break [[handle]] links in old posts
  router.post('/api/me/handle', requireUser, (req, res) => {
    if (req.user.handle) return res.status(409).json({ error: 'your handle is already set' });

    const handle = typeof req.body?.handle === 'string' ? req.body.handle.trim() : '';
    const problem = handleProblem(handle);
    if (problem) return res.status(400).json({ error: problem });

    try {
      if (setHandle.run(handle, req.user.id).changes === 0) {
        return res.status(409).json({ error: 'your handle is already set' });
      }
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'that handle is taken' });
      throw err;
    }
    res.json({ user: { handle, email: req.user.email } });
  });

  return router;
}
