# Fork release

These files exist only on the fork's `live` branch. They give each plugin a version number that
never collides with upstream's numbers. Upstream's own release flow in `scripts/release/` is not
used here and is not changed.

## The number scheme

Upstream releases stay below patch 1000. A fork number is `<upstream major>.<upstream minor>.<1000 or more>`,
for example upstream `5.9.0` becomes `5.9.1000`. The fork number always sorts after upstream's
patches of the same minor, and an update check never mistakes it for a different release.

For each plugin the script compares `plugins/<name>` on `live` with the upstream release that `live`
holds. Without `--upstream`, that is `git merge-base HEAD upstream/main`: a sync merge brings upstream
`main` into `live`, so the merge base is the last upstream release `live` merged. While a sync is held,
`upstream/main` is newer than that, and numbering against it would give unchanged plugins fork numbers.
`--upstream <ref>` skips the merge base and uses that commit exactly as given. The script prints the
upstream commit it used on its first output line. It ignores `plugin.json`, because the script rewrites
that file itself.

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

1. `node scripts/fork/release.mjs --dry-run` prints the upstream commit it used, then a table of
   plugin, upstream, current, next and the reason. It changes nothing. If the `upstream/main` ref is
   missing, the script fetches upstream's `main` into a temporary ref and removes it afterwards. Run
   `git fetch upstream` first so the merge base is computed against the newest `upstream/main`.
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

## Maintenance scripts

The half-hourly fork check and the merge flow run these helpers. They live here, on `live`, so a
reboot of the dev box (where `/tmp` is a tmpfs) cannot erase them. The check parses their output
text, for example `no owner activity`, `REFUSED`, `CONFLICT` and `CI FAILING`, so change that text
only together with the check.

### The rule

John's rule (2026-10-12): "Only merge in *RELEASED* eigenwide code. Keep our PRs up to date but do not release that on our fork until it is released upstream"

PR branches carry Eigenwise `develop` history. `live-merge.sh` is the guard that keeps unreleased
`develop` code out of `live`. Never rebuild the merge step without it.

### Scripts

| Script | What it does |
| --- | --- |
| `live-merge.sh [--pick] <pr-branch>` | Brings a fork PR branch into `origin/live` and pushes `live`. Merge mode refuses a branch that carries a `develop` commit missing from `upstream/main`. `--pick` cherry-picks only the PR's own commits that `live` lacks. It pushes nothing when those commits change nothing in `live`, for example a board fragment commit followed by its strip commit. |
| `live-release.sh` | Runs `release.mjs --write` on a fresh checkout of `origin/live`, then pushes `live` and the `fork-v*` tag under the sidequest publish lock. Prints `nothing to release` when `live` does not move. |
| `push-handback.sh <SQ-nn> <candidate-sha> <branch>` | Pushes an executor's handback candidate to its fork PR branch without the board-only `.release/unreleased/<SQ-nn>.md` fragment, then checks that branch out locally. It works whether or not `<branch>` is already checked out. |
| `ci-audit.sh [pr-number...]` | Prints one line per open PR head with the count of jobs, pending jobs and every failed job. A lookup that fails prints `lookup-failed`. |
| `wait-pr-ci.sh <pr-number>` | Waits until no check on an upstream PR is pending, then prints each check's result. |
| `wait-live-ci.sh <live-sha>` | Waits for the `Test` workflow run on that `live` commit, then prints each job's result. |
| `owner-check.sh` | Read-only GitHub check for the half-hourly run. Prints owner merges, closes, reviews, comments, carried PRs, failing PR heads, conflicting PRs and the overlay release, or `no owner activity`. |

### Exit codes of `live-merge.sh`

| Code | Meaning |
| --- | --- |
| 0 | Done, or nothing to do. Nothing is pushed when there is nothing to do. |
| 1 | Another failure: fetch, worktree or push. |
| 2 | Conflict. Nothing is pushed. In `--pick` mode the fix may depend on unreleased Eigenwise code, so wait for the upstream release, then sync. |
| 3 | The branch carries unreleased Eigenwise `develop` commits. Nothing is pushed. Run it again with `--pick`. |

### Order of work

1. Run `live-merge.sh <pr-branch>`, or `live-merge.sh --pick <pr-branch>` after exit 3.
2. Wait for CI on `live` with `wait-live-ci.sh <live-sha>`. The push does not change what installs get.
3. Run `live-release.sh`. Its version bump is what makes machines install the new code, so never run it before CI on `live` is green.

### Paths and state

| Setting | Default |
| --- | --- |
| `TOOLSHED_REPO` | `/home/john/repos/eigenwise-toolshed` |
| `NODE22_BIN` | `/home/john/.local/share/fnm/node-versions/v22.23.2/installation/bin` |
| `SIDEQUEST_CLI` | The newest `sidequest.js` in `~/.claude/plugins/cache/eigenwise-toolshed/sidequest/` |
| `XDG_STATE_HOME` | `~/.local/state` |

`owner-check.sh` keeps its state in `${XDG_STATE_HOME:-$HOME/.local/state}/eigenwise-toolshed-fork/`:
`owner-check.state` (the baseline), its `.cifail-*`, `.conflict-*` and `.overlay-done` markers that
stop a report from repeating, and a `reviews/` folder for saved reviews. Scripts call each other
through their own directory, so they work from any checkout. Temporary worktrees go under `$TMPDIR`.

## Tests

```
node --test "scripts/fork/**/*.test.mjs"
```

`scripts.test.mjs` runs `bash -n` on every script. It also builds temporary repositories with
`upstream` and `origin` remotes, with no network, to check the released-code guard, the `--pick`
mode and `push-handback.sh`.
