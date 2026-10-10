CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
    handle TEXT UNIQUE CHECK (
      handle IS NULL OR (length(handle) BETWEEN 3 AND 20 AND handle NOT GLOB '*[^a-z0-9_]*')
    ),
    profile_tier INTEGER NOT NULL DEFAULT 0 CHECK (profile_tier BETWEEN 0 AND 3),
    matter_tier INTEGER NOT NULL DEFAULT 0 CHECK (matter_tier BETWEEN 0 AND 3),
    email_tier INTEGER NOT NULL DEFAULT 3 CHECK (email_tier BETWEEN 0 AND 3),
    password_hash TEXT,
    bin_days INTEGER DEFAULT 30 CHECK (bin_days IS NULL OR bin_days IN (3, 7, 14, 30)),
    created_at INTEGER NOT NULL,
    disabled_at INTEGER
  );

  CREATE TABLE login_tokens (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX login_tokens_expiry ON login_tokens (expires_at);

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions (user_id);
  CREATE INDEX sessions_expiry ON sessions (expires_at);

  CREATE TABLE posts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    tier INTEGER NOT NULL DEFAULT 0 CHECK (tier BETWEEN 0 AND 3),
    parent_id TEXT REFERENCES posts (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    archived_at INTEGER,
    binned_at INTEGER,
    CHECK (archived_at IS NULL OR binned_at IS NULL)
  );
  CREATE INDEX posts_feed ON posts (parent_id, tier, created_at);
  CREATE INDEX posts_author ON posts (user_id, created_at);
  CREATE INDEX posts_replies ON posts (parent_id, created_at);
  CREATE INDEX posts_binned ON posts (binned_at) WHERE binned_at IS NOT NULL;

  CREATE TABLE follows (
    follower_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    followee_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (follower_id, followee_id),
    CHECK (follower_id <> followee_id)
  ) WITHOUT ROWID;
  CREATE INDEX follows_followee ON follows (followee_id);

  -- one row per pair in either direction. a request until accepted_at is set
  CREATE TABLE friends (
    requester_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    addressee_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    accepted_at INTEGER,
    PRIMARY KEY (requester_id, addressee_id),
    CHECK (requester_id <> addressee_id)
  ) WITHOUT ROWID;
  CREATE UNIQUE INDEX friends_pair ON friends (min(requester_id, addressee_id), max(requester_id, addressee_id));
  CREATE INDEX friends_addressee ON friends (addressee_id);

  CREATE TABLE blocks (
    blocker_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    blocked_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id <> blocked_id)
  ) WITHOUT ROWID;
  CREATE INDEX blocks_blocked ON blocks (blocked_id);

  -- a provider account (github, google, apple) tied to a spore account
  CREATE TABLE identities (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (provider, subject)
  ) WITHOUT ROWID;
  CREATE INDEX identities_user ON identities (user_id);

  -- the allowlist beta's waiting room. an approved row lets its address sign up
  CREATE TABLE access_requests (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL CHECK (email = lower(email)),
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE UNIQUE INDEX access_requests_open ON access_requests (email) WHERE status <> 'declined';

  PRAGMA user_version = 1;
