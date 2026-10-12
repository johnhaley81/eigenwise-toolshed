// Real git on local disk, no network: the diff and tag questions only git can answer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { makeGitRepo } from '../release/test/realrepo.mjs';
import { formatTable, parseOptions, planRelease, run, versionChanges } from './release.mjs';

function setup(t) {
  const repo = makeGitRepo({ plugins: { alpha: '1.2.0', beta: '0.4.0' }, marketplaceVersion: '3.10.0' });
  t.after(repo.cleanup);
  repo.git('update-ref', 'refs/remotes/upstream/main', 'HEAD');
  return repo;
}

function readVersion(repo, relative) {
  return JSON.parse(readFileSync(path.join(repo.root, relative), 'utf8')).version;
}

function execute(repo, argv, options = {}) {
  const lines = [];
  run(argv, { cwd: repo.root, out: (line) => lines.push(line), ...options });
  return lines.join('\n');
}

test('a dry run prints the table and changes nothing', (t) => {
  const repo = setup(t);
  repo.write('plugins/alpha/index.js', '// forked\n');
  const head = repo.commit('fork change');

  const output = execute(repo, ['--dry-run']);

  assert.match(output, /alpha\s+1\.2\.0\s+1\.2\.0\s+1\.2\.1000\s+first fork number/);
  assert.match(output, /beta\s+0\.4\.0\s+0\.4\.0\s+0\.4\.0\s+identical to upstream/);
  assert.match(output, /\(marketplace\)\s+3\.10\.0\s+3\.10\.0\s+3\.10\.1000\s+first fork number/);
  assert.equal(repo.git('rev-parse', 'HEAD'), head);
  assert.equal(repo.git('status', '--porcelain'), '');
});

test('a change that only touches plugin.json does not make a plugin differ from upstream', (t) => {
  const repo = setup(t);
  repo.write('plugins/beta/.claude-plugin/plugin.json', `${JSON.stringify({ name: 'beta', version: '0.4.0', license: 'MIT', extra: true }, null, 2)}\n`);
  repo.commit('manifest only');

  assert.match(execute(repo, ['--dry-run']), /beta\s+0\.4\.0\s+0\.4\.0\s+0\.4\.0\s+identical to upstream/);
});

test('write makes one commit that moves the three version fields together and creates no tag', (t) => {
  const repo = setup(t);
  repo.write('plugins/alpha/index.js', '// forked\n');
  repo.commit('fork change');
  const before = repo.git('rev-list', '--count', 'HEAD');

  execute(repo, ['--write']);

  assert.equal(repo.git('rev-list', '--count', 'HEAD'), String(Number(before) + 1));
  assert.equal(repo.git('log', '-1', '--format=%s'), 'fork release fork-v3.10.1000');
  assert.equal(readVersion(repo, 'plugins/alpha/.claude-plugin/plugin.json'), '1.2.1000');
  assert.equal(readVersion(repo, '.claude-plugin/marketplace.json'), '3.10.1000');
  assert.equal(readVersion(repo, 'plugins/beta/.claude-plugin/plugin.json'), '0.4.0');
  assert.equal(repo.git('tag', '--list'), '');
  assert.equal(repo.git('status', '--porcelain'), '');
});

test('after the tag, an unchanged plugin keeps its number and a changed one moves up by one', (t) => {
  const repo = setup(t);
  repo.write('plugins/alpha/index.js', '// forked\n');
  repo.write('plugins/beta/index.js', '// forked\n');
  repo.commit('fork change');
  execute(repo, ['--write']);
  repo.git('tag', '-a', 'fork-v3.10.1000', '-m', 'fork release');

  repo.write('plugins/beta/index.js', '// forked again\n');
  repo.commit('more beta');
  const output = execute(repo, ['--write']);

  assert.match(output, /alpha\s+1\.2\.0\s+1\.2\.1000\s+1\.2\.1000\s+unchanged since last fork tag/);
  assert.match(output, /beta\s+0\.4\.0\s+0\.4\.1000\s+0\.4\.1001\s+changed since last fork tag/);
  assert.equal(readVersion(repo, 'plugins/alpha/.claude-plugin/plugin.json'), '1.2.1000');
  assert.equal(readVersion(repo, 'plugins/beta/.claude-plugin/plugin.json'), '0.4.1001');
  assert.equal(readVersion(repo, '.claude-plugin/marketplace.json'), '3.10.1001');
});

test('write with nothing to move makes no commit', (t) => {
  const repo = setup(t);
  const head = repo.git('rev-parse', 'HEAD');

  const output = execute(repo, ['--write']);

  assert.match(output, /Nothing moved/);
  assert.equal(repo.git('rev-parse', 'HEAD'), head);
});

test('a plugin upstream fully absorbed goes back to upstream number', (t) => {
  const repo = setup(t);
  repo.write('plugins/alpha/index.js', '// forked\n');
  repo.commit('fork change');
  execute(repo, ['--write']);
  repo.git('checkout', '-q', 'upstream/main', '--', 'plugins/alpha/index.js');
  repo.commit('upstream absorbed it');

  const output = execute(repo, ['--write']);

  assert.match(output, /alpha\s+1\.2\.0\s+1\.2\.1000\s+1\.2\.0\s+identical to upstream/);
  assert.equal(readVersion(repo, 'plugins/alpha/.claude-plugin/plugin.json'), '1.2.0');
  assert.equal(readVersion(repo, '.claude-plugin/marketplace.json'), '3.10.0');
});

test('write refuses a dirty working tree', (t) => {
  const repo = setup(t);
  repo.write('plugins/alpha/index.js', '// uncommitted\n');

  assert.throws(() => execute(repo, ['--write']), /uncommitted changes/);
});

test('a missing default upstream is fetched into a temporary ref that is removed again', (t) => {
  const repo = setup(t);
  repo.git('update-ref', '-d', 'refs/remotes/upstream/main');
  repo.write('plugins/alpha/index.js', '// forked\n');
  repo.commit('fork change');

  const output = execute(repo, ['--dry-run'], { upstreamUrl: repo.origin });

  assert.match(output, /alpha\s+1\.2\.0\s+1\.2\.0\s+1\.2\.1000/);
  assert.equal(repo.git('for-each-ref', 'refs/fork-release'), '');
});

test('a named upstream ref that does not exist is an error, not a fetch', (t) => {
  const repo = setup(t);

  assert.throws(() => execute(repo, ['--dry-run', '--upstream', 'nowhere/main']), /does not exist/);
});

test('exactly one of --dry-run and --write is required', () => {
  assert.throws(() => parseOptions([]), /exactly one/);
  assert.throws(() => parseOptions(['--dry-run', '--write']), /exactly one/);
  assert.equal(parseOptions(['--write']).upstream, 'upstream/main');
});

test('a plugin missing from upstream stops the plan', () => {
  const plugin = { name: 'solo', dir: 'plugins/solo', manifestPath: 'plugins/solo/.claude-plugin/plugin.json', pluginVersion: '1.0.0' };
  const current = { version: '1.0.0', plugins: new Map([['solo', plugin]]) };
  const upstream = { version: '1.0.0', plugins: new Map() };

  assert.throws(() => planRelease({ upstream, current, facts: {} }), /not in upstream/);
});

test('the table and the version changes come from the same plan', () => {
  const plan = {
    rows: [
      { name: 'alpha', upstream: '1.0.0', current: '1.0.0', next: '1.0.1000', reason: 'first fork number' },
      { name: 'beta', upstream: '2.0.0', current: '2.0.0', next: '2.0.0', reason: 'identical to upstream' },
    ],
    marketplace: { name: '(marketplace)', upstream: '3.0.0', current: '3.0.0', next: '3.0.1000', reason: 'first fork number' },
  };

  assert.deepEqual(versionChanges(plan), { plugins: [{ name: 'alpha', from: '1.0.0', to: '1.0.1000' }], marketplaceVersion: '3.0.1000' });
  assert.equal(formatTable(plan).split('\n').length, 4);
});
