import express from 'express';
import { requireHandle, requireUser } from './auth.js';
import { relationBetween } from './matter.js';
import { TIERS, tierFromName } from './visibility.js';

// length time bin keeps matter; null keeps til it's emptied
const BIN_DAYS = [3, 7, 14, 30, null];

export function relationRoutes({ db }) {
  const router = express.Router();
  router.use(['/api/follows', '/api/followers', '/api/friends', '/api/blocks', '/api/me/relations', '/api/me/settings'], requireUser, requireHandle);

  const userByHandle = db.prepare('SELECT id, handle FROM users WHERE handle = ? AND disabled_at IS NULL');
  const blocked = db.prepare(`SELECT 1 FROM blocks
    WHERE (blocker_id = @me AND blocked_id = @them) OR (blocker_id = @them AND blocked_id = @me)`);

  // other person or answer already sent; `allowBlocked` lets unblock find usr block hides
  function other(req, res, { allowBlocked = false } = {}) {
    const them = userByHandle.get(req.params.handle);
    if (!them || (!allowBlocked && blocked.get({ me: req.user.id, them: them.id }))) {
      res.status(404).json({ error: 'not found' });
      return null;
    }
    if (them.id === req.user.id) {
      res.status(400).json({ error: 'that\'s you' });
      return null;
    }
    return them;
  }

  const reply = (req, res, them) => res.json({ handle: them.handle, relation: relationBetween(db, req.user.id, them.id) });

  router.put('/api/follows/:handle', (req, res) => {
    const them = other(req, res);
    if (!them) return;
    db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)').run(req.user.id, them.id, Date.now());
    reply(req, res, them);
  });

  router.delete('/api/follows/:handle', (req, res) => {
    const them = other(req, res, { allowBlocked: true });
    if (!them) return;
    db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(req.user.id, them.id);
    reply(req, res, them);
  });

  // followers open; rm one to take back what "followers" can see
  router.delete('/api/followers/:handle', (req, res) => {
    const them = other(req, res, { allowBlocked: true });
    if (!them) return;
    db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(them.id, req.user.id);
    reply(req, res, them);
  });

  // asking auto accept usr who asked you 
  router.put('/api/friends/:handle', (req, res) => {
    const them = other(req, res);
    if (!them) return;
    db.transaction(() => {
      const accepted = db.prepare(`UPDATE friends SET accepted_at = ?
        WHERE requester_id = ? AND addressee_id = ? AND accepted_at IS NULL`).run(Date.now(), them.id, req.user.id);
      if (accepted.changes === 0) {
        db.prepare(`INSERT OR IGNORE INTO friends (requester_id, addressee_id, created_at)
          SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM friends WHERE requester_id = ? AND addressee_id = ?)`)
          .run(req.user.id, them.id, Date.now(), them.id, req.user.id);
      }
    })();
    reply(req, res, them);
  });

  // route cancels req, declines one, or ends friendship
  router.delete('/api/friends/:handle', (req, res) => {
    const them = other(req, res, { allowBlocked: true });
    if (!them) return;
    db.prepare(`DELETE FROM friends WHERE (requester_id = @me AND addressee_id = @them) OR (requester_id = @them AND addressee_id = @me)`)
      .run({ me: req.user.id, them: them.id });
    reply(req, res, them);
  });

  router.put('/api/blocks/:handle', (req, res) => {
    const them = other(req, res, { allowBlocked: true });
    if (!them) return;
    const pair = { me: req.user.id, them: them.id };
    db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (@me, @them, @now)').run({ ...pair, now: Date.now() });
      db.prepare('DELETE FROM follows WHERE (follower_id = @me AND followee_id = @them) OR (follower_id = @them AND followee_id = @me)').run(pair);
      db.prepare('DELETE FROM friends WHERE (requester_id = @me AND addressee_id = @them) OR (requester_id = @them AND addressee_id = @me)').run(pair);
    })();
    reply(req, res, them);
  });

  router.delete('/api/blocks/:handle', (req, res) => {
    const them = other(req, res, { allowBlocked: true });
    if (!them) return;
    db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.user.id, them.id);
    reply(req, res, them);
  });

  router.get('/api/me/relations', (req, res) => {
    const handles = (sql) => db.prepare(sql).pluck().all({ me: req.user.id });
    const live = 'u.disabled_at IS NULL';
    res.json({
      following: handles(`SELECT u.handle FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = @me AND ${live} ORDER BY u.handle`),
      followers: handles(`SELECT u.handle FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.followee_id = @me AND ${live} ORDER BY u.handle`),
      mutuals: handles(`SELECT u.handle FROM follows f JOIN follows back ON back.follower_id = f.followee_id AND back.followee_id = f.follower_id
        JOIN users u ON u.id = f.followee_id WHERE f.follower_id = @me AND ${live} ORDER BY u.handle`),
      friends: handles(`SELECT u.handle FROM friends f JOIN users u ON u.id = CASE WHEN f.requester_id = @me THEN f.addressee_id ELSE f.requester_id END
        WHERE (f.requester_id = @me OR f.addressee_id = @me) AND f.accepted_at IS NOT NULL AND ${live} ORDER BY u.handle`),
      requests: {
        incoming: handles(`SELECT u.handle FROM friends f JOIN users u ON u.id = f.requester_id WHERE f.addressee_id = @me AND f.accepted_at IS NULL AND ${live} ORDER BY f.created_at`),
        outgoing: handles(`SELECT u.handle FROM friends f JOIN users u ON u.id = f.addressee_id WHERE f.requester_id = @me AND f.accepted_at IS NULL AND ${live} ORDER BY f.created_at`),
      },
      blocked: handles('SELECT u.handle FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = @me ORDER BY u.handle'),
    });
  });

  const settingsOf = (user) => ({
    profile: TIERS[user.profile_tier],
    matter: TIERS[user.matter_tier],
    email: TIERS[user.email_tier],
    bin_days: user.bin_days,
  });

  router.patch('/api/me/settings', (req, res) => {
    const changes = {};
    for (const key of ['profile', 'matter', 'email']) {
      if (req.body?.[key] === undefined) continue;
      const tier = tierFromName(req.body[key]);
      if (tier === null) return res.status(400).json({ error: `${key} is one of ${TIERS.join(', ')}` });
      changes[`${key}_tier`] = tier;
    }
    if (req.body?.bin_days !== undefined) {
      if (!BIN_DAYS.includes(req.body.bin_days)) return res.status(400).json({ error: 'bin_days is one of 3, 7, 14, 30 or null' });
      changes.bin_days = req.body.bin_days;
    }
    const next = { ...req.user, ...changes };
    db.prepare(`UPDATE users SET profile_tier = @profile_tier, matter_tier = @matter_tier, email_tier = @email_tier,
      bin_days = @bin_days WHERE id = @id`).run(next);
    res.json({ settings: settingsOf(next) });
  });

  return { router, settingsOf };
}
