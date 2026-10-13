#!/bin/bash
# One-shot read-only GitHub check: prints owner merges, closes, reviews, non-self comments and carried PRs
# since the last run, using a state file for the baseline. Prints "no owner activity" when nothing changed.
R=Eigenwise/eigenwise-toolshed
ME=johnhaley81
# Every per-PR call below falls back to the last count when GitHub fails, so an outage would print "no owner activity" for a check that never ran.
gh api rate_limit >/dev/null 2>&1 || { echo "GitHub unreachable ($(date -u +%H:%MZ)); no check done, state unchanged"; exit 0; }
PRS="146 164 166 170 172 174 184 185 186 187 223 224 234 236 242 243 271 $(gh pr list --repo $R --author $ME --state open --limit 100 --json number --jq '.[].number' | tr '\n' ' ')"
PRS=$(echo $PRS | tr ' ' '\n' | sort -un | tr '\n' ' ')
ISS="144 145 147 163 165 167 169 171 173 180 181 182 183 221 233 235 239 240 244 262 270 $(gh issue list --repo $R --author $ME --state open --limit 100 --json number --jq '.[].number' | tr '\n' ' ')"
ISS=$(echo $ISS | tr ' ' '\n' | sort -un | tr '\n' ' ')
# /tmp is a tmpfs on the dev box, so the baseline and the report markers live under the XDG state directory to survive a reboot.
STATE_DIR=${XDG_STATE_HOME:-$HOME/.local/state}/eigenwise-toolshed-fork
mkdir -p "$STATE_DIR/reviews"
STATE=$STATE_DIR/owner-check.state
declare -A seen rv fin ic
[ -f "$STATE" ] && . "$STATE"
# A PR that closes leaves the open list in the same step, so keep every PR seen before.
PRS=$(echo $PRS ${!rv[@]} | tr ' ' '\n' | sort -un | tr '\n' ' ')
ISS=$(echo $ISS ${!seen[@]} | tr ' ' '\n' | sort -un | tr '\n' ' ')
seen_pr=${seen_pr:-0}
events=0
out=""
for n in $PRS; do
  st=$(gh pr view $n --repo $R --json state,mergedAt --jq '"\(.state) \(.mergedAt // "")"' 2>/dev/null) || continue
  case "$st" in OPEN*) ;; *) if [ -z "${fin[$n]}" ]; then out="$out\nPR #$n is now $st"; fin[$n]=1; events=$((events+1)); fi;; esac
  c=$(gh api repos/$R/pulls/$n/reviews --jq 'length' 2>/dev/null) || c=${rv[$n]:-0}
  base=${rv[$n]:-0}
  if [ "$c" -gt "$base" ]; then
    out="$out\n$(gh api repos/$R/pulls/$n/reviews --jq ".[$base:][] | select(.user.login!=\"$ME\") | \"REVIEW on PR #$n by \\(.user.login) [\\(.state)]: \\(.body|.[0:300])\"" 2>/dev/null)"
    events=$((events+1))
  fi
  rv[$n]=$c
  c=$(gh api repos/$R/pulls/$n/comments --jq 'length' 2>/dev/null) || c=${ic[$n]:-0}
  base=${ic[$n]:-0}
  if [ "$c" -gt "$base" ]; then
    new=$(gh api repos/$R/pulls/$n/comments --jq ".[$base:][] | select(.user.login!=\"$ME\") | \"INLINE on PR #$n by \\(.user.login) \\(.path):\\(.line): \\(.body|.[0:300])\"" 2>/dev/null)
    [ -n "$new" ] && { out="$out\n$new"; events=$((events+1)); }
  fi
  ic[$n]=$c
done
for n in $PRS $ISS; do
  c=$(gh api repos/$R/issues/$n/comments --jq 'length' 2>/dev/null) || c=${seen[$n]:-0}
  base=${seen[$n]:-0}
  if [ "$c" -gt "$base" ]; then
    new=$(gh api repos/$R/issues/$n/comments --jq ".[$base:][] | select(.user.login!=\"$ME\") | \"COMMENT on #$n by \\(.user.login): \\(.body|.[0:300])\"" 2>/dev/null)
    [ -n "$new" ] && { out="$out\n$new"; events=$((events+1)); }
  fi
  seen[$n]=$c
done
latest=$(gh pr list --repo $R --state all --limit 1 --json number --jq '.[0].number' 2>/dev/null || echo $seen_pr)
if [ "$seen_pr" -gt 0 ] && [ "$latest" -gt "$seen_pr" ]; then
  new=$(gh pr list --repo $R --state all --limit 20 --json number,author,title,body --jq ".[] | select(.number > $seen_pr) | select(.author.login!=\"$ME\") | select((.title+.body) | test(\"#(146|164|166|170|172|174|184|185|186|187|223|224|234|236|242|243|271|144|147|163|165|167|169|171|173|180|181|182|183|221|233|235|239|240|244|262|270)\\\\b\")) | \"CARRIED PR #\\(.number) by \\(.author.login): \\(.title)\"" 2>/dev/null)
  [ -n "$new" ] && { out="$out\n$new"; events=$((events+1)); }
fi
seen_pr=$latest
{
  echo "seen_pr=$seen_pr"
  for k in "${!seen[@]}"; do echo "seen[$k]=${seen[$k]}"; done
  for k in "${!rv[@]}"; do echo "rv[$k]=${rv[$k]}"; done
  for k in "${!ic[@]}"; do echo "ic[$k]=${ic[$k]}"; done
  for k in "${!fin[@]}"; do echo "fin[$k]=${fin[$k]}"; done
} > "$STATE"
# gh pr checks merges jobs whose names truncate to the same text, so read every job of the head commit.
# Report each failing PR head once; a head marker file stops repeats until a new commit fails.
while IFS= read -r line; do
  [ -z "$line" ] && continue
  key=$(echo "$line" | awk '{print $1"-"$2}' | tr -d '#'); f="$STATE.cifail-$key"
  [ -f "$f" ] || { out="$out\nCI FAILING: $line"; events=$((events+1)); touch "$f"; }
done < <(bash "$(dirname "$0")/ci-audit.sh" 2>/dev/null | grep ' FAIL')
# John updates the toolshed only once every overlay-532 fix is released (on upstream main).
pend=""
for n in 172 174 186 223 224; do
  mc=$(gh pr view $n --repo $R --json mergeCommit --jq '.mergeCommit.oid // ""' 2>/dev/null)
  if [ -z "$mc" ]; then pend="$pend #$n"; continue; fi
  st=$(gh api repos/$R/compare/main...$mc --jq .status 2>/dev/null)
  case "$st" in behind|identical) ;; *) pend="$pend #$n(merged,unreleased)";; esac
done
[ -z "$pend" ] && [ ! -f "$STATE.overlay-done" ] && { out="$out\nOVERLAY RELEASED: #172, #174 and #186 are all on upstream main; an update now restores the fixes John gave up on 2026-10-03"; events=$((events+1)); touch "$STATE.overlay-done"; }
# Develop moves daily; a PR that stops merging cleanly blocks the owner's review gate.
for n in $(gh pr list --repo $R --author $ME --state open --json number,mergeable --jq '.[]|select(.mergeable=="CONFLICTING")|.number'); do
  # The state file is already written here, so mark reported conflicts with a head-keyed file.
  h=$(gh pr view $n --repo $R --json headRefOid --jq .headRefOid); f="$STATE.conflict-$n-$h"
  [ -f "$f" ] || { out="$out\nCONFLICT: PR #$n no longer merges onto develop"; events=$((events+1)); touch "$f"; }
done
if [ "$events" -eq 0 ]; then echo "no owner activity ($(date -u +%H:%MZ))"; else printf "%b\n" "$out" | grep -v '^$'; fi
