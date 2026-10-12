# Fork release

These files exist only on the fork's `live` branch. They give each plugin a version number that
never collides with upstream's numbers. Upstream's own release flow in `scripts/release/` is not
used here and is not changed.

## The number scheme

Upstream releases stay below patch 1000. A fork number is `<upstream major>.<upstream minor>.<1000 or more>`,
for example upstream `5.9.0` becomes `5.9.1000`. The fork number always sorts after upstream's
patches of the same minor, and an update check never mistakes it for a different release.

For each plugin the script compares `plugins/<name>` on `live` with the upstream ref. It ignores
`plugin.json`, because the script rewrites that file itself.

| Situation | Next version |
| --- | --- |
| Plugin has no change from upstream | Upstream's number, exactly. This also covers a plugin that upstream took in whole. |
| Plugin differs, and the current number is not a fork number for upstream's major.minor | `<upstream major>.<upstream minor>.1000` |
| Plugin differs, current number is a fork number, plugin changed since the last `fork-v*` tag | Current number with patch plus 1 |
| Plugin differs, current number is a fork number, no change since the last tag | Current number, unchanged |

The marketplace version follows the same rule against upstream's marketplace version. It moves
only when at least one plugin version moves.

If upstream itself reaches patch 1000, the script stops with an error. The two series would collide
and the scheme needs a new base.

## Release flow

Run from the repository root, on `live`, with a clean working tree.

1. `node scripts/fork/release.mjs --dry-run` prints a table of plugin, upstream, current, next and
   the reason. It changes nothing. If the `upstream/main` ref is missing, the script fetches
   upstream's `main` into a temporary ref and removes it afterwards. Run `git fetch upstream` first
   if you want the newest upstream.
2. `node scripts/fork/release.mjs --write` writes the versions and makes one commit named
   `fork release fork-v<marketplace version>`. It writes the three version fields of each plugin
   together, through the same code the upstream release uses.
3. The orchestrator then tags that commit `fork-v<marketplace version>` and pushes `live` and the
   tag. The script never tags and never pushes.

The script does not touch release fragments or changelogs, and it never runs
`scripts/release/cut.mjs`. That keeps `live` easy to merge with upstream.

## Tests

```
node --test "scripts/fork/**/*.test.mjs"
```
