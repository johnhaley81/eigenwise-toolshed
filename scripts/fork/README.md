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

## The upstream base and the sync reminder

Every `--write` also writes `.claude-plugin/fork-base.json` in the same commit. It records the
upstream marketplace version the run compared against, for example
`{ "upstream": { "repo": "Eigenwise/eigenwise-toolshed", "ref": "main" }, "marketplaceVersion": "3.594.0" }`.
`--dry-run` prints the base it would record and writes nothing. The file exists only on the fork,
so merging upstream never conflicts on it. If no plugin version moves but the base changes, the
script still commits the base alone (`fork base <version>`) and there is nothing to tag.

A machine that installs Toolshed from the fork has no other way to learn that Eigenwise released.
Quartermaster fills that gap. Once an hour it reads `fork-base.json` from the fork it installs from
and the marketplace file at the upstream repo and ref named there. When Eigenwise's version is higher
than the recorded base, the next prompt and the next Stop in each session show "Toolshed fork sync
due" once per upstream version. To clear it, merge upstream `main` into `live`, run the suites, and
follow the release flow above, so the new base is recorded. A fork with no `fork-base.json`, or an
upstream that cannot be reached, shows nothing.

## Tests

```
node --test "scripts/fork/**/*.test.mjs"
```
