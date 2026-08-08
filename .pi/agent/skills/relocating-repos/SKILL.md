---
name: relocating-repos
description: Use when moving, renaming, or consolidating directories or git repos on a machine - "move X into Y", merging dirs into a parent, "these should live together", "tidy up this directory tree". Covers the pre-move entanglement survey, the cross-tree reference sweep, and post-move verification. Prevents the classic failures: stale path references in configs/docs, lost git worktrees, dirty-tree data loss, symlinked-vs-real config copy drift. NOT for single-file moves inside one repo (plain mv is fine) or cross-machine transfers.
---

# Relocating Repos

## Overview

Moving a directory is trivial (`mv` is atomic on the same filesystem and preserves
dirty git state). The failures are NEVER in the move - they are in what still
points at the old path afterwards, and in entanglements you didn't know existed
before the move. The workflow is always: survey -> sweep -> move -> update ->
verify -> record.

## The workflow

### 1. SURVEY - before moving anything

Inventory every candidate dir (`survey.sh <dir>...` in this skill's dir does
the mechanical part). You are looking for:

- **Dirty trees** - mv preserves them, but KNOW they exist. Pre-existing dirt
  mixed with your own later edits in the same repo = surgical staging needed
  (see Common mistakes #6).
- **Worktrees** (`git worktree list`, more than the main entry) - the #1
  silent killer. A worktree's metadata hardcodes BOTH paths (main repo .git
  dir and worktree dir), so moving either side orphans the other. Decide per
  worktree BEFORE moving, two valid outcomes:
  - **Retire it** (stale, finished work): verify `git log origin/main..HEAD
    --oneline` is empty (no unpushed commits) and `git status --short` is
    clean, then `git worktree remove <path>` - NEVER `rm -rf` (leaves stale
    .git/worktrees/ metadata).
  - **Keep it** (active branch): move as normal, then
    `git -C <new-main-path> worktree repair <worktree-path>` - git rewrites
    the pointer pair. Verify with `git -C <worktree-path> status`.
  `git worktree repair` is easy to forget exists - it is the difference
  between "the move broke my worktree" and a 2-second fix.
- **No-remote repos** - local-only state. Moving is fine, but flag it: no
  upstream backup exists.
- **Big gitignored data inside** (multi-GB caches, docker volumes, node_modules)
  - mv handles it, but `git status` hides it; know what you're actually moving.
- **Workspaces** - is the dir one repo, or a container of several with its own
  docs (a workspace)? Moving one child out breaks the workspace's docs and
  cross-references; moving the whole workspace keeps it intact. ASK THE USER
  which they want before assuming.

### 2. SWEEP - find every reference to the old path BEFORE moving

Do the reference sweep first so you know the full blast radius. Build the
sweep list from the machine you're on - anywhere paths get written down:
shell rc files, editor/agent configs, CI/deploy configs, systemd units,
cron, docs, sibling-repo cross-references. Generic form (`OLDNAME` is a
placeholder for the dir being moved):

```bash
rg --hidden -l 'OLDNAME' <config-dirs> <docs-dirs> <sibling-repos>
```

**`rg --hidden` is MANDATORY whenever hidden config dirs are in scope**
(dotdirs like `.config`, `.pi`, `.ssh`, `.claude`). Plain `rg` skips hidden
dirs and will report "clean" while a dozen config files still reference the
old path. This exact failure happened live.

Don't forget references FROM the moved repos themselves - build files,
compose files, Makefiles, docs cross-referencing sibling repos.

### 3. MOVE

```bash
mv /old/path /new/path   # same filesystem = atomic rename, keeps .git + dirty state
```

Verify immediately after: `git -C <newpath> log --oneline -1` and
`git -C <newpath> remote get-url origin` per repo. Moving across filesystems?
That's copy+delete, not rename - rsync first, verify, then delete.

### 4. UPDATE REFERENCES

For each old -> new mapping, rewrite with a literal-string replacer over an
EXPLICIT FILE LIST:

```bash
files=$(rg --hidden -l 'OLDNAME' <sweep-targets>)
sd -F 'OLDNAME' 'NEWNAME' $files     # or: perl -pi -e 's/\QOLD\E/NEW/g' $files
```

**Do NOT pass directory args to `sd`.** `sd -F old new dir/` has silently
skipped files in practice; only files passed explicitly were rewritten.
Always expand the list with `rg -l` first, then check `git status` to confirm
the expected files actually changed.

**Symlinked vs real config copies:** dotfile managers (stow, chezmoi, etc.)
mean some configs are symlinks to a source repo - edit the SOURCE and the
live copy follows. But there are always exceptions: a config that is a real
file despite the symlink convention. For any config you edit, check with
`ls -la` whether it's a link; if it's a real file, find its tracked source
copy and update BOTH, then `diff` to prove sync. Otherwise the drift bites
weeks later.

**Word-boundary care:** anchor patterns so a repo name that is also a common
word doesn't rewrite prose (e.g. replace `~/composer/` with the trailing
slash, never bare `composer`).

### 5. VERIFY

`verify.sh <dir>...` for the moved repos, then cross-tree checks:

```bash
# old path gone from every swept location
rg --hidden -l 'OLDNAME' <sweep-targets> || echo CLEAN
# no broken symlinks in config trees that referenced the old path
find -L <config-dirs> -type l
# any edited structured config still parses
python3 -c "import json; json.load(open('<file>.json'))"   # jq/yq for other formats
# anything that hardcoded the old path resolves at the new one
ls <each-hardcoded-target-at-new-path>
# nothing left behind
ls -d /old/path 2>/dev/null || echo "none left"
```

### 6. RECORD

- Update the container dir's README/AGENTS.md (if there is one) with the new
  layout and the date of the move.
- Tell your future self: update runbooks/notes/memories that carry the old
  path, including a "references to OLDNAME are stale" note - notes are read,
  not grepped.
- Commit reference updates SEPARATELY from any pre-existing uncommitted work
  in the affected repos.

## Common mistakes (all hit live)

| # | Failure | Fix |
|---|---|---|
| 1 | Sweep missed a hidden config dir entirely | Always `rg --hidden` |
| 2 | `sd old new dir/` silently skipped files | `files=$(rg -l ...)`; `sd old new $files` |
| 3 | Edited the live config only; the tracked source copy drifted | Check symlink vs real file; edit both, `diff` to prove sync |
| 4 | Worktree entanglement discovered mid-move | Survey first; `git worktree list` on every candidate |
| 5 | Assumed a dir was one repo; it was a multi-repo workspace | `ls` the parent, read the parent's docs, ask the user |
| 6 | Pre-existing uncommitted work mixed with my path edits | Stage selectively per-file; for one-hunk files: `git diff -- <f> \| awk '/^@@/{c++} c<=1' \| git apply --cached`. Leave other people's dirt dirty |
| 7 | Path-keyed tooling (hooks, guards, caches) re-triggered at the new path, misread as a new problem | Expected behaviour; re-confirm and proceed |

## Red flags - STOP and re-survey

- "I'll just mv it, it's quick" - the move is never the hard part
- A `git worktree list` you haven't read the output of
- Reference sweep done without `--hidden` when dotdirs are in scope
- `git status` shows files you did NOT touch - do not bulk-commit
- Old path still exists after the move (`ls -d /old/path` succeeds)
- "The docs/configs will be fine" - they are the most common stale-path site
