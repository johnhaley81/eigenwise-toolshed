#!/bin/bash
# Brings a fork PR branch's fixes into the fork's live branch so that John's machines can get them.
# John's rule (2026-10-12): "Only merge in *RELEASED* eigenwide code. Keep our PRs up to date but do not
# release that on our fork until it is released upstream." PR branches carry Eigenwise develop history, so a
# plain merge is allowed only when it brings no develop commit that upstream main lacks; otherwise --pick
# copies just the PR's own commits.
# Installs change only at the next fork release (live-release.sh), so CI on live gates the release, not this push.
# usage: live-merge.sh <pr-branch>          merge the branch (refused with exit 3 if it carries unreleased develop)
#        live-merge.sh --pick <pr-branch>   cherry-pick only the branch's own commits that live lacks
# exit 0 done or nothing to do, 2 conflict (nothing pushed), 3 unreleased Eigenwise code (nothing pushed), 1 other failure
set -u
repo=${TOOLSHED_REPO:-/home/john/repos/eigenwise-toolshed}
mode=merge
[ "${1:-}" = "--pick" ] && { mode=pick; shift; }
b=$1
wt=${TMPDIR:-/tmp}/toolshed-fork-live-merge-${b//\//-}
cd "$repo" || exit 1
git fetch -q origin live "$b" && git fetch -q upstream main develop || { echo "FETCH FAILED"; exit 1; }
unreleased=$(comm -12 <(git rev-list "origin/$b" ^origin/live ^upstream/main | sort) <(git rev-list upstream/develop ^upstream/main | sort) | wc -l)
own=$(git rev-list --reverse --no-merges "origin/$b" ^origin/live ^upstream/develop)
if [ "$mode" = merge ]; then
  if git merge-base --is-ancestor "origin/$b" origin/live; then
    echo "$b is already in live ($(git rev-parse --short origin/live)); nothing to merge"; exit 0
  fi
  if [ "$unreleased" -gt 0 ]; then
    echo "REFUSED: $b carries $unreleased Eigenwise develop commit(s) that upstream main has not released."
    echo "Run: live-merge.sh --pick $b  (copies only the PR's own commits: $(echo "$own" | grep -c .))"
    exit 3
  fi
elif [ -z "$own" ]; then
  echo "$b has no own commits that live lacks; nothing to pick"; exit 0
fi
rm -rf "$wt"
git worktree prune
git worktree add -q --detach "$wt" origin/live || { echo "WORKTREE FAILED"; exit 1; }
cleanup() { cd "$repo" && git worktree remove --force "$wt"; }
cd "$wt" || exit 1
if [ "$mode" = merge ]; then
  if ! git merge -q --no-ff "origin/$b" -m "Merge $b into live

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" >/dev/null 2>&1; then
    echo "CONFLICT merging $b into live: $(git diff --name-only --diff-filter=U | tr '\n' ' ')"
    git merge --abort; cleanup; exit 2
  fi
else
  for c in $own; do
    if ! git cherry-pick -x "$c" >/dev/null 2>&1; then
      if git diff --cached --quiet && [ -z "$(git diff --name-only --diff-filter=U)" ]; then
        git cherry-pick --skip >/dev/null 2>&1; continue
      fi
      echo "CONFLICT picking $(git log --oneline -1 "$c") into live: $(git diff --name-only --diff-filter=U | tr '\n' ' ')"
      echo "The fix may depend on unreleased Eigenwise code; wait for the upstream release, then sync."
      git cherry-pick --abort; cleanup; exit 2
    fi
  done
  # A board-only fragment commit and its strip commit cancel out; pushing them would only add noise to live.
  if git diff --quiet origin/live HEAD; then
    echo "the picked commits of $b change nothing in live; nothing pushed"; cleanup; exit 0
  fi
fi
tip=$(git rev-parse HEAD)
cleanup
git push -q origin "$tip:refs/heads/live" || { echo "PUSH FAILED for $tip"; exit 1; }
echo "$mode $b into live: $tip (wait for CI on live, then run live-release.sh)"
