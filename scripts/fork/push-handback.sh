#!/bin/bash
# Push a handback candidate to its fork PR branch without the board-only SQ fragment, then leave that branch checked out for groomClose.
# usage: push-handback.sh SQ-nn <candidate-sha> <branch>
set -u
cd "${TOOLSHED_REPO:-/home/john/repos/eigenwise-toolshed}" || exit 1
ref=$1; c=$2; b=$3
wt=${TMPDIR:-/tmp}/toolshed-fork-push-$ref
err=$wt.err
rm -rf "$wt"
git worktree add -q --detach "$wt" "$c" || { echo "$ref worktree failed"; exit 1; }
tip=$c
if [ -f "$wt/.release/unreleased/$ref.md" ]; then
  (
    cd "$wt" || exit 1
    git rm -q ".release/unreleased/$ref.md"
    git commit -q -m "release: drop the board-only $ref fragment; the GH fragment already covers this change

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ) || { echo "$ref strip commit failed"; git worktree remove --force "$wt"; exit 1; }
  tip=$(git -C "$wt" rev-parse HEAD)
fi
git worktree remove --force "$wt"
if ! git push -q origin "$tip:refs/heads/$b" 2>"$err"; then
  echo "$ref PUSH FAILED: $(tail -2 "$err")"; exit 1
fi
# git branch -f refuses to move the branch checked out in this checkout; checkout -B handles both cases.
git checkout -q -B "$b" "$tip" || { echo "$ref local branch update failed"; exit 1; }
echo "$ref pushed $tip -> $b (checked out)"
