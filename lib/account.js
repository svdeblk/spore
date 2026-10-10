import express from 'express';
import { toIso } from './db.js';
import { requireUser } from './auth.js';
import { TIERS } from './visibility.js';

export function accountRoutes({ db, config, signIn }) {
  const router = express.Router();

  router.get('/healthz', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  router.get('/api/config', (req, res) => {
    res.json({ signupMode: config.signupMode, maxPostChars: config.maxPostChars, tiers: TIERS, signIn });
  });

  // spore print: everything the account writes, every tier, and the handles tied to them
  router.get('/api/me/export', requireUser, (req, res) => {
    const me = { me: req.user.id };
    const handles = (sql) => db.prepare(sql).pluck().all(me);
    const print = {
      exported_at: toIso(Date.now()),
      account: {
        handle: req.user.handle,
        email: req.user.email,
        created_at: toIso(req.user.created_at),
        settings: { profile: TIERS[req.user.profile_tier], matter: TIERS[req.user.matter_tier], email: TIERS[req.user.email_tier], bin_days: req.user.bin_days },
      },
      // archived and binned matter is still the account's, so it's in the print until it's gone for good
      matter: db.prepare('SELECT id, content, tier, parent_id, created_at, archived_at, binned_at FROM posts WHERE user_id = @me ORDER BY created_at').all(me)
        .map((post) => ({
          ...post,
          tier: TIERS[post.tier],
          created_at: toIso(post.created_at),
          archived_at: post.archived_at && toIso(post.archived_at),
          binned_at: post.binned_at && toIso(post.binned_at),
        })),
      following: handles('SELECT u.handle FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = @me ORDER BY u.handle'),
      followers: handles('SELECT u.handle FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.followee_id = @me ORDER BY u.handle'),
      friends: handles(`SELECT u.handle FROM friends f JOIN users u ON u.id = CASE WHEN f.requester_id = @me THEN f.addressee_id ELSE f.requester_id END
        WHERE (f.requester_id = @me OR f.addressee_id = @me) AND f.accepted_at IS NOT NULL ORDER BY u.handle`),
      blocked: handles('SELECT u.handle FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = @me ORDER BY u.handle'),
    };
    const name = `spore-print-${req.user.handle ?? 'unnamed'}.json`;
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.json(print);
  });

  // full handle typed out or def. address for an account w/o one
  router.delete('/api/me', requireUser, (req, res) => {
    const expected = req.user.handle ?? req.user.email;
    if (req.body?.confirm !== expected) {
      return res.status(400).json({ error: `type ${req.user.handle ? 'your handle' : 'your email address'} to confirm` });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM login_tokens WHERE email = ?').run(req.user.email);
      db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
    })();
    res.clearCookie('sid', { httpOnly: true, sameSite: 'lax', secure: config.production, path: '/' });
    res.status(204).end();
  });

  return router;
}
