#!/bin/bash
# Per PR head: every job of every workflow run on that commit, so jobs with same truncated names are not merged.
R=Eigenwise/eigenwise-toolshed
for n in ${@:-$(gh pr list --repo $R --author johnhaley81 --state open --json number --jq '.[].number')}; do
  sha=$(gh pr view $n --repo $R --json headRefOid --jq .headRefOid)
  # An empty head_sha filter lists every run in the repository, so a failed lookup would report other PRs' failures.
  [ -n "$sha" ] || { echo "#$n lookup-failed"; continue; }
  # On a 5xx, gh prints the raw error JSON to stdout without the --jq filter, and its lines would count as failed jobs.
  runs=$(gh api "repos/$R/actions/runs?head_sha=$sha&per_page=20" --jq '.workflow_runs[].id') || { echo "#$n lookup-failed"; continue; }
  tot=0; bad=""; pend=0; lost=""
  for r in $runs; do
    jobs=$(gh api "repos/$R/actions/runs/$r/jobs?per_page=100" --jq '.jobs[]|"\(.conclusion)\t\(.name)"') || { lost=1; break; }
    while IFS=$'\t' read -r c name; do
      [ -n "$c$name" ] || continue
      tot=$((tot+1))
      case "$c" in success|skipped) ;; ""|null) pend=$((pend+1));; *) bad="$bad | $c: ${name:0:90}";; esac
    done <<< "$jobs"
  done
  [ -z "$lost" ] || { echo "#$n lookup-failed"; continue; }
  echo "#$n ${sha:0:8} jobs=$tot pending=$pend${bad:+ FAIL$bad}"
done
