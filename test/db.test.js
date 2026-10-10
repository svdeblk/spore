import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, purgeExpired, newId, hashToken, toIso } from '../lib/db.js';

function addUser(db, email, handle = null) {
  const id = newId();
  db.prepare('INSERT INTO users (id, email, handle, created_at) VALUES (?, ?, ?, ?)').run(id, email, handle, Date.now());
  return id;
}

function addPost(db, userId, parentId = null) {
  const id = newId();
  db.prepare('INSERT INTO posts (id, user_id, content, tier, parent_id, created_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run(id, userId, 'matter', parentId, Date.now());
  return id;
}

const count = (db, table) => db.prepare(`SELECT count(*) FROM ${table}`).pluck().get();

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'spore.db');
}

test('the schema creates cleanly with its pragmas', () => {
  const db = openDb(':memory:');
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").pluck().all();
  assert.deepEqual(tables, ['access_requests', 'blocks', 'follows', 'friends', 'identities', 'login_tokens', 'posts', 'sessions', 'users']);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('a database file uses wal and reopens without reapplying the schema', (t) => {
  const file = tempFile(t);
  const first = openDb(file);
  assert.equal(first.pragma('journal_mode', { simple: true }), 'wal');
  addUser(first, 'a@example.com');
  first.close();

  const second = openDb(file);
  assert.equal(count(second, 'users'), 1);
  second.close();
});

test('a database from before schema 1 is refused not written to', (t) => {
  const file = tempFile(t);
  const old = new Database(file);
  old.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, handle TEXT, created_at TEXT)');
  old.close();

  assert.throws(() => openDb(file), /from before schema 1/);
  const check = new Database(file);
  assert.equal(check.pragma('user_version', { simple: true }), 0);
  check.close();
});

test('a database newer than the code is refused', (t) => {
  const file = tempFile(t);
  const newer = new Database(file);
  newer.pragma('user_version = 3');
  newer.close();
  assert.throws(() => openDb(file), /newer than this code/);
});

test('deleting a post removes its replies', () => {
  const db = openDb(':memory:');
  const author = addUser(db, 'a@example.com', 'alice');
  const replier = addUser(db, 'b@example.com', 'bob');
  const root = addPost(db, author);
  addPost(db, replier, root);
  addPost(db, author, root);
  const other = addPost(db, author);

  db.prepare('DELETE FROM posts WHERE id = ?').run(root);
  assert.deepEqual(db.prepare('SELECT id FROM posts').pluck().all(), [other]);
});

test('deleting a user removes their sessions, posts, and replies to those posts', () => {
  const db = openDb(':memory:');
  const gone = addUser(db, 'a@example.com', 'alice');
  const stays = addUser(db, 'b@example.com', 'bob');
  const root = addPost(db, gone);
  addPost(db, stays, root);
  const kept = addPost(db, stays);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(hashToken('t'), gone, Date.now() + 1000, Date.now());

  db.prepare('DELETE FROM users WHERE id = ?').run(gone);
  assert.equal(count(db, 'sessions'), 0);
  assert.deepEqual(db.prepare('SELECT id FROM posts').pluck().all(), [kept]);
});

test('a reply to a missing post is rejected', () => {
  const db = openDb(':memory:');
  const author = addUser(db, 'a@example.com', 'alice');
  assert.throws(() => addPost(db, author, newId()), /FOREIGN KEY/);
});

test('expired login tokens and sessions purge, live ones stay', () => {
  const db = openDb(':memory:');
  const user = addUser(db, 'a@example.com');
  const now = Date.now();
  const token = db.prepare('INSERT INTO login_tokens (token_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)');
  const session = db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)');
  token.run(hashToken('old'), 'a@example.com', now - 1, now);
  token.run(hashToken('edge'), 'a@example.com', now, now);
  token.run(hashToken('live'), 'a@example.com', now + 1, now);
  session.run(hashToken('old'), user, now - 1, now);
  session.run(hashToken('live'), user, now + 60_000, now);

  assert.deepEqual(purgeExpired(db, now), { loginTokens: 2, sessions: 1, binned: 0 });
  assert.deepEqual(db.prepare('SELECT token_hash FROM login_tokens').pluck().all(), [hashToken('live')]);
  assert.deepEqual(db.prepare('SELECT token_hash FROM sessions').pluck().all(), [hashToken('live')]);
});

test('emails must be stored lowercase and handles must follow the handle rule', () => {
  const db = openDb(':memory:');
  assert.throws(() => addUser(db, 'Alice@Example.com'), /CHECK constraint/);
  for (const bad of ['ab', 'a'.repeat(21), 'Alice', 'al-ice', 'al ice']) {
    assert.throws(() => addUser(db, `${newId()}@example.com`, bad), /CHECK constraint/, bad);
  }
  addUser(db, 'a@example.com', 'a_1');
  assert.throws(() => addUser(db, 'b@example.com', 'a_1'), /UNIQUE constraint/);
  assert.throws(() => addUser(db, 'a@example.com'), /UNIQUE constraint/);
});

test('ids are 24 hex characters, hashes are sha-256, times are iso 8601 in utc', () => {
  assert.match(newId(), /^[0-9a-f]{24}$/);
  assert.equal(hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(toIso(0), '1970-01-01T00:00:00.000Z');
});

// frozen schema 1 = what the live server's db was made from
const SCHEMA_ONE = fs.readFileSync(new URL('./fixtures/schema-v1.sql', import.meta.url), 'utf8');

function describeTables(db) {
  const out = {};
  for (const table of db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").pluck().all()) {
    out[table] = db.pragma(`table_info(${table})`)
      .map((c) => `${c.name} ${c.type} ${c.notnull ? 'not null' : ''} ${c.dflt_value ?? ''}`.trim())
      .sort();
  }
  return out;
}

test('a schema 1 database is upgraded in place, keeps its rows, and ends up the same as a fresh one', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-migrate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'spore.db');

  const old = new Database(file);
  old.exec(SCHEMA_ONE);
  assert.equal(old.pragma('user_version', { simple: true }), 1);
  const user = addUser(old, 'old@example.com', 'oldtimer');
  const post = newId();
  old.prepare('INSERT INTO posts (id, user_id, content, tier, created_at) VALUES (?, ?, ?, 2, ?)').run(post, user, 'written before the upgrade', 1000);
  old.close();

  const upgraded = openDb(file);
  assert.equal(upgraded.pragma('user_version', { simple: true }), 2);
  assert.deepEqual(upgraded.prepare('SELECT content, tier, kind, title, shared FROM posts WHERE id = ?').get(post),
    { content: 'written before the upgrade', tier: 2, kind: 'matter', title: null, shared: 0 });
  assert.deepEqual(upgraded.prepare('SELECT puffball_text, puffball_at FROM users WHERE id = ?').get(user), { puffball_text: null, puffball_at: null });
  const fresh = openDb(':memory:');
  assert.deepEqual(describeTables(upgraded), describeTables(fresh));
  fresh.close();
  assert.throws(() => upgraded.prepare("UPDATE posts SET kind = 'essay'").run(), /CHECK/);
  assert.throws(() => upgraded.prepare('UPDATE posts SET shared = 2').run(), /CHECK/);
  assert.equal(upgraded.pragma('integrity_check', { simple: true }), 'ok');

  // opening again changes nothing
  upgraded.close();
  const again = openDb(file);
  assert.equal(again.pragma('user_version', { simple: true }), 2);
  again.close();
});
