#!/usr/bin/env bash
# survey.sh <dir>... - pre-move inventory of directory candidates.
# Reports per dir: git status, remote, worktree count, size, big gitignored data.
# Read the output BEFORE moving anything - every column is a failure mode.
set -u
for d in "$@"; do
  [ -d "$d" ] || { echo "$d: MISSING"; continue; }
  if git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    dirty=$(git -C "$d" status --short | wc -l | tr -d ' ')
    remote=$(git -C "$d" remote get-url origin 2>/dev/null || echo NO-REMOTE)
    wt=$(git -C "$d" worktree list | tail -n +2 | wc -l | tr -d ' ')
    [ "$wt" != "0" ] && wt="WT:$wt<<<" || wt="wt:0"
  else
    dirty="-"; remote="NOT-A-REPO"; wt="-"
  fi
  size=$(du -sh "$d" 2>/dev/null | cut -f1)
  # big gitignored payload inside? (docker volumes, caches - invisible to git status)
  big=$(du -sm "$d"/docker-volumes "$d"/node_modules "$d"/data 2>/dev/null | awk '$1>100{print $2":"$1"MB"}' | paste -sd, -)
  echo "$d | dirty:$dirty | $wt | $size ${big:+| bigdata:$big} | $remote"
done
echo "---"
echo "Check: dirty trees known? worktrees handled? no-remote flagged? workspace vs single repo?"
