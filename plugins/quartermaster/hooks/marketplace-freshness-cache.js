#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { parseSemver, readJson } = require('./freshness-helpers.js');

const CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const MARKETPLACE_NAME = 'eigenwise-toolshed';
const GITHUB_REPOSITORY_URL = /^(?:https:\/\/|git@)github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/;
const REQUEST_TIMEOUT_MS = 5_000;
const REPOSITORY_NAME = /^[\w.-]+\/[\w.-]+$/;
const REF_NAME = /^[\w./-]+$/;
const MANIFEST_URL_PARTS = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/(.+)\/\.claude-plugin\/marketplace\.json$/;

function rawManifestUrl(repository, ref) {
  return `https://raw.githubusercontent.com/${repository}/${ref || 'main'}/.claude-plugin/marketplace.json`;
}

const MARKETPLACE_URL = rawManifestUrl('Eigenwise/eigenwise-toolshed');

function sourceRepository(source) {
  if (source?.source === 'github') return source.repo;
  return source?.source === 'git' ? GITHUB_REPOSITORY_URL.exec(source.url)?.[1] : undefined;
}

// Update reminders must follow the source /update-toolshed refreshes from, which is whatever Claude Code registered.
function manifestUrl(fileSystem = fs, home = os.homedir()) {
  const registry = readJson(fileSystem, path.join(home, '.claude', 'plugins', 'known_marketplaces.json'));
  const source = registry?.[MARKETPLACE_NAME]?.source;
  const repository = sourceRepository(source);
  return repository ? rawManifestUrl(repository, source.ref) : MARKETPLACE_URL;
}

function cacheFile(home = os.homedir()) {
  return path.join(home, '.claude', 'eigenwise-toolshed', 'marketplace-freshness.json');
}

// A cache written before its URL was recorded always came from upstream.
function cacheForUrl(cache, url) {
  return (cache?.url ?? MARKETPLACE_URL) === url ? cache : null;
}

function readCache(fileSystem = fs, home = os.homedir(), url = manifestUrl(fileSystem, home)) {
  try {
    return cacheForUrl(JSON.parse(fileSystem.readFileSync(cacheFile(home), 'utf8')), url);
  } catch (_) {
    return null;
  }
}

function cacheIsCurrent(cache, now = Date.now()) {
  const checkedAt = Date.parse(cache?.checkedAt || '');
  return Number.isFinite(checkedAt) && now - checkedAt >= 0 && now - checkedAt < CACHE_MAX_AGE_MS;
}

function requestJson(request = https.get, timeoutMs = REQUEST_TIMEOUT_MS, url, validate) {
  return new Promise((resolve, reject) => {
    const response = request(url, { headers: { accept: 'application/json' } }, (incoming) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => { body += chunk; });
      incoming.on('end', () => {
        if (incoming.statusCode !== 200) {
          reject(new Error(`unexpected status ${incoming.statusCode}`));
          return;
        }
        try {
          const parsed = JSON.parse(body);
          validate(parsed);
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });
    response.setTimeout(timeoutMs, () => response.destroy(new Error('request timed out')));
    response.on('error', reject);
  });
}

function assertManifest(manifest) {
  if (!Array.isArray(manifest.plugins)) throw new Error('plugins array missing');
}

function matches(pattern, value) {
  return typeof value === 'string' && pattern.test(value);
}

// repo and ref become URL path segments, so a file the fork controls must not smuggle anything else in.
function assertForkBase(base) {
  const { repo, ref } = base.upstream;
  if (!matches(REPOSITORY_NAME, repo) || !matches(REF_NAME, ref) || !parseSemver(base.marketplaceVersion)) throw new Error('fork base is invalid');
}

function requestManifest(request = https.get, timeoutMs = REQUEST_TIMEOUT_MS, url = manifestUrl()) {
  return requestJson(request, timeoutMs, url, assertManifest);
}

function forkBaseUrl(url) {
  return url.replace(/marketplace\.json$/, 'fork-base.json');
}

// A fork without a readable base file, or with an unreachable upstream, has nothing to compare, and that must stay silent.
async function fetchSyncEntry(url, request, timeoutMs) {
  if (url === MARKETPLACE_URL) return {};
  try {
    const base = await requestJson(request, timeoutMs, forkBaseUrl(url), assertForkBase);
    const upstream = await requestManifest(request, timeoutMs, rawManifestUrl(base.upstream.repo, base.upstream.ref));
    return { sync: { base, upstreamVersion: upstream.version } };
  } catch (_) {
    return {};
  }
}

function forkLabel(url) {
  const [, repository, ref] = MANIFEST_URL_PARTS.exec(url) || [];
  return `${repository} (${ref})`;
}

function writeCache(cache, fileSystem = fs, home = os.homedir()) {
  const destination = cacheFile(home);
  fileSystem.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fileSystem.writeFileSync(temporary, `${JSON.stringify(cache)}\n`, 'utf8');
  fileSystem.renameSync(temporary, destination);
}

function writeCacheIfPossible(cache, options) {
  try {
    writeCache(cache, options.fileSystem, options.home);
  } catch (_) {
    // The prompt guard still treats an unwritable cache as unknown.
  }
}

async function refreshCache(options = {}) {
  const now = options.now ?? Date.now();
  const url = manifestUrl(options.fileSystem, options.home);
  const existing = readCache(options.fileSystem, options.home, url);
  if (cacheIsCurrent(existing, now)) return existing;
  try {
    const [manifest, syncEntry] = await Promise.all([
      (options.requestManifest || requestManifest)(options.request, undefined, url),
      fetchSyncEntry(url, options.request),
    ]);
    const cache = { checkedAt: new Date(now).toISOString(), url, manifest, ...syncEntry };
    writeCache(cache, options.fileSystem, options.home);
    return cache;
  } catch (_) {
    const cache = { checkedAt: new Date(now).toISOString(), url, unavailable: true };
    writeCacheIfPossible(cache, options);
    return cache;
  }
}

async function main() {
  process.stdout.write(`${JSON.stringify({ async: true, asyncTimeout: 2 * REQUEST_TIMEOUT_MS + 1_000 })}\n`);
  await refreshCache();
}

if (require.main === module) main();

module.exports = {
  CACHE_MAX_AGE_MS,
  MARKETPLACE_URL,
  REQUEST_TIMEOUT_MS,
  cacheFile,
  cacheIsCurrent,
  fetchSyncEntry,
  forkLabel,
  manifestUrl,
  readCache,
  refreshCache,
  requestManifest,
  writeCache,
};
