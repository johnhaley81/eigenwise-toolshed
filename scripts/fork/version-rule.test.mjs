import assert from 'node:assert/strict';
import test from 'node:test';

import { nextForkVersion, nextMarketplaceVersion } from './version-rule.mjs';

const cases = [
  {
    name: 'first fork release starts at patch 1000',
    input: { upstream: '5.9.0', current: '5.9.0', differs: true, changedSinceTag: true },
    expected: { version: '5.9.1000', reason: 'first fork number' },
  },
  {
    name: 'a second release on the same minor bumps the fork patch when the plugin changed since the tag',
    input: { upstream: '5.9.0', current: '5.9.1000', differs: true, changedSinceTag: true },
    expected: { version: '5.9.1001', reason: 'changed since last fork tag' },
  },
  {
    name: 'a second release on the same minor keeps the number when nothing changed since the tag',
    input: { upstream: '5.9.0', current: '5.9.1003', differs: true, changedSinceTag: false },
    expected: { version: '5.9.1003', reason: 'unchanged since last fork tag' },
  },
  {
    name: 'the same minor with a moved upstream patch still continues the fork series',
    input: { upstream: '5.9.4', current: '5.9.1000', differs: true, changedSinceTag: true },
    expected: { version: '5.9.1001', reason: 'changed since last fork tag' },
  },
  {
    name: 'a moved upstream minor restarts at patch 1000 even when nothing changed since the tag',
    input: { upstream: '5.10.0', current: '5.9.1004', differs: true, changedSinceTag: false },
    expected: { version: '5.10.1000', reason: 'upstream minor moved' },
  },
  {
    name: 'a moved upstream major restarts at patch 1000',
    input: { upstream: '6.0.0', current: '5.9.1004', differs: true, changedSinceTag: true },
    expected: { version: '6.0.1000', reason: 'upstream minor moved' },
  },
  {
    name: 'a plugin identical to upstream takes the upstream number',
    input: { upstream: '5.9.2', current: '5.9.1004', differs: false, changedSinceTag: true },
    expected: { version: '5.9.2', reason: 'identical to upstream' },
  },
];

for (const { name, input, expected } of cases) {
  test(name, () => {
    assert.deepEqual(nextForkVersion(input), expected);
  });
}

test('an upstream patch of 1000 stops the release because the numbers would collide', () => {
  assert.throws(
    () => nextForkVersion({ upstream: '5.9.1000', current: '5.9.1000', differs: true, changedSinceTag: true }),
    /would collide/,
  );
});

test('an upstream patch of 1000 stops the release even for a plugin identical to upstream', () => {
  assert.throws(
    () => nextForkVersion({ upstream: '5.9.1000', current: '5.9.0', differs: false, changedSinceTag: false }),
    /would collide/,
  );
});

test('a version that is not plain semver is refused', () => {
  assert.throws(() => nextForkVersion({ upstream: '5.9', current: '5.9.0', differs: true, changedSinceTag: true }), /upstream version/);
});

test('the marketplace number stays put when no plugin number moved', () => {
  const next = nextMarketplaceVersion({ upstream: '3.594.0', current: '3.594.1000', anyForked: true, anyMoved: false });
  assert.deepEqual(next, { version: '3.594.1000', reason: 'no plugin version moved' });
});

test('the marketplace number takes a fork number when a plugin moved onto one', () => {
  const next = nextMarketplaceVersion({ upstream: '3.594.0', current: '3.594.0', anyForked: true, anyMoved: true });
  assert.deepEqual(next, { version: '3.594.1000', reason: 'first fork number' });
});

test('the marketplace number continues its fork series when a plugin moved again', () => {
  const next = nextMarketplaceVersion({ upstream: '3.594.0', current: '3.594.1000', anyForked: true, anyMoved: true });
  assert.deepEqual(next, { version: '3.594.1001', reason: 'changed since last fork tag' });
});

test('the marketplace number returns to upstream when every plugin went back to upstream', () => {
  const next = nextMarketplaceVersion({ upstream: '3.595.0', current: '3.594.1001', anyForked: false, anyMoved: true });
  assert.deepEqual(next, { version: '3.595.0', reason: 'identical to upstream' });
});
