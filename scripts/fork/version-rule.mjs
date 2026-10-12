import { parseVersion } from '../release/lib/semver.mjs';

// Upstream releases stay far below this patch, so a number at or above it can only be ours and
// always sorts after upstream's own patches of the same minor.
export const FORK_BASE_PATCH = 1000;

function isForkNumber([major, minor, patch], [upstreamMajor, upstreamMinor]) {
  return major === upstreamMajor && minor === upstreamMinor && patch >= FORK_BASE_PATCH;
}

function assertNoCollision(upstream, [, , patch]) {
  if (patch >= FORK_BASE_PATCH) {
    throw new Error(`upstream is at ${upstream}; patch ${FORK_BASE_PATCH} and above is reserved for fork numbers, so the two would collide`);
  }
}

function startOfFork(upstreamParts, currentParts) {
  const reason = currentParts[2] >= FORK_BASE_PATCH ? 'upstream minor moved' : 'first fork number';
  return { version: `${upstreamParts[0]}.${upstreamParts[1]}.${FORK_BASE_PATCH}`, reason };
}

function continueFork(current, [major, minor, patch], changedSinceTag) {
  if (!changedSinceTag) return { version: current, reason: 'unchanged since last fork tag' };
  return { version: `${major}.${minor}.${patch + 1}`, reason: 'changed since last fork tag' };
}

/**
 * The fork number for one plugin (or for the marketplace). Pure on purpose: every input that needs
 * git is resolved by the caller, so the rule itself can be tested with plain values.
 */
export function nextForkVersion({ upstream, current, differs, changedSinceTag }) {
  const upstreamParts = parseVersion(upstream, 'upstream version');
  const currentParts = parseVersion(current, 'current version');
  assertNoCollision(upstream, upstreamParts);
  if (!differs) return { version: upstream, reason: 'identical to upstream' };
  if (!isForkNumber(currentParts, upstreamParts)) return startOfFork(upstreamParts, currentParts);
  return continueFork(current, currentParts, changedSinceTag);
}

/** The marketplace number only moves when a plugin number did, so a no-op release stays a no-op. */
export function nextMarketplaceVersion({ upstream, current, anyForked, anyMoved }) {
  if (!anyMoved) return { version: current, reason: 'no plugin version moved' };
  return nextForkVersion({ upstream, current, differs: anyForked, changedSinceTag: true });
}
