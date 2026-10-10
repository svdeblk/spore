import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// runs deploy/spore-deploy vs a throwaway remote, clone & data dir; stand-ins for the server parts:
// sudo, systemctl, corepack, curl, sqlite3 cli. app is healthy when its `health` file says ok,
// so a commit can be made good or broken

const SCRIPT = new URL('../deploy/spore-deploy', import.meta.url).pathname;

function sh(cwd, command) {
  const result = spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command}\n${result.stderr}`);
  return result.stdout.trim();
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-deploy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const stub = (name, body) => {
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  };
  const log = path.join(root, 'calls.log');
  const app = path.join(root, 'app');
  const data = path.join(root, 'data');

  stub('sudo', 'shift 2; exec "$@"');
  stub('corepack', `echo "install" >> "${log}"`);
  stub('sqlite3', `cp "$1" "\${2#.backup }"`);
  stub('curl', `grep -qx ok "${app}/health"`);
  // restarting a broken version leaves the db changed, as a migration would
  stub('systemctl', `echo "$*" >> "${log}"
if [ "$1" = restart ] && grep -qx broken "${app}/health"; then echo "changed by the broken version" > "${data}/spore.db"; fi`);

  const remote = path.join(root, 'remote.git');
  const git = (cwd, command) => sh(cwd, `git -c user.name=t -c user.email=t@example.com ${command}`);
  fs.mkdirSync(remote);
  git(remote, 'init -q --bare -b main');
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  git(work, 'init -q -b main');
  fs.writeFileSync(path.join(work, 'health'), 'ok\n');
  git(work, 'add -A');
  git(work, 'commit -q -m first');
  git(work, `remote add origin ${remote}`);
  git(work, 'push -q origin main');
  git(root, `clone -q ${remote} ${app}`);
  fs.mkdirSync(path.join(data, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(data, 'spore.db'), 'the data\n');

  let pushes = 0;
  const push = (health) => {
    fs.writeFileSync(path.join(work, 'health'), `${health}\n`);
    fs.writeFileSync(path.join(work, 'n'), `${(pushes += 1)}\n`);
    git(work, 'add -A');
    git(work, 'commit -q -m next');
    git(work, 'push -q origin main');
    return git(work, 'rev-parse HEAD');
  };
  const run = () => {
    const result = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SPORE_APP: app, SPORE_DATA: data, SPORE_LOCK: path.join(root, 'lock'), SPORE_WAIT: '0', SPORE_PORT: '1',
      },
    });
    return { status: result.status, out: result.stdout + result.stderr };
  };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
  const head = () => git(app, 'rev-parse HEAD');
  return { data, push, run, calls, head, app };
}

test('with nothing new it changes nothing', (t) => {
  const s = setup(t);
  const before = s.head();
  const { status, out } = s.run();
  assert.equal(status, 0);
  assert.match(out, /up to date at/);
  assert.equal(s.calls(), '');
  assert.equal(s.head(), before);
});

test('a good update installs, restarts, and keeps a backup of the database it started from', (t) => {
  const s = setup(t);
  const next = s.push('ok');
  const { status, out } = s.run();
  assert.equal(status, 0, out);
  assert.match(out, /now running/);
  assert.equal(s.head(), next);
  assert.match(s.calls(), /install\nrestart spore/);
  const backups = fs.readdirSync(path.join(s.data, 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(s.data, 'backups', backups[0]), 'utf8'), 'the data\n');
  assert.equal(fs.existsSync(path.join(s.data, '.failed-commit')), false);
});

test('a version that does not come up is rolled back, with the database it started from', (t) => {
  const s = setup(t);
  const before = s.head();
  const broken = s.push('broken');
  const { status, out } = s.run();
  assert.equal(status, 1);
  assert.match(out, /did not come up, going back/);
  assert.match(out, /restored the database/);
  assert.equal(s.head(), before, 'the code is back where it was');
  assert.equal(fs.readFileSync(path.join(s.data, 'spore.db'), 'utf8'), 'the data\n', 'and so is the database');
  assert.equal(fs.readFileSync(path.join(s.data, '.failed-commit'), 'utf8').trim(), broken);
  assert.match(s.calls(), /stop spore/);

  // skips that commit from now on instead of restarting every 5 min
  const calls = s.calls();
  const again = s.run();
  assert.equal(again.status, 0);
  assert.match(again.out, /failed before and is skipped/);
  assert.equal(s.calls(), calls);

  // newer commit is tried again; a good one clears the mark
  const fixed = s.push('ok');
  const last = s.run();
  assert.equal(last.status, 0, last.out);
  assert.equal(s.head(), fixed);
  assert.equal(fs.existsSync(path.join(s.data, '.failed-commit')), false);
});

test('only ten backups are kept', (t) => {
  const s = setup(t);
  for (let i = 0; i < 12; i += 1) {
    s.push('ok');
    assert.equal(s.run().status, 0);
  }
  assert.equal(fs.readdirSync(path.join(s.data, 'backups')).length, 10);
});
