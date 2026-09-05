---
name: git-worktrees
description: "Use when about to do agent work in a repo that ANOTHER session, loop, or human might touch at the same time - starting a self-correcting loop, a long multi-file refactor, or writing new untracked files while a background agent runs there. Also fires on 'another session is working in that repo', 'run a loop', 'parallel work', or after any incident where an agent's files vanished. NOT for diagnosing a failing git command on a single tree (git-troubleshooting)."
---

# Git worktrees as the default for parallel agent work

Two agents in one working directory is not two agents in one repo. It is two
agents sharing one index, one working tree, and one set of untracked files. The
worktree is not a nicety here - it is what makes the second agent's work exist
at all.

## The hazard, concretely

A self-correcting loop checkpoints with `git add -A` and rolls back
out-of-scope writes. Both halves of that hurt a concurrent session:

| Mechanism | What it does to the other session |
|---|---|
| Checkpoint `git add -A` | Stages the other session's in-progress files into the loop's index; if the human then commits, unrelated work rides along |
| Scope revert | An untracked file outside `writeScope` is "reverted" by deleting it - the other session's new file is simply gone |
| Rollback to checkpoint | Restores agent-touched paths from the checkpoint index; files created after that checkpoint are not in it |

An untracked file outside the loop's `writeScope` is deleted on scope revert and
was never in any checkpoint, so it is unrecoverable: `git fsck --unreachable`
finds no blob because none was ever written. The only copy is the authoring
session's context.

## Decide in one line

Working in a repo where anything else might be writing -> worktree. That
includes: a `loop run` in progress, a `bg_task` you spawned against the same
repo, a human editing in an IDE, or a long build that will rewrite generated
files. Solo, foreground, nothing else running -> the main tree is fine.

Cheap detection before you start:

```bash
ps -eo pid,etimes,cmd --no-headers | rg 'loop run|pi -p' | rg -v rg
tail -3 .pi/harness-run.log 2>/dev/null        # a loop's live log
git status --short                              # foreign staged files = someone else's checkpoint
```

## Setup recipe

```bash
cd <repo>
git worktree add .worktrees/<task> -b wt/<task>
cd .worktrees/<task>
```

Use a branch, not `--detach`. Commits on a detached HEAD are reachable only
from that worktree's HEAD; remove the worktree with `--force` before merging
and they become unreachable. A `wt/<task>` branch keeps them reachable until
you delete the branch yourself.

Then the four things that are always missing:

1. **Dependencies.** Symlink rather than reinstall:
   `ln -sfn <repo>/node_modules node_modules` (repeat for nested ones, e.g.
   `web/node_modules`).
2. **Ignore the symlink and the worktree dir.** A `.gitignore` entry with a
   trailing slash (`node_modules/`) does NOT match a symlink, and in a worktree
   `.git` is a FILE, so the per-worktree `info/exclude` is not the file git
   consults. `.worktrees/` itself shows as untracked in the main tree. Append
   both to the SHARED exclude:
   `printf 'node_modules\n.worktrees/\n' >> "$(git rev-parse --git-common-dir)/info/exclude"`.
   Verify with `git status --short` in both trees - a dirty tree makes a loop
   refuse to start.
3. **Gitignored config.** Harness manifests, judge specs, profiles and `.env`
   files are typically untracked, so the worktree does not have them. Copy them
   in, and rewrite any ABSOLUTE paths inside them to point at the worktree.
4. **Generated artifacts.** Anything gitignored that a build or codegen step
   produces (`dist/`, `tofu init` providers, generated clients) has to be
   regenerated in the worktree before sensors will pass.

## While you work

- **Commit early in the worktree.** A committed file is immune to every
  rollback mechanism above. The cost of an extra commit is nothing; the cost of
  a deleted 14KB doc is rewriting it.
- Keep the main tree clean of your work. If you already wrote into it, copy the
  file out (`/tmp`), unstage it (`git restore --staged <path>`), and delete it
  from the main tree so the other session's checkpoint does not swallow it.
- A worktree shares the object store and refs. That is what makes the merge
  free later, and it is also why `git worktree` is better than a second clone.

## Finish flow

```bash
cd .worktrees/<task>
git add -A && git commit -m "..."            # or several commits
cd <repo root>
git merge --ff-only wt/<task>                # or: git cherry-pick <sha> for a subset
git worktree remove .worktrees/<task>        # --force only if the symlink dirties it
git branch -d wt/<task>                      # -d refuses while anything is unmerged
```

Never `rm -rf` a worktree directory: it leaves a stale entry in
`.git/worktrees/` that confuses later `git worktree` calls. If you already did,
`git worktree prune` cleans up. Only ever remove paths under `.worktrees/` -
verify with `git worktree list` first.

## Notes

- Worktrees are often framed as a branch-management convenience; the reason
  they are mandatory here is concurrency safety, which is a different argument
  with different mechanics.
- A worktree is also the right answer for "try a risky refactor without
  disturbing the main tree", but that case tolerates being wrong. The
  concurrent-agent case does not.
