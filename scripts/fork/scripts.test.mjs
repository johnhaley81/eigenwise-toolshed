// Real git against local bare remotes, no network: the released-code guard only means something if it runs on real merge and cherry-pick behavior.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

test('every fork shell script parses', () => {
  const scripts = readdirSync(here).filter((name) => name.endsWith('.sh'));
  assert.ok(scripts.length > 0);
  for (const name of scripts) {
    const result = spawnSync('bash', ['-n', path.join(here, name)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});

// Isolates git from the developer's own configuration: signing or hooks there would make the scripts' commits fail or differ between machines.
function makeFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fork-scripts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tmp = path.join(root, 'tmp');
  mkdirSync(tmp);
  const repo = path.join(root, 'repo');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Fork Test',
    GIT_AUTHOR_EMAIL: 'fork-test@example.com',
    GIT_COMMITTER_NAME: 'Fork Test',
    GIT_COMMITTER_EMAIL: 'fork-test@example.com',
    HOME: root,
    TMPDIR: tmp,
    TOOLSHED_REPO: repo,
  };

  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const originGit = (...args) => git(path.join(root, 'origin.git'), ...args);
  const write = (relative, text) => {
    const file = path.join(repo, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const commit = (message) => {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', message);
    return git(repo, 'rev-parse', 'HEAD');
  };
  // The PR branches live on origin only, like the fork's real ones, so the scripts must fetch them.
  const prBranch = (name, base, work) => {
    git(repo, 'checkout', '-q', '-b', name, base);
    work();
    git(repo, 'push', '-q', 'origin', name);
    git(repo, 'checkout', '-q', 'main');
  };
  const run = (script, ...args) => {
    const result = spawnSync('bash', [path.join(here, script), ...args], { cwd: repo, env, encoding: 'utf8' });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  };

  git(root, 'init', '-q', '--bare', '-b', 'main', 'upstream.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(root, 'init', '-q', '-b', 'main', 'repo');
  git(repo, 'remote', 'add', 'upstream', path.join(root, 'upstream.git'));
  git(repo, 'remote', 'add', 'origin', path.join(root, 'origin.git'));

  write('base.txt', 'one\ntwo\n');
  commit('released base');
  git(repo, 'push', '-q', 'upstream', 'main');

  git(repo, 'checkout', '-q', '-b', 'develop');
  write('dev.txt', 'alpha\nbeta\ngamma\n');
  commit('develop only');
  git(repo, 'push', '-q', 'upstream', 'develop');
  git(repo, 'checkout', '-q', 'main');

  git(repo, 'checkout', '-q', '-b', 'live');
  write('fork.txt', 'fork only\n');
  commit('fork only file');
  git(repo, 'push', '-q', 'origin', 'live');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'fetch', '-q', 'upstream');

  return {
    root,
    repo,
    git: (...args) => git(repo, ...args),
    originGit,
    write,
    commit,
    prBranch,
    run,
    liveTip: () => originGit('rev-parse', 'live'),
    liveHas: (file) => originGit('cat-file', '-e', `live:${file}`) === '',
    liveLacks: (file) => spawnSync('git', ['cat-file', '-e', `live:${file}`], { cwd: path.join(root, 'origin.git'), env, encoding: 'utf8' }).status !== 0,
  };
}

test('merge mode merges a branch built only on released code and pushes live', (t) => {
  const fx = makeFixture(t);
  fx.prBranch('fix/released', 'upstream/main', () => {
    fx.write('released-fix.txt', 'fix\n');
    fx.commit('fix on released code');
  });
  const before = fx.liveTip();

  const result = fx.run('live-merge.sh', 'fix/released');

  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /merge fix\/released into live/);
  assert.notEqual(fx.liveTip(), before);
  assert.ok(fx.liveHas('released-fix.txt'));
  assert.ok(fx.liveHas('fork.txt'));
  assert.equal(fx.originGit('rev-list', '--parents', '-n', '1', 'live').split(' ').length, 3, 'a merge commit has two parents');
  assert.equal(fx.originGit('rev-parse', 'live^1'), before);
});

test('merge mode refuses a branch that carries an unreleased develop commit and leaves live alone', (t) => {
  const fx = makeFixture(t);
  fx.prBranch('fix/on-develop', 'upstream/develop', () => {
    fx.write('own.txt', 'own\n');
    fx.commit('the PR own commit');
  });
  const before = fx.liveTip();

  const result = fx.run('live-merge.sh', 'fix/on-develop');

  assert.equal(result.status, 3, result.out);
  assert.match(result.out, /REFUSED: fix\/on-develop carries 1 Eigenwise develop commit/);
  assert.match(result.out, /live-merge\.sh --pick fix\/on-develop/);
  assert.equal(fx.liveTip(), before);
});

test('pick mode copies only the PR own commits and pushes live', (t) => {
  const fx = makeFixture(t);
  fx.prBranch('fix/on-develop', 'upstream/develop', () => {
    fx.write('own.txt', 'own\n');
    fx.commit('the PR own commit');
  });
  const before = fx.liveTip();

  const result = fx.run('live-merge.sh', '--pick', 'fix/on-develop');

  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /pick fix\/on-develop into live/);
  assert.equal(fx.originGit('rev-list', '--count', `${before}..live`), '1');
  assert.equal(fx.originGit('log', '-1', '--format=%s', 'live'), 'the PR own commit');
  assert.ok(fx.liveHas('own.txt'));
  assert.ok(fx.liveLacks('dev.txt'), 'the unreleased develop file must not reach live');
});

test('pick mode exits 2 and pushes nothing when the PR edits a line only develop has', (t) => {
  const fx = makeFixture(t);
  fx.prBranch('fix/needs-develop', 'upstream/develop', () => {
    fx.write('dev.txt', 'alpha\nbeta fixed\ngamma\n');
    fx.commit('edit a develop-only line');
  });
  const before = fx.liveTip();

  const result = fx.run('live-merge.sh', '--pick', 'fix/needs-develop');

  assert.equal(result.status, 2, result.out);
  assert.match(result.out, /CONFLICT picking .*edit a develop-only line into live: dev\.txt/);
  assert.equal(fx.liveTip(), before);
});

test('pick mode pushes nothing when a board fragment commit and its strip commit cancel out', (t) => {
  const fx = makeFixture(t);
  fx.prBranch('fix/fragment-only', 'upstream/main', () => {
    fx.write('.release/unreleased/SQ-9.md', 'board-only note\n');
    fx.commit('SQ-9: board fragment');
    fx.git('rm', '-q', '.release/unreleased/SQ-9.md');
    fx.commit('release: drop the board-only SQ-9 fragment');
  });
  const before = fx.liveTip();

  const result = fx.run('live-merge.sh', '--pick', 'fix/fragment-only');

  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /change nothing in live; nothing pushed/);
  assert.equal(fx.liveTip(), before);
});

// A candidate that contains the fragment and a second commit that is not on the target branch yet, as a handback from an executor looks.
function makeCandidate(fx) {
  fx.git('checkout', '-q', '-b', 'candidate', 'main');
  fx.write('feature.txt', 'feature\n');
  fx.write('.release/unreleased/SQ-9.md', 'board-only note\n');
  const sha = fx.commit('SQ-9: the change');
  fx.git('checkout', '-q', 'main');
  return sha;
}

test('push-handback strips the board fragment when the target branch is not checked out', (t) => {
  const fx = makeFixture(t);
  const candidate = makeCandidate(fx);
  fx.git('branch', 'fix/handback', 'main');

  const result = fx.run('push-handback.sh', 'SQ-9', candidate, 'fix/handback');

  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /SQ-9 pushed [0-9a-f]{40} -> fix\/handback \(checked out\)/);
  const tip = fx.originGit('rev-parse', 'fix/handback');
  assert.equal(fx.originGit('rev-parse', `${tip}^`), candidate);
  assert.equal(fx.originGit('cat-file', '-e', `${tip}:feature.txt`), '');
  assert.notEqual(spawnSync('git', ['cat-file', '-e', `${tip}:.release/unreleased/SQ-9.md`], { cwd: path.join(fx.root, 'origin.git') }).status, 0);
  assert.equal(fx.git('rev-parse', '--abbrev-ref', 'HEAD'), 'fix/handback');
  assert.equal(fx.git('rev-parse', 'HEAD'), tip);
});

test('push-handback also works when the target branch is the one checked out', (t) => {
  const fx = makeFixture(t);
  const candidate = makeCandidate(fx);
  fx.git('checkout', '-q', '-b', 'fix/handback', 'main');

  const result = fx.run('push-handback.sh', 'SQ-9', candidate, 'fix/handback');

  assert.equal(result.status, 0, result.out);
  const tip = fx.originGit('rev-parse', 'fix/handback');
  assert.equal(fx.git('rev-parse', '--abbrev-ref', 'HEAD'), 'fix/handback');
  assert.equal(fx.git('rev-parse', 'HEAD'), tip);
  assert.equal(fx.git('status', '--porcelain'), '');
  assert.equal(fx.git('ls-files', '.release'), '');
});

test('push-handback pushes the candidate itself when it carries no fragment', (t) => {
  const fx = makeFixture(t);
  fx.git('checkout', '-q', '-b', 'candidate', 'main');
  fx.write('feature.txt', 'feature\n');
  const candidate = fx.commit('SQ-9: the change');
  fx.git('checkout', '-q', 'main');

  const result = fx.run('push-handback.sh', 'SQ-9', candidate, 'fix/handback');

  assert.equal(result.status, 0, result.out);
  assert.equal(fx.originGit('rev-parse', 'fix/handback'), candidate);
});
