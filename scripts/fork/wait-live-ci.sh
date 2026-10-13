#!/bin/bash
# Waits for the Test workflow run on a live commit to finish, then prints each job's result.
sha=$1
for i in $(seq 1 120); do
  line=$(gh run list -R johnhaley81/eigenwise-toolshed --branch live --commit "$sha" --workflow Test --json databaseId,status,conclusion --jq '.[0] | "\(.databaseId) \(.status) \(.conclusion)"' 2>/dev/null)
  set -- $line
  if [ "${2:-}" = "completed" ]; then
    echo "run $1 $3"
    gh run view "$1" -R johnhaley81/eigenwise-toolshed --json jobs --jq '.jobs[] | "\(.name)\t\(.conclusion)"'
    exit 0
  fi
  sleep 60
done
echo "timeout waiting for CI on $sha"
