#!/usr/bin/env node
// Fork-only. Numbers a release of the `live` branch so it never collides with upstream's versions.
// It never tags, pushes, or touches release fragments, so `live` keeps merging cleanly with upstream.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { createGit } from '../release/lib/git.mjs';
import { applyVersions, checkManifest, readManifest } from '../release/lib/manifests.mjs';
import { commitSource } from '../release/lib/treesource.mjs';
import { nextForkVersion, nextMarketplaceVersion } from './version-rule.mjs';

export const DEFAULT_UPSTREAM = 'upstream/main';
export const UPSTREAM_URL = 'https://github.com/Eigenwise/eigenwise-toolshed.git';
const TEMP_UPSTREAM_REF = 'refs/fork-release/upstream';
const HEADER = ['plugin', 'upstream', 'current', 'next', 'reason'];

export function fetchUpstream(git, url = UPSTREAM_URL) {
  git.invoke(['fetch', '--no-tags', url, `+main:${TEMP_UPSTREAM_REF}`]);
  const sha = git.revParse(TEMP_UPSTREAM_REF);
  git.invoke(['update-ref', '-d', TEMP_UPSTREAM_REF]);
  return sha;
}

// Only the default ref falls back to a fetch: a ref the caller named that is missing is a typo,
// and silently numbering against some other upstream would write wrong versions.
export function resolveUpstream(git, ref, url) {
  const probe = git.invoke(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
  if (probe.code === 0) return probe.stdout.trim();
  if (ref !== DEFAULT_UPSTREAM) throw new Error(`upstream ref "${ref}" does not exist`);
  return fetchUpstream(git, url);
}

export function lastForkTag(git) {
  const result = git.invoke(['describe', '--tags', '--abbrev=0', '--match', 'fork-v*', 'HEAD'], { allowFail: true });
  return result.code === 0 ? result.stdout.trim() : null;
}

// plugin.json is the file this script rewrites, so counting it would make every release differ
// from upstream by construction.
function pluginDiff(git, base, plugin) {
  return git.capture(['diff', '--name-only', base, 'HEAD', '--', plugin.dir, `:(exclude)${plugin.manifestPath}`]) !== '';
}

export function gitFacts(git, upstreamSha, tag) {
  return {
    differs: (plugin) => pluginDiff(git, upstreamSha, plugin),
    changedSince: (plugin) => tag === null || pluginDiff(git, tag, plugin),
  };
}

function planPlugin(plugin, upstream, facts) {
  const upstreamPlugin = upstream.plugins.get(plugin.name);
  if (!upstreamPlugin) throw new Error(`plugin "${plugin.name}" is not in upstream, so there is no upstream number to build a fork number on`);
  const differs = facts.differs(plugin);
  const next = nextForkVersion({
    upstream: upstreamPlugin.pluginVersion,
    current: plugin.pluginVersion,
    differs,
    changedSinceTag: differs && facts.changedSince(plugin),
  });
  return { name: plugin.name, upstream: upstreamPlugin.pluginVersion, current: plugin.pluginVersion, next: next.version, reason: next.reason, differs };
}

const moved = (row) => row.next !== row.current;

export function planRelease({ upstream, current, facts }) {
  const rows = [...current.plugins.values()].map((plugin) => planPlugin(plugin, upstream, facts));
  const next = nextMarketplaceVersion({
    upstream: upstream.version,
    current: current.version,
    anyForked: rows.some((row) => row.differs),
    anyMoved: rows.some(moved),
  });
  const marketplace = { name: '(marketplace)', upstream: upstream.version, current: current.version, next: next.version, reason: next.reason };
  return { rows, marketplace };
}

export function versionChanges({ rows, marketplace }) {
  return {
    plugins: rows.filter(moved).map((row) => ({ name: row.name, from: row.current, to: row.next })),
    marketplaceVersion: moved(marketplace) ? marketplace.next : null,
  };
}

export function formatTable({ rows, marketplace }) {
  const lines = [HEADER, ...[...rows, marketplace].map((row) => [row.name, row.upstream, row.current, row.next, row.reason])];
  const widths = HEADER.map((_, column) => Math.max(...lines.map((line) => line[column].length)));
  return lines.map((line) => line.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd()).join('\n');
}

function loadPlan(git, cwd, upstreamRef, upstreamUrl) {
  const upstreamSha = resolveUpstream(git, upstreamRef, upstreamUrl);
  const upstream = readManifest(commitSource(git, upstreamSha), cwd);
  const current = readManifest(commitSource(git, git.revParse('HEAD')), cwd);
  const errors = [upstream, current].flatMap(checkManifest);
  if (errors.length > 0) throw new Error(`manifest check failed:\n${errors.join('\n')}`);
  return { current, plan: planRelease({ upstream, current, facts: gitFacts(git, upstreamSha, lastForkTag(git)) }) };
}

function writeRelease(git, cwd, current, plan, out) {
  const changes = versionChanges(plan);
  if (changes.plugins.length === 0) return out('Nothing moved; no commit made.');
  git.add(applyVersions(cwd, current, changes));
  git.commit(`fork release fork-v${plan.marketplace.next}`);
  return out(`Committed fork release fork-v${plan.marketplace.next}. Tag and push it yourself.`);
}

export function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
      upstream: { type: 'string', default: DEFAULT_UPSTREAM },
    },
  });
  if (values['dry-run'] === values.write) throw new Error('pass exactly one of --dry-run or --write');
  return values;
}

export function run(argv, { cwd = process.cwd(), out = console.log, upstreamUrl = UPSTREAM_URL } = {}) {
  const options = parseOptions(argv);
  // Pathspecs and file writes are repo-relative, so a run from a subdirectory would look in the wrong place.
  const root = createGit({ cwd }).capture(['rev-parse', '--show-toplevel']);
  const git = createGit({ cwd: root });
  if (options.write && !git.isClean()) throw new Error('the working tree has uncommitted changes; commit or stash them before --write');
  const { current, plan } = loadPlan(git, root, options.upstream, upstreamUrl);
  out(formatTable(plan));
  if (options.write) writeRelease(git, root, current, plan, out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
