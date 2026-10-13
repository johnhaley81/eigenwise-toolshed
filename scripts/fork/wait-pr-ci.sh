#!/bin/bash
# Waits until no check on an upstream PR is pending, then prints each check's result.
# usage: wait-pr-ci.sh <pr-number>
n=$1
sleep 90
for i in $(seq 1 120); do
  pending=$(gh pr checks "$n" -R Eigenwise/eigenwise-toolshed --json state --jq '[.[] | select(.state=="PENDING" or .state=="QUEUED" or .state=="IN_PROGRESS")] | length' 2>/dev/null)
  if [ "$pending" = "0" ]; then
    echo "PR #$n checks finished"
    gh pr checks "$n" -R Eigenwise/eigenwise-toolshed --json name,state --jq '.[] | "\(.state)\t\(.name)"' | sort | uniq -c | sort -rn | head -40
    exit 0
  fi
  sleep 60
done
echo "timeout waiting for PR #$n checks"
