#!/usr/bin/env bash
# verify.sh <dir>... - post-move verification per moved dir.
# Confirms git survived the move and shows what state arrived with it.
set -u
fail=0
for d in "$@"; do
  if [ ! -d "$d" ]; then echo "$d: MISSING <<<"; fail=1; continue; fi
  if git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    head1=$(git -C "$d" log --oneline -1 2>/dev/null | cut -c1-60)
    dirty=$(git -C "$d" status --short | wc -l | tr -d ' ')
    remote=$(git -C "$d" remote get-url origin 2>/dev/null || echo NO-REMOTE)
    # worktrees: healthy kept ones (post worktree-repair) are fine; broken/orphaned ones are not
    while IFS= read -r wtpath; do
      [ -n "$wtpath" ] || continue
      if ! git -C "$wtpath" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "$d: BROKEN WORKTREE at $wtpath <<<" && fail=1
      fi
    done < <(git -C "$d" worktree list --porcelain | awk '/^worktree /{print $2}' | tail -n +2)
    echo "$d | dirty:$dirty | $remote | $head1"
  else
    echo "$d | not a git repo (ok if expected)"
  fi
done
[ $fail -eq 0 ] && echo "--- all dirs verified ---" || { echo "--- FAILURES above <<<"; exit 1; }
