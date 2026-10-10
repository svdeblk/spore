import express from 'express';
import { newId, toIso } from './db.js';
import { excerpt, render } from './parser.js';
import { limiter, requireHandle, requireUser } from './auth.js';
import { TIERS, blockedEitherWay, canSee, canSeePost, followsOrFriends, tierFromName } from './visibility.js';

const DAY = 24 * 60 * 60 * 1000;

const REPLY_COUNT = `(SELECT count(*) FROM posts c JOIN users ca ON ca.id = c.user_id
  WHERE c.parent_id = p.id AND ${canSeePost('c', 'ca')}) AS replies`;

const POST_COLUMNS = `p.id, p.content, p.tier, p.parent_id, p.created_at, p.kind, p.title, p.shared, a.handle, ${REPLY_COUNT}`;

// puffball = 1 short line of status on a profile
export const PUFFBALL_CHARS = 140;
const TITLE_CHARS = 120;

// feeds carry matter; morels only when author shared them as a card
const FEEDABLE = "(p.kind = 'matter' OR p.shared = 1)";

// morel is long: lists carry a card (title + excerpt), only its own page carries the text
function present(row, full = false) {
  const morel = row.kind === 'morel';
  return {
    id: row.id,
    kind: row.kind,
    author: { handle: row.handle },
    ...(morel ? { title: row.title, shared: Boolean(row.shared) } : {}),
    ...(morel && !full ? {} : { content: row.content }),
    ...(morel && !full ? { excerpt: excerpt(row.content) } : { html: render(row.content) }),
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
      WHERE p.parent_id IS NULL AND ${FEEDABLE} AND max(p.tier, a.profile_tier) = 0 AND ${canSeePost('p', 'a')}
      ORDER BY p.created_at DESC LIMIT @limit OFFSET @offset`).all({ viewer: viewer(req), ...page(req.query) });
    res.json({ posts: posts.map((row) => present(row)), ...page(req.query) });
  });

  router.get('/api/substrate', requireUser, (req, res) => {
    const posts = db.prepare(`SELECT ${POST_COLUMNS} FROM posts p JOIN users a ON a.id = p.user_id
      WHERE p.parent_id IS NULL AND ${FEEDABLE} AND (a.id = @viewer OR ${followsOrFriends('a')}) AND ${canSeePost('p', 'a')}
      ORDER BY p.created_at DESC LIMIT @limit OFFSET @offset`).all({ viewer: viewer(req), ...page(req.query) });
    res.json({ posts: posts.map((row) => present(row)), ...page(req.query) });
  });

  router.get('/api/matter/:id', (req, res) => {
    const post = findPost.get({ id: req.params.id, viewer: viewer(req) });
    if (!post?.visible) return res.status(404).json({ error: 'not found' });
    res.json(present(post, true));
  });

  router.get('/api/thread/:id', (req, res) => {
    const root = findPost.get({ id: req.params.id, viewer: viewer(req) });
    if (!root?.visible || root.parent_id) return res.status(404).json({ error: 'not found' });
    const replies = db.prepare(`SELECT ${POST_COLUMNS} FROM posts p JOIN users a ON a.id = p.user_id
      WHERE p.parent_id = @id AND ${canSeePost('p', 'a')} ORDER BY p.created_at ASC`).all({ id: root.id, viewer: viewer(req) });
    res.json({ root: present(root, true), replies: replies.map((row) => present(row)) });
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

  // morel: long form w/ title, 20000 chars by default; lives on author's profile & own page,
  // card goes to feeds only when author shares it; germinations work as on matter
  router.post('/api/morels', requireUser, requireHandle, postingLimit, (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.replace(/\s+/g, ' ').trim() : '';
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!title) return res.status(400).json({ error: 'a morel needs a title' });
    if ([...title].length > TITLE_CHARS) return res.status(400).json({ error: `titles are ${TITLE_CHARS} characters at most` });
    if (!content) return res.status(400).json({ error: 'write something first' });
    if ([...content].length > config.maxMorelChars) {
      return res.status(400).json({ error: `a morel is ${config.maxMorelChars} characters at most` });
    }
    let tier = req.user.matter_tier;
    if (req.body.tier !== undefined) {
      tier = tierFromName(req.body.tier);
      if (tier === null) return res.status(400).json({ error: `tier is one of ${TIERS.join(', ')}` });
    }
    if (req.body.share !== undefined && typeof req.body.share !== 'boolean') return res.status(400).json({ error: 'share is true or false' });

    const id = newId();
    db.prepare(`INSERT INTO posts (id, user_id, content, tier, kind, title, shared, created_at)
      VALUES (?, ?, ?, ?, 'morel', ?, ?, ?)`).run(id, req.user.id, content, tier, title, req.body.share ? 1 : 0, Date.now());
    res.status(201).json(present(findPost.get({ id, viewer: req.user.id })));
  });

  // share a morel to feed as a card, or take the card back; the morel itself stays put
  router.patch('/api/morels/:id', requireUser, (req, res) => {
    const post = db.prepare('SELECT id, user_id, kind FROM posts WHERE id = ?').get(req.params.id);
    if (!post || post.kind !== 'morel') return res.status(404).json({ error: 'not found' });
    if (post.user_id !== req.user.id) {
      const visible = findPost.get({ id: post.id, viewer: req.user.id }).visible;
      return res.status(visible ? 403 : 404).json({ error: visible ? 'not yours' : 'not found' });
    }
    if (typeof req.body?.shared !== 'boolean') return res.status(400).json({ error: 'shared is true or false' });
    db.prepare('UPDATE posts SET shared = ? WHERE id = ?').run(req.body.shared ? 1 : 0, post.id);
    res.json(present(findPost.get({ id: post.id, viewer: req.user.id }), true));
  });

  // puffball: 1 short line of status on your profile; a new one replaces the old
  router.put('/api/me/puffball', requireUser, requireHandle, (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.replace(/\s+/g, ' ').trim() : '';
    if (!text) return res.status(400).json({ error: 'say something, or take it down' });
    if ([...text].length > PUFFBALL_CHARS) return res.status(400).json({ error: `a puffball is ${PUFFBALL_CHARS} characters at most` });
    const at = Date.now();
    db.prepare('UPDATE users SET puffball_text = ?, puffball_at = ? WHERE id = ?').run(text, at, req.user.id);
    res.json({ puffball: { text, set_at: toIso(at) } });
  });

  router.delete('/api/me/puffball', requireUser, (req, res) => {
    db.prepare('UPDATE users SET puffball_text = NULL, puffball_at = NULL WHERE id = ?').run(req.user.id);
    res.status(204).end();
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
    res.json({ posts: posts.map((row) => presentOwn(row)), ...page(req.query) });
  };
  router.get('/api/me/archive', requireUser, ownList('archived_at'));
  router.get('/api/me/bin', requireUser, ownList('binned_at'));
  router.delete('/api/me/bin', requireUser, (req, res) => {
    const removed = db.prepare('DELETE FROM posts WHERE user_id = ? AND binned_at IS NOT NULL').run(req.user.id).changes;
    res.json({ removed });
  });

  router.get('/api/spore/:handle', (req, res) => {
    const profile = db.prepare(`SELECT u.id, u.handle, u.email, u.profile_tier, u.created_at, u.puffball_text, u.puffball_at,
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
      puffball: profile.puffball_text ? { text: profile.puffball_text, set_at: toIso(profile.puffball_at) } : null,
      ...(profile.email_visible ? { email: profile.email } : {}),
      relation,
      posts: posts.map((row) => present(row)),
      ...page(req.query),
    });
  });

  return router;
}