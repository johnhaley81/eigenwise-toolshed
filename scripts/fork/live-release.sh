#!/bin/bash
# Cuts a fork release from origin/live, so that installs pick up what was merged since the last fork tag.
# Run it only after CI on live is green: the version bump is what makes machines install the new code.
# usage: live-release.sh
# exit 0 released or nothing to release, 1 failure
set -u
repo=${TOOLSHED_REPO:-/home/john/repos/eigenwise-toolshed}
node22=${NODE22_BIN:-/home/john/.local/share/fnm/node-versions/v22.23.2/installation/bin}
cli="${SIDEQUEST_CLI:-$(ls -d "$HOME"/.claude/plugins/cache/eigenwise-toolshed/sidequest/*/ | sort -V | tail -1)bin/sidequest.js}"
wt=${TMPDIR:-/tmp}/toolshed-fork-live-release
locked=0
cleanup() {
  cd "$repo" || return
  [ "$locked" = 1 ] && node "$cli" publish unlock >/dev/null 2>&1
  git worktree remove --force "$wt" 2>/dev/null
}
trap cleanup EXIT
cd "$repo" || exit 1
git fetch -q origin live && git fetch -q upstream main || { echo "FETCH FAILED"; exit 1; }
rm -rf "$wt"
git worktree prune
git worktree add -q --detach "$wt" origin/live || { echo "WORKTREE FAILED"; exit 1; }
cd "$wt" || exit 1
out=$(PATH=$node22:$PATH node scripts/fork/release.mjs --write 2>&1) || { echo "$out"; echo "RELEASE SCRIPT FAILED"; exit 1; }
echo "$out"
tip=$(git rev-parse HEAD)
if [ "$tip" = "$(git rev-parse origin/live)" ]; then
  echo "nothing to release"
  exit 0
fi
tag=$(echo "$out" | sed -n 's/.*Committed fork release \(fork-v[0-9][0-9.]*[0-9]\)\..*/\1/p')
cd "$repo" || exit 1
node "$cli" publish lock >/dev/null || { echo "PUBLISH LOCK FAILED"; exit 1; }
locked=1
git push -q origin "$tip:refs/heads/live" || { echo "PUSH FAILED for $tip"; exit 1; }
if [ -n "$tag" ]; then
  git tag -a "$tag" "$tip" -m "fork release $tag" && git push -q origin "$tag" || { echo "TAG PUSH FAILED for $tag"; exit 1; }
  echo "released $tag at $tip"
else
  echo "pushed $tip (upstream base only, no version moved, no tag)"
fi
