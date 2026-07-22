---
name: git-troubleshooting
description: Use when a git command fails or behaves oddly - git mv, git add, git rm, or git checkout errors; messages like not under version control, pathspec did not match, or refusing to lose untracked file; files mysteriously absent from git status; gitignore-trap confusion; dirty-tree commit failures; or detached-HEAD recovery. Run this diagnostic battery BEFORE guessing at a fix.
---

# git-troubleshooting

Use this when a git command fails on a file that visibly exists, or when `git status` shows clean but operations behave as if a file is missing. The most common cause is **gitignore** — and the second-most-common is **wrong cwd**. Almost everything else is downstream of one of those two.

## The diagnostic battery

Run **all** of these in **one** bash call. Sequential probing across multiple round-trips is the most common cause of "five-minute investigation that should have taken thirty seconds":

```bash
pwd
git rev-parse --show-toplevel 2>&1
git status -uall --short                    # -uall shows untracked even inside untracked dirs
git ls-files <pat>                          # what's tracked
git check-ignore -v <pat> 2>&1 || true      # what's ignored, and by which rule
cat .gitignore 2>/dev/null
git log --oneline -5 -- <pat>               # was it ever tracked?
```

That's the full battery. You almost never need more.

## Symptom → cause table

| Symptom | First hypothesis | Probe |
|---|---|---|
| `fatal: not under version control, source=X` on `git mv` | X is gitignored | `git check-ignore -v X` |
| `error: pathspec 'X' did not match` | X is gitignored, untracked, or wrong cwd | full battery above |
| File visible on disk but absent from `git status` | gitignored | `git check-ignore -v X` |
| File visible on disk, absent from `git ls-files`, NOT in `git status` either | ignored | `git check-ignore -v X` |
| File in `git status` as untracked but `git add` does nothing | gitignored AND status `-uall` somehow showed it (unusual — verify) | `git check-ignore -v X; git config --get core.excludesfile` |
| `fatal: refusing to lose untracked file at 'X'` | destination is untracked | `ls -la X; git status -uall` |
| `fatal: not a git repository` | wrong cwd | `pwd; git rev-parse --show-toplevel` |
| `fatal: X: not a valid object name` | branch/tag/commit name typo | `git branch -a; git tag --list; git log --oneline -5` |
| `git commit` says "nothing to commit, working tree clean" but you just edited a file | edits are in an ignored file OR a different worktree | `git check-ignore -v X; git worktree list` |
| Detached HEAD after `git checkout <sha>` | not a bug — that's what checkout-by-sha does | `git switch -c rescue-branch` to attach |
| `git pull` says "Already up to date" but you expected changes | wrong remote/branch tracking | `git remote -v; git branch -vv; git fetch --all` |

## The gitignore trap (most common, deserves its own section)

```bash
# Symptom — you created plan.md, can't git mv / git add it:
$ git mv plan.md docs/plan.md
fatal: not under version control, source=plan.md, destination=docs/plan.md

# Probe:
$ git check-ignore -v plan.md
.gitignore:1:*.md  plan.md
#  ^^^^^^^^^^ ^^^^  ^^^^^^^
#  rule file  rule  matched path

# Three fixes — pick one:

# 1. Edit the rule (best if the rule is actually wrong)
sd '^\*\.md$' '' .gitignore                   # delete blanket rule
# then add specific patterns for what you actually want hidden

# 2. Force-track this one file (rule stays, exception for X)
git add -f plan.md

# 3. Whitelist with a negation (rule stays, but specific dirs allowed)
echo '!docs/**/*.md' >> .gitignore
echo '!**/README.md' >> .gitignore
```

**Anti-pattern**: blanket rules like `*.md`, `*.log`, `*.tmp` at the repo root. They silently swallow new files and confuse every agent that touches the repo. Prefer scoped rules: `scratch/`, `*.draft.md`, `**/*.log`.

## Renames and moves

`git mv` requires the source to be **tracked**. For untracked files, plain `mv` is correct — git only learns about renames at commit time anyway, via similarity detection.

```bash
# Tracked file → preserves rename detection
git mv src.md dst.md

# Untracked file → use plain mv, then add
mv src.md dst.md
git add dst.md

# Bulk move with mixed tracking — handle each branch
for f in *.md; do
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    git mv "$f" "newdir/$f"
  else
    mv "$f" "newdir/$f"
  fi
done
git add newdir/
```

**Anti-pattern**: chaining `git mv a b && git mv c d && ...` for a mix of tracked and untracked files. The first untracked one kills the chain mid-flight, leaving you in a half-moved state. Loop with the guard above instead.

## Wrong cwd

Symptom: every git command says "not a git repository" or operates on a sibling repo. Diagnose:

```bash
pwd                                         # where am I really?
git rev-parse --show-toplevel               # where does git think the repo is?
echo $OLDPWD                                # was I somewhere else recently?
```

Fix: `cd` to the right place. Don't `git -C` your way out of it — that just hides the bug for the next command.

## Dirty tree blocking an operation

```bash
# `git checkout <branch>` / `git pull` fails with "Your local changes would be overwritten":
git status --short                          # see what's dirty
git stash push -u -m "wip before checkout"  # -u includes untracked
# … do the operation …
git stash pop                               # bring changes back

# Or commit the WIP first:
git add -A && git commit -m "wip"
# … do the operation …
git reset HEAD~1                            # uncommit but keep changes staged
```

## Detached HEAD recovery

Not actually a bug. You're on a sha, not a branch.

```bash
git switch -c rescue-branch                 # attach to a new branch from current sha
# OR
git switch main                             # discard the detached state, return to main
git reflog                                  # if you committed in detached state and want it back
```

## When to give up on the working tree

Sometimes the cleanest fix is to throw away local state. Be explicit about what you're losing:

```bash
git status --short                          # see what's at risk
git diff > /tmp/last-resort-$(date +%s).patch   # backup, just in case
git reset --hard HEAD                       # discard tracked changes
git clean -fdx                              # nuke untracked + ignored + dirs
```

**Never** run `git clean -fdx` without first listing what it would delete: `git clean -ndx` (n = dry-run).

## Lockfile / index corruption

Rare. Symptom: `fatal: Unable to create '.git/index.lock': File exists` after a crashed git command.

```bash
ls -la .git/index.lock                      # confirm it's stale (no live git process)
ps -ef | rg git                             # really sure?
rm .git/index.lock                          # safe if no live git
```

If `.git/index` itself is corrupt: `rm .git/index && git reset` rebuilds it from HEAD.

## Don't reach for these unless you know why

- `git filter-branch` / `git filter-repo` — history rewrite. Slow, dangerous, ruins clones.
- `git update-ref` — manual ref manipulation. Bypasses safety checks.
- `git gc --aggressive --prune=now` — almost never the answer to anything.
- `git push --force` without `--force-with-lease` — clobbers others' work.

## See also

- `gh` skill — GitHub-specific (PRs, issues, releases)
- `gh-search` skill — cross-repo code/issue search
- `superpowers/systematic-debugging` skill — general debugging methodology (this skill is the git-specific specialization)
