#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  cacheIsCurrent,
  manifestUrl,
  readCache,
  requestManifest,
  writeCache,
} = require('./marketplace-freshness-cache.js');
const {
  MARKETPLACE,
  activeInstances,
  availableVersionsKey,
  installedVersionsKey,
  loadedPluginVersion,
  newerInstalledVersion,
  remoteUpdates,
  remoteWarning,
  reloadWarning,
  reportedReloads,
  reportedReloadWarning,
  warnOnce,
} = require('./user-prompt-freshness.js');
const { readJson, reportLoadedPluginVersion } = require('./freshness-helpers.js');

const REFRESH_TIMEOUT_MS = 2_000;

function readStdin(fileSystem = fs) {
  try {
    const raw = fileSystem.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function activeToolshedInstances(input, options) {
  const fileSystem = options.fileSystem || fs;
  const home = options.home || os.homedir();
  const registryFile = options.registryFile || path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  return activeInstances(readJson(fileSystem, registryFile) || {}, input.cwd, MARKETPLACE, options.platform);
}

function refreshManifest(options, url) {
  if (options.requestManifest) return options.requestManifest();
  return requestManifest(options.request, options.requestTimeoutMs ?? REFRESH_TIMEOUT_MS, url);
}

function environmentOf(options) {
  return options.environment || process.env;
}

function isSkipped(input, options) {
  return Boolean(input?.stop_hook_active || !input?.session_id || environmentOf(options).EIGENWISE_TOOLSHED_FRESHNESS_BYPASS === '1');
}

async function refreshedCache(options, now, fileSystem, home, url) {
  try {
    const refreshed = { checkedAt: new Date(now).toISOString(), url, manifest: await refreshManifest(options, url) };
    writeCache(refreshed, fileSystem, home);
    return refreshed;
  } catch {
    return null;
  }
}

async function loadCache(options, now) {
  const fileSystem = options.fileSystem || fs;
  const home = options.home || os.homedir();
  const url = manifestUrl(fileSystem, home);
  const cache = options.cache === undefined ? readCache(fileSystem, home, url) : options.cache;
  return cacheIsCurrent(cache, now) ? cache : refreshedCache(options, now, fileSystem, home, url);
}

function remoteMessages(instances, cache, input, options, now) {
  const updates = remoteUpdates(instances, cache?.manifest);
  const warn = updates.length && warnOnce(input, 'stop-remote', options, availableVersionsKey(updates));
  return warn ? [remoteWarning(instances, cache, now)] : [];
}

function reportedReloadMessages(instances, input, options) {
  const reportedUpdates = reportedReloads(instances, input, options);
  const warn = reportedUpdates.length && warnOnce(input, 'stop-reload', options, installedVersionsKey(reportedUpdates));
  return warn ? [reportedReloadWarning(reportedUpdates)] : [];
}

function reloadMessages(instances, input, options) {
  const fileSystem = options.fileSystem || fs;
  const messages = [];
  const pluginRoot = options.pluginRoot || environmentOf(options).CLAUDE_PLUGIN_ROOT;
  const loadedVersion = loadedPluginVersion(fileSystem, pluginRoot);
  reportLoadedPluginVersion(input, 'quartermaster@eigenwise-toolshed', loadedVersion, {
    directory: options.loadedVersionStateDirectory,
    fileSystem,
    pluginRoot,
  });
  const installedVersion = newerInstalledVersion(instances, loadedVersion);
  if (installedVersion && warnOnce(input, 'stop-reload', options, `quartermaster@${installedVersion}`)) {
    messages.push(reloadWarning(installedVersion, loadedVersion));
  }
  return [...messages, ...reportedReloadMessages(instances, input, options)];
}

async function decide(input, options = {}) {
  if (isSkipped(input, options)) return '';

  const now = options.now ?? Date.now();
  const cache = await loadCache(options, now);
  const instances = activeToolshedInstances(input, options);
  const messages = [
    ...remoteMessages(instances, cache, input, options, now),
    ...reloadMessages(instances, input, options),
  ];
  return messages.length ? JSON.stringify({ systemMessage: messages.join('\n') }) : '';
}

async function main() {
  const output = await decide(readStdin());
  if (output) process.stdout.write(output);
}

if (require.main === module) main().catch(() => {});

module.exports = {
  REFRESH_TIMEOUT_MS,
  activeToolshedInstances,
  decide,
  readStdin,
  refreshManifest,
};
