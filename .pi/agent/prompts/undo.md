---
description: Roll back filesystem and git side-effects from the most recent assistant turn
argument-hint: "[scope or extra context]"
---

Undo the side-effects of your most recent assistant turn(s) in this repo.

Scope hint from user (if any): $ARGUMENTS — interpret loosely. Default scope: every file edit, new file, deletion, and unpushed commit you produced since the last user message.

## 1. Survey

One bash call:

```
git status --short; git log --oneline -10; git reflog -15; git stash list
```

Identify what you changed this turn:
- Modified tracked files
- New (untracked) files you created
- Deleted files
- New commits (not pushed) since the user's last input — use reflog timestamps + `HEAD@{N}` chain

## 2. Classify by recoverability

| Side effect | Recoverable? | How |
|---|---|---|
| Tracked file edit | yes | `git checkout -- <file>` |
| Untracked new file | yes | `rm <file>` |
| Tracked file deletion | yes | `git checkout -- <file>` |
| Unpushed commit | yes | `git reset --soft HEAD~N` (default) or `--hard` if user said "discard" |
| Pushed commit | no | STOP — needs force-push, ask user |
| `gh` / `curl` / external API write | no | STOP — list the calls, ask user |
| Container restarted / stack deployed / DNS edited / secret rotated | no | STOP — list it, ask user |

## 3. Plan, then confirm

Print a plan in this exact shape:

```
About to undo:
  revert       <file>          (N lines)
  delete       <file>          (untracked)
  restore      <file>          (was deleted)
  soft-reset   <N> commit(s)   <short-hashes>

NOT recoverable (skipped):
  gh pr create #42       — still open, close manually if needed
  ssh servarr docker ... — already executed

Proceed? Reply 'yes' to run, or narrow the scope.
```

WAIT for the user's confirmation. Do not run destructive commands until they say yes.

## 4. Execute, then verify

In order: working-tree restores first, untracked deletes, then commit reset. End with:

```
git status --short
```

Quote the output verbatim to prove clean state.

## Hard rules

- NEVER `git push --force` (or `--force-with-lease`) without explicit user instruction in this turn.
- NEVER touch files outside the current repo.
- If the turn that needs undoing is older than ~5 commits or ~30 minutes of reflog, stop and ask — that's beyond the safe automatic undo window. Show the reflog and let the user pick a target.
- If the working tree was already dirty before your turn (pre-existing uncommitted changes), distinguish carefully: only undo *your* edits, leave the user's untouched.
