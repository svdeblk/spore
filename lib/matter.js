import express from 'express';
import { newId, toIso } from './db.js';
import { render } from './parser.js';
import { limiter, requireHandle, requireUser } from './auth.js';
import { TIERS, blockedEitherWay, canSee, canSeePost, followsOrFriends, tierFromName } from './visibility.js';

const DAY = 24 * 60 * 60 * 1000;

const REPLY_COUNT = `(SELECT count(*) FROM posts c JOIN users ca ON ca.id = c.user_id
  WHERE c.parent_id = p.id AND ${canSeePost('c', 'ca')}) AS replies`;

const POST_COLUMNS = `p.id, p.content, p.tier, p.parent_id, p.created_at, a.handle, ${REPLY_COUNT}`;

function present(row) {
  return {
    id: row.id,
    author: { handle: row.handle },
    content: row.content,
    html: render(row.content),
    tier: TIERS[row.tier],
    parent_id: row.parent_id,
    created_at: toIso(row.created_at),
    replies: row.replies,
  };
}

function clamp(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  return Number.isNaN(number) ? fallback : Math.min(Math.max(number, min), max);
}

export const page = (query) => ({ limit: clamp(query.limit, 20, 1, 50), offset: clamp(query.offset, 0, 0, 10000) });

export function relationBetween(db, viewerId, targetId) {
  if (!viewerId || viewerId === targetId) return null;
  const following = !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(viewerId, targetId);
  const followedBy = !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(targetId, viewerId);
  const friendship = db.prepare(`SELECT requester_id, accepted_at FROM friends
    WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`).get(viewerId, targetId, targetId, viewerId);
  const friend = !friendship ? 'none' : friendship.accepted_at ? 'friends' : friendship.requester_id === viewerId ? 'requested' : 'incoming';
  const blocking = !!db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(viewerId, targetId);
  return { following, followed_by: followedBy, mutual: following && followedBy, friend, blocking };
}

export function matterRoutes({ db, config }) {
  const router = express.Router();
  const isAdmin = (user) => config.adminEmails.includes(user.email);
  const postingLimit = limiter(10, (req) => req.user.id, 60 * 1000);
  const viewer = (req) => req.user?.id ?? null;

  const findPost = db.prepare(`SELECT ${POST_COLUMNS}, p.user_id, ${canSeePost('p', 'a')} AS visible
    FROM posts p JOIN users a ON a.id = p.user_id WHERE p.id = @id`);

  router.get('/api/feed', (req, res) => {
    const posts = db.prepare(`SELECT ${POST_COLUMNS} FROM posts p JOIN users a ON a.id = p.user_id
      WHERE p.parent_id IS NULL AND max(p.tier, a.profile_tier) = 0 AND ${canSeePost('p', 'a')}
      ORDER BY p.created_at DESC LIMIT @limit OFFSET @offset`).all({ viewer: viewer(req), ...page(req.query) });
    res.json({ posts: posts.map(present), ...page(req.query) });
  });

  router.get('/api/substrate', requireUser, (req, res) => {
    const posts = db.prepare(`SELECT ${POST_COLUMNS} FROM posts p JOIN users a ON a.id = p.user_id
      WHERE p.parent_id IS NULL AND (a.id = @viewer OR ${followsOrFriends('a')}) AND ${canSeePost('p', 'a')}
      ORDER BY p.created_at DESC LIMIT @limit OFFSET @offset`).all({ viewer: viewer(req), ...page(req.query) });
    res.json({ posts: posts.map(present), ...page(req.query) });
  });

  router.get('/api/matter/:id', (req, res) => {
    const post = findPost.get({ id: req.params.id, viewer: viewer(req) });
    if (!post?.visible) return res.status(404).json({ error: 'not found' });
    res.json(present(post));
  });

  router.get('/api/thread/:id', (req, res) => {
    const root = findPost.get({ id: req.params.id, viewer: viewer(req) });
    if (!root?.visible || root.parent_id) return res.status(404).json({ error: 'not found' });
    const replies = db.prepare(`SELECT ${POST_COLUMNS} FROM posts p JOIN users a ON a.id = p.user_id
      WHERE p.parent_id = @id AND ${canSeePost('p', 'a')} ORDER BY p.created_at ASC`).all({ id: root.id, viewer: viewer(req) });
    res.json({ root: present(root), replies: replies.map(present) });
  });

  router.post('/api/matter', requireUser, requireHandle, postingLimit, (req, res) => {
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) return res.status(400).json({ error: 'write something first' });
    if ([...content].length > config.maxPostChars) {
      return res.status(400).json({ error: `matter is ${config.maxPostChars} characters at most` });
    }

    const parentId = req.body.parent_id ?? null;
    let tier = req.user.matter_tier;
    if (parentId !== null) {
      const parent = findPost.get({ id: String(parentId), viewer: req.user.id });
      if (!parent?.visible || parent.parent_id) return res.status(404).json({ error: 'not found' });
      // reply shown only where its root is; root's tier governs it
      tier = 0;
    } else if (req.body.tier !== undefined) {
      tier = tierFromName(req.body.tier);
      if (tier === null) return res.status(400).json({ error: `tier is one of ${TIERS.join(', ')}` });
    }

    const id = newId();
    db.prepare('INSERT INTO posts (id, user_id, content, tier, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, req.user.id, content, tier, parentId, Date.now());
    res.status(201).json(present(findPost.get({ id, viewer: req.user.id })));
  });

  // authors del their own matter; author of root can clear replies under it
  // checked before vis: a reply from blocked usr is hidden but still avail to clear
  // admins may delete anything
  router.delete('/api/matter/:id', requireUser, (req, res) => {
    const post = db.prepare(`SELECT p.id, p.user_id, root.user_id AS root_owner
      FROM posts p LEFT JOIN posts root ON root.id = p.parent_id WHERE p.id = ?`).get(req.params.id);
    if (post && (post.user_id === req.user.id || post.root_owner === req.user.id || isAdmin(req.user))) {
      db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
      return res.status(204).end();
    }
    const visible = post && findPost.get({ id: post.id, viewer: req.user.id }).visible;
    res.status(visible ? 403 : 404).json({ error: visible ? 'not yours to delete' : 'not found' });
  });

  // decay & decompose: only an author moves their own matter out of view & back
  // root's germs go w/ & come back w/ it
  // rot (perm delete) stays the way to rm another usr's
  const ownMatter = (req, res) => {
    const post = db.prepare('SELECT id, user_id FROM posts WHERE id = ?').get(req.params.id);
    if (post?.user_id === req.user.id) return post;
    const visible = post && findPost.get({ id: post.id, viewer: req.user.id }).visible;
    res.status(visible ? 403 : 404).json({ error: visible ? 'not yours' : 'not found' });
    return null;
  };
  const OWN_COLUMNS = `${POST_COLUMNS}, p.archived_at, p.binned_at, a.bin_days`;
  const presentOwn = (row) => ({
    ...present(row),
    archived_at: row.archived_at && toIso(row.archived_at),
    binned_at: row.binned_at && toIso(row.binned_at),
    gone_at: row.binned_at && row.bin_days ? toIso(row.binned_at + row.bin_days * DAY) : null,
  });
  const findOwn = db.prepare(`SELECT ${OWN_COLUMNS} FROM posts p JOIN users a ON a.id = p.user_id WHERE p.id = @id`);
  const move = (archived, binned) => (req, res) => {
    const post = ownMatter(req, res);
    if (!post) return;
    db.prepare('UPDATE posts SET archived_at = ?, binned_at = ? WHERE id = ?').run(archived ? Date.now() : null, binned ? Date.now() : null, post.id);
    res.json(presentOwn(findOwn.get({ id: post.id, viewer: req.user.id })));
  };
  router.post('/api/matter/:id/archive', requireUser, move(true, false));
  router.post('/api/matter/:id/bin', requireUser, move(false, true));
  router.post('/api/matter/:id/restore', requireUser, move(false, false));

  const ownList = (column) => (req, res) => {
    const posts = db.prepare(`SELECT ${OWN_COLUMNS} FROM posts p JOIN users a ON a.id = p.user_id
      WHERE a.id = @viewer AND p.${column} IS NOT NULL ORDER BY p.${column} DESC LIMIT @limit OFFSET @offset`)
      .all({ viewer: req.user.id, ...page(req.query) });
    res.json({ posts: posts.map(presentOwn), ...page(req.query) });
  };
  router.get('/api/me/archive', requireUser, ownList('archived_at'));
  router.get('/api/me/bin', requireUser, ownList('binned_at'));
  router.delete('/api/me/bin', requireUser, (req, res) => {
    const removed = db.prepare('DELETE FROM posts WHERE user_id = ? AND binned_at IS NOT NULL').run(req.user.id).changes;
    res.json({ removed });
  });

  router.get('/api/spore/:handle', (req, res) => {
    const profile = db.prepare(`SELECT u.id, u.handle, u.email, u.profile_tier, u.created_at,
        ${blockedEitherWay('u')} AS blocked,
        ${canSee('u', 'u.profile_tier')} AS visible,
        ${canSee('u', 'max(u.email_tier, u.profile_tier)')} AS email_visible
      FROM users u WHERE u.handle = @handle AND u.disabled_at IS NULL`).get({ handle: req.params.handle, viewer: viewer(req) });
    if (!profile || (profile.blocked && profile.id !== viewer(req))) return res.status(404).json({ error: 'not found' });

    const relation = relationBetween(db, viewer(req), profile.id);
    const visibility = TIERS[profile.profile_tier];
    if (!profile.visible) {
      const error = visibility === 'private' ? `@${profile.handle} isn't accepting views right now`
        : visibility === 'friends' ? `only @${profile.handle}'s friends can see this` : `follow @${profile.handle} to see this`;
      return res.status(403).json({ error, handle: profile.handle, visibility, relation });
    }

    const posts = db.prepare(`SELECT ${POST_COLUMNS} FROM posts p JOIN users a ON a.id = p.user_id
      WHERE a.id = @author AND p.parent_id IS NULL AND ${canSeePost('p', 'a')}
      ORDER BY p.created_at DESC LIMIT @limit OFFSET @offset`).all({ author: profile.id, viewer: viewer(req), ...page(req.query) });

    res.json({
      handle: profile.handle,
      joined: toIso(profile.created_at),
      visibility,
      ...(profile.email_visible ? { email: profile.email } : {}),
      relation,
      posts: posts.map(present),
      ...page(req.query),
    });
  });

  return router;
}
