import express from 'express';
import { newId, toIso } from './db.js';
import { INVITE_TTL, issueLink, limiter, requireUser, validEmail } from './auth.js';

const NOTE_LIMIT = 500;

export function requireAdmin(config) {
  return (req, res, next) => {
    if (!config.adminEmails.includes(req.user.email)) return res.status(403).json({ error: 'admins only' });
    next();
  };
}

export function accessRoutes({ db, config, mailer }) {
  const router = express.Router();

  // one reply for everyone, whether the address is new, waiting, already in, or turned down before
  router.post('/auth/request-access', limiter(5), validEmail, limiter(3, (req) => req.email), (req, res) => {
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if ([...note].length > NOTE_LIMIT) return res.status(400).json({ error: `the note is ${NOTE_LIMIT} characters at most` });

    const member = db.prepare('SELECT 1 FROM users WHERE email = ?').get(req.email);
    if (!member) {
      db.prepare(`INSERT INTO access_requests (id, email, note, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (email) WHERE status <> 'declined' DO NOTHING`).run(newId(), req.email, note, Date.now());
    }
    res.json({ status: 'received' });
  });

  const admin = [requireUser, requireAdmin(config)];
  const findRequest = db.prepare('SELECT * FROM access_requests WHERE id = ?');
  const present = (row) => ({ id: row.id, email: row.email, note: row.note, status: row.status, created_at: toIso(row.created_at) });

  router.get('/api/admin/requests', ...admin, (req, res) => {
    const status = ['pending', 'approved', 'declined'].includes(req.query.status) ? req.query.status : 'pending';
    const rows = db.prepare('SELECT * FROM access_requests WHERE status = ? ORDER BY created_at').all(status);
    res.json({ requests: rows.map(present) });
  });

  // approving again sends a fresh invite, for when the first one expired or went astray
  router.post('/api/admin/requests/:id/approve', ...admin, async (req, res) => {
    const request = findRequest.get(req.params.id);
    if (!request) return res.status(404).json({ error: 'not found' });
    if (request.status === 'declined') return res.status(409).json({ error: 'declined requests stay declined. they can ask again' });

    db.prepare("UPDATE access_requests SET status = 'approved', decided_at = ? WHERE id = ?").run(Date.now(), request.id);
    try {
      await mailer.send(issueLink(db, config, request.email, { ttl: INVITE_TTL, invite: true }));
    } catch (err) {
      console.error(err);
      return res.status(502).json({ error: 'approved, but the invite couldn\'t be sent. approve again to retry', request: present({ ...request, status: 'approved' }) });
    }
    res.json({ request: present({ ...request, status: 'approved' }) });
  });

  router.post('/api/admin/requests/:id/decline', ...admin, (req, res) => {
    const request = findRequest.get(req.params.id);
    if (!request) return res.status(404).json({ error: 'not found' });
    if (request.status !== 'pending') return res.status(409).json({ error: `already ${request.status}` });
    db.prepare("UPDATE access_requests SET status = 'declined', decided_at = ? WHERE id = ?").run(Date.now(), request.id);
    res.json({ request: present({ ...request, status: 'declined' }) });
  });

  return router;
}

export function adminRoutes({ db, config }) {
  const router = express.Router();
  const admin = [requireUser, requireAdmin(config)];
  const account = db.prepare('SELECT id, email, handle, disabled_at FROM users WHERE handle = ?');

  function target(req, res) {
    const user = account.get(req.params.handle);
    if (!user) {
      res.status(404).json({ error: 'not found' });
      return null;
    }
    if (config.adminEmails.includes(user.email)) {
      res.status(403).json({ error: 'admins can\'t be disabled here' });
      return null;
    }
    return user;
  }

  // disabling ends every session at once, and hides the account's matter everywhere
  router.post('/api/admin/users/:handle/disable', ...admin, (req, res) => {
    const user = target(req, res);
    if (!user) return;
    db.transaction(() => {
      db.prepare('UPDATE users SET disabled_at = coalesce(disabled_at, ?) WHERE id = ?').run(Date.now(), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    })();
    res.json({ handle: user.handle, disabled: true });
  });

  router.post('/api/admin/users/:handle/enable', ...admin, (req, res) => {
    const user = target(req, res);
    if (!user) return;
    db.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(user.id);
    res.json({ handle: user.handle, disabled: false });
  });

  return router;
}
