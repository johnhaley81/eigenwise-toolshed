'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MARKETPLACE_URL,
  manifestUrl,
  readCache,
  refreshCache,
  requestManifest,
} =require('../hooks/marketplace-freshness-cache.js');
const { decide: decideUserPrompt } = require('../hooks/user-prompt-freshness.js');
const { decide: decideStop } = require('../hooks/stop-update-check.js');

const FORK_URL = 'https://raw.githubusercontent.com/johnhaley81/eigenwise-toolshed/live/.claude-plugin/marketplace.json';
const FORK_BASE_URL = FORK_URL.replace('marketplace.json', 'fork-base.json');
const NOW = 1_000_000;

function tempHome(testContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-source-'));
  testContext.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeJson(home, relative, value) {
  const file = path.join(home, '.claude', ...relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

function registerSource(home, source) {
  writeJson(home, ['plugins', 'known_marketplaces.json'], { 'eigenwise-toolshed': { source } });
}

function registerFork(home) {
  registerSource(home, { source: 'github', repo: 'johnhaley81/eigenwise-toolshed', ref: 'live' });
}

function installSidequest(home, version = '5.9.1000') {
  writeJson(home, ['plugins', 'installed_plugins.json'], {
    plugins: { 'sidequest@eigenwise-toolshed': [{ scope: 'user', version }] },
  });
}

function manifestWith(version) {
  return { plugins: [{ name: 'sidequest', version }] };
}

function upstreamAt(version) {
  return { version, plugins: [] };
}

function forkBase(marketplaceVersion, upstream = { repo: 'Eigenwise/eigenwise-toolshed', ref: 'main' }) {
  return { upstream, marketplaceVersion };
}

// Fork 5.9.1000 is installed and the fork manifest is unchanged, so only the sync check can speak.
function syncScenario(testContext, answers, failing) {
  const home = tempHome(testContext);
  registerFork(home);
  installSidequest(home);
  return { home, ...stubRequest({ [FORK_URL]: manifestWith('5.9.1000'), ...answers }, failing) };
}

// Stands in for https.get: answers only the URLs it was given and records every URL asked for.
function stubRequest(manifests, failing = []) {
  const requested = [];
  const request = (url, _options, onResponse) => {
    requested.push(url);
    if (failing.includes(url)) return { setTimeout: () => {}, on: (_event, onError) => setImmediate(() => onError(new Error('offline'))), destroy: () => {} };
    const incoming = new EventEmitter();
    incoming.setEncoding = () => {};
    incoming.statusCode = manifests[url] ? 200 : 404;
    setImmediate(() => {
      onResponse(incoming);
      incoming.emit('data', JSON.stringify(manifests[url] || {}));
      incoming.emit('end');
    });
    return { setTimeout: () => {}, on: () => {}, destroy: () => {} };
  };
  return { request, requested };
}

function hookOptions(home, extras = {}) {
  return {
    home,
    now: NOW,
    loadedVersionStateDirectory: path.join(home, 'loaded'),
    warningStateDirectory: path.join(home, 'warnings'),
    warnedStates: new Set(),
    ...extras,
  };
}

async function stopMessage(home, request) {
  const output = await decideStop({ cwd: home, session_id: 'source-session' }, hookOptions(home, { request }));
  return output ? JSON.parse(output).systemMessage : '';
}

async function promptMessage(home, request) {
  await refreshCache({ home, now: NOW, request });
  const output = decideUserPrompt({ cwd: home, prompt: 'carry on', session_id: 'source-session' }, hookOptions(home));
  return output ? JSON.parse(output).hookSpecificOutput.additionalContext : '';
}

test('maps a github source with a ref to that ref', (testContext) => {
  const home = tempHome(testContext);
  registerFork(home);
  assert.equal(manifestUrl(fs, home), FORK_URL);
});

test('maps a github source without a ref to main', (testContext) => {
  const home = tempHome(testContext);
  registerSource(home, { source: 'github', repo: 'johnhaley81/eigenwise-toolshed' });
  assert.equal(manifestUrl(fs, home), FORK_URL.replace('/live/', '/main/'));
});

test('maps a git source that is a github repository', (testContext) => {
  const home = tempHome(testContext);
  registerSource(home, { source: 'git', url: 'https://github.com/johnhaley81/eigenwise-toolshed.git', ref: 'live' });
  assert.equal(manifestUrl(fs, home), FORK_URL);
  registerSource(home, { source: 'git', url: 'git@github.com:johnhaley81/eigenwise-toolshed.git' });
  assert.equal(manifestUrl(fs, home), FORK_URL.replace('/live/', '/main/'));
});

test('falls back to upstream for a git source outside github or any other source', (testContext) => {
  const home = tempHome(testContext);
  registerSource(home, { source: 'git', url: 'https://git.example.com/johnhaley81/eigenwise-toolshed.git' });
  assert.equal(manifestUrl(fs, home), MARKETPLACE_URL);
  registerSource(home, { source: 'directory', path: '/srv/eigenwise-toolshed' });
  assert.equal(manifestUrl(fs, home), MARKETPLACE_URL);
});

test('falls back to upstream when the registry is missing, unreadable or lacks the marketplace', (testContext) => {
  const home = tempHome(testContext);
  assert.equal(manifestUrl(fs, home), MARKETPLACE_URL);
  writeJson(home, ['plugins', 'known_marketplaces.json'], '{not json');
  assert.equal(manifestUrl(fs, home), MARKETPLACE_URL);
  writeJson(home, ['plugins', 'known_marketplaces.json'], { other: { source: { source: 'github', repo: 'a/b' } } });
  assert.equal(manifestUrl(fs, home), MARKETPLACE_URL);
});

test('treats a cache written for another URL as absent and a cache without a URL as upstream', (testContext) => {
  const home = tempHome(testContext);
  const cache = { checkedAt: new Date(NOW).toISOString(), manifest: manifestWith('1.0.0') };
  writeJson(home, ['eigenwise-toolshed', 'marketplace-freshness.json'], { ...cache, url: FORK_URL });
  assert.equal(readCache(fs, home), null);
  assert.deepEqual(readCache(fs, home, FORK_URL), { ...cache, url: FORK_URL });
  writeJson(home, ['eigenwise-toolshed', 'marketplace-freshness.json'], cache);
  assert.deepEqual(readCache(fs, home), cache);
  assert.equal(readCache(fs, home, FORK_URL), null);
});

test('refetches immediately after the marketplace is repointed and records the new URL', async (testContext) => {
  const home = tempHome(testContext);
  const { request, requested } = stubRequest({ [MARKETPLACE_URL]: manifestWith('5.9.0'), [FORK_URL]: manifestWith('5.9.1001') });
  await refreshCache({ home, now: NOW, request });
  registerFork(home);
  const cache = await refreshCache({ home, now: NOW + 1, request });
  assert.deepEqual(requested, [MARKETPLACE_URL, FORK_URL, FORK_BASE_URL]);
  assert.equal(cache.url, FORK_URL);
  assert.deepEqual(cache.manifest, manifestWith('5.9.1001'));
});

test('a fork release raises the Stop reminder from the fork manifest', async (testContext) => {
  const home = tempHome(testContext);
  registerFork(home);
  installSidequest(home);
  const { request } = stubRequest({ [FORK_URL]: manifestWith('5.9.1001') });
  assert.match(await stopMessage(home, request), /sidequest 5\.9\.1000 → 5\.9\.1001/);
});

test('a fork release raises the prompt reminder from the fork manifest', async (testContext) => {
  const home = tempHome(testContext);
  registerFork(home);
  installSidequest(home);
  const { request } = stubRequest({ [FORK_URL]: manifestWith('5.9.1001') });
  assert.match(await promptMessage(home, request), /sidequest 5\.9\.1000 → 5\.9\.1001/);
});

const SYNC_TEXT = /^Toolshed fork sync due: Eigenwise released Toolshed 3\.595\.0, and this machine installs from the fork johnhaley81\/eigenwise-toolshed \(live\), which is based on 3\.594\.0\. Do not run \/update-toolshed for this\./;

function resetCache(home) {
  fs.rmSync(path.join(home, '.claude', 'eigenwise-toolshed'), { recursive: true });
}

test('an upstream release above the fork base shows the sync reminder, never the update reminder', async (testContext) => {
  const { home, request, requested } = syncScenario(testContext, { [FORK_BASE_URL]: forkBase('3.594.0'), [MARKETPLACE_URL]: upstreamAt('3.595.0') });
  const stop = await stopMessage(home, request);
  assert.match(stop, SYNC_TEXT);
  assert.doesNotMatch(stop, /Toolshed updates available/);
  resetCache(home);
  assert.match(await promptMessage(home, request), SYNC_TEXT);
  assert.deepEqual(requested, [FORK_URL, FORK_BASE_URL, MARKETPLACE_URL, FORK_URL, FORK_BASE_URL, MARKETPLACE_URL]);
});

test('the sync reminder appears once per upstream version in a session', async (testContext) => {
  const { home, request } = syncScenario(testContext, { [FORK_BASE_URL]: forkBase('3.594.0'), [MARKETPLACE_URL]: upstreamAt('3.595.0') });
  assert.match(await stopMessage(home, request), SYNC_TEXT);
  assert.equal(await stopMessage(home, request), '');
  assert.match(await promptMessage(home, request), SYNC_TEXT);
  assert.equal(await promptMessage(home, request), '');
});

test('an upstream release equal to the fork base stays silent', async (testContext) => {
  const { home, request } = syncScenario(testContext, { [FORK_BASE_URL]: forkBase('3.594.0'), [MARKETPLACE_URL]: upstreamAt('3.594.0') });
  assert.equal(await stopMessage(home, request), '');
  assert.equal(await promptMessage(home, request), '');
});

test('an upstream patch release above the fork base shows the sync reminder', async (testContext) => {
  const { home, request } = syncScenario(testContext, { [FORK_BASE_URL]: forkBase('3.594.0'), [MARKETPLACE_URL]: upstreamAt('3.594.1') });
  assert.match(await stopMessage(home, request), /released Toolshed 3\.594\.1, .* based on 3\.594\.0\./);
});

test('a fork without a base file stays silent and never asks upstream', async (testContext) => {
  const { home, request, requested } = syncScenario(testContext, { [MARKETPLACE_URL]: upstreamAt('3.595.0') });
  assert.equal(await stopMessage(home, request), '');
  resetCache(home);
  assert.equal(await promptMessage(home, request), '');
  assert.deepEqual(requested, [FORK_URL, FORK_BASE_URL, FORK_URL, FORK_BASE_URL]);
});

test('an unreachable upstream stays silent and is not reported as undetermined freshness', async (testContext) => {
  const { home, request } = syncScenario(testContext, { [FORK_BASE_URL]: forkBase('3.594.0') }, [MARKETPLACE_URL]);
  assert.equal(await stopMessage(home, request), '');
  resetCache(home);
  assert.equal(await promptMessage(home, request), '');
});

test('a base file that names an unsafe upstream or no version is ignored', async (testContext) => {
  const unsafe = forkBase('3.594.0', { repo: '../../evil', ref: 'main' });
  const { home, request, requested } = syncScenario(testContext, { [FORK_BASE_URL]: unsafe, [MARKETPLACE_URL]: upstreamAt('3.595.0') });
  assert.equal(await stopMessage(home, request), '');
  resetCache(home);
  const { request: unversioned } = stubRequest({ [FORK_URL]: manifestWith('5.9.1000'), [FORK_BASE_URL]: forkBase('later'), [MARKETPLACE_URL]: upstreamAt('3.595.0') });
  assert.equal(await stopMessage(home, unversioned), '');
  assert.deepEqual(requested, [FORK_URL, FORK_BASE_URL]);
});

test('a base file that is not an object is ignored', async (testContext) => {
  const { home, request, requested } = syncScenario(testContext, { [FORK_BASE_URL]: 'not a base', [MARKETPLACE_URL]: upstreamAt('3.595.0') });
  assert.equal(await stopMessage(home, request), '');
  assert.deepEqual(requested, [FORK_URL, FORK_BASE_URL]);
});

test('a fork release still raises the update reminder next to a quiet sync check', async (testContext) => {
  const { home, request } = syncScenario(testContext, { [FORK_URL]: manifestWith('5.9.1001'), [FORK_BASE_URL]: forkBase('3.594.0'), [MARKETPLACE_URL]: upstreamAt('3.594.0') });
  const message = await stopMessage(home, request);
  assert.match(message, /sidequest 5\.9\.1000 → 5\.9\.1001/);
  assert.doesNotMatch(message, /fork sync due/);
});

test('a fork release and a due sync both report on Stop', async (testContext) => {
  const { home, request } = syncScenario(testContext, { [FORK_URL]: manifestWith('5.9.1001'), [FORK_BASE_URL]: forkBase('3.594.0'), [MARKETPLACE_URL]: upstreamAt('3.595.0') });
  const message = await stopMessage(home, request);
  assert.match(message, /sidequest 5\.9\.1000 → 5\.9\.1001/);
  assert.match(message, /fork sync due/);
});

test('an upstream source keeps reading the upstream manifest', async (testContext) => {
  const home = tempHome(testContext);
  registerSource(home, { source: 'github', repo: 'Eigenwise/eigenwise-toolshed' });
  installSidequest(home);
  const { request, requested } = stubRequest({ [MARKETPLACE_URL]: manifestWith('5.10.0'), [FORK_URL]: manifestWith('5.9.1001') });
  assert.match(await stopMessage(home, request), /sidequest 5\.9\.1000 → 5\.10\.0/);
  assert.deepEqual(requested, [MARKETPLACE_URL]);
});

test('rejects a response that is not a successful marketplace manifest', async () => {
  const { request } = stubRequest({ 'https://example.test/empty.json': {} });
  await assert.rejects(requestManifest(request, 1_000, 'https://example.test/missing.json'), /unexpected status 404/);
  await assert.rejects(requestManifest(request, 1_000, 'https://example.test/empty.json'), /plugins array missing/);
});

test('rejects a request that exceeds its timeout', async () => {
  const handlers = {};
  const request = () => ({
    setTimeout: (_ms, onTimeout) => setImmediate(onTimeout),
    on: (event, handler) => { handlers[event] = handler; },
    destroy: (error) => handlers.error(error),
  });
  await assert.rejects(requestManifest(request, 1, 'https://example.test/slow.json'), /request timed out/);
});

test('reports an unavailable manifest even when the cache cannot be written', async (testContext) => {
  const home = tempHome(testContext);
  const fileSystem = { ...fs, mkdirSync: () => { throw new Error('read-only'); } };
  const cache = await refreshCache({ home, now: NOW, fileSystem, requestManifest: async () => { throw new Error('offline'); } });
  assert.equal(cache.unavailable, true);
  assert.equal(cache.url, MARKETPLACE_URL);
});

test('a machine with no registry keeps reading the upstream manifest', async (testContext) => {
  const home = tempHome(testContext);
  installSidequest(home);
  const { request, requested } = stubRequest({ [MARKETPLACE_URL]: manifestWith('5.10.0') });
  assert.match(await promptMessage(home, request), /sidequest 5\.9\.1000 → 5\.10\.0/);
  assert.deepEqual(requested, [MARKETPLACE_URL]);
});
