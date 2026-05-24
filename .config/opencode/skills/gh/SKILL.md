---
name: gh
description: GitHub workflow operations via the `gh` CLI — PR lifecycle (create / view / merge / review), issue management, releases with assets, GitHub Actions runs + cache, repo + auth ops, gh extensions. Token-efficient `--json` + `--jq` patterns throughout. Sibling to `gh-search` (which covers cross-repo code/issue search). Use whenever the work involves a real PR / issue / release / Action run on a repo you own
---

# gh — full GitHub CLI workflow

`gh-search` covers search. This covers everything else. Both are sibling skills — `gh-search` for grep-the-world, `gh` for operate-on-your-stuff.

## Auth (do this first if anything fails)

```bash
gh auth status                                # check current scopes
gh auth refresh -s write:packages             # add a scope (e.g. for ghcr push)
gh auth refresh -s repo,workflow,gist         # multi-scope refresh
gh auth login --web                           # interactive browser flow
gh auth token | wl-copy                       # print + copy for ad-hoc use
```

Common scope gotchas:
- `write:packages` for ghcr.io image push
- `workflow` to dispatch / cancel runs
- `read:org` for org-only repos
- `gist` to create/edit gists

## PR lifecycle (the 90% of gh)

```bash
# create
gh pr create --title "..." --body "$(cat /tmp/pr-body.md)" --draft
gh pr create --fill                                # use commit msgs as title/body
gh pr create --reviewer user1,user2 --label bug    # assign + label upfront

# view + drill
gh pr list --json number,title,state,headRefName --jq '.[] | "#\(.number) \(.state) \(.title)"'
gh pr view 123 --json title,body,state,files --jq '.'
gh pr diff 123 --name-only                         # cheap: files changed
gh pr diff 123 -- path/to/specific.go              # drill: one file's diff
gh pr checks 123 --watch                           # live tail of CI
gh pr status                                       # PRs assigned to me

# edit + comment + review
gh pr edit 123 --add-label bug --remove-label triage --add-reviewer alice
gh pr comment 123 --body "LGTM after the typo fix"
gh pr review 123 --approve  # or --request-changes / --comment
gh pr review 123 --request-changes --body "..." --file review.md

# merge (your default is GPG-signed; gh respects commit.gpgsign)
gh pr merge 123 --squash --delete-branch           # squash + auto-cleanup
gh pr merge 123 --rebase --delete-branch           # rebase merge
gh pr merge 123 --auto --squash                    # merge once checks pass

# close without merging
gh pr close 123 --comment "Replaced by #128"
```

### Token efficiency

```bash
# Bad (paragraphs of prose):
gh pr view 123

# Good (structured + projected):
gh pr view 123 --json title,body,state,files,reviewDecision --jq '{title, state, decision: .reviewDecision, files: [.files[].path]}'
```

## Issue lifecycle

```bash
gh issue list --label bug --state open --json number,title,labels --jq '.[] | "#\(.number) \(.title)"'
gh issue create --title "..." --body "..." --label bug --assignee @me
gh issue view 42 --comments                                  # include thread
gh issue comment 42 --body "Reproduced on main, fix in #45"
gh issue edit 42 --add-label triage --add-assignee alice
gh issue close 42 --comment "Fixed in #45" --reason completed
gh issue reopen 42
gh issue lock 42 --reason resolved                            # disable new comments
```

Search → action handoff (cross-skill with gh-search):

```bash
# Find issues, then bulk-label them
gh search issues --owner <your-user> "state:open label:needs-triage" \
  --json number --jq '.[].number' | xargs -I{} gh issue edit {} --add-label triage
```

## Releases

```bash
# create with assets
gh release create v1.2.3 \
  --title "v1.2.3" \
  --notes-file CHANGELOG.md \
  --target main \
  dist/<binary>-linux-amd64 \
  dist/<binary>-darwin-arm64

# pair with git-cliff for auto-generated notes:
git cliff --tag v1.2.3 -o /tmp/notes.md && gh release create v1.2.3 --notes-file /tmp/notes.md

# draft (don't publish yet)
gh release create v1.2.3-rc1 --draft --prerelease

# upload assets to existing release
gh release upload v1.2.3 dist/<binary>-windows-amd64.exe

# delete (be careful — also deletes tag if --cleanup-tag)
gh release delete v1.2.3 --cleanup-tag
```

## GitHub Actions (workflows + runs)

```bash
# list workflows in current repo
gh workflow list --json name,state,id --jq '.[] | "\(.id)\t\(.state)\t\(.name)"'

# dispatch
gh workflow run "Build and Push" --ref main -f tag=v1.2.3

# see runs (token-efficient)
gh run list --workflow=ci.yml --branch main --json databaseId,status,conclusion,headSha,createdAt \
  --jq '.[:10] | .[] | "\(.databaseId)\t\(.status)\t\(.conclusion)\t\(.headSha[:8])"'

# follow a specific run
gh run watch <id>                              # interactive tail
gh run view <id> --log                         # full log dump
gh run view <id> --log-failed                  # only failed steps
gh run rerun <id>                              # retry
gh run rerun <id> --failed                     # retry only failed jobs
gh run cancel <id>

# download artifacts
gh run download <id> --name release-binaries -D /tmp/artifacts/

# Actions cache management (the one you actually hit)
gh cache list --json id,key,sizeInBytes --jq '.[] | "\(.id)\t\(.sizeInBytes)\t\(.key)"'
gh cache delete <id>
gh cache delete --all --repo <org>/<repo-name>   # nuke everything (you've done this)
```

## Repo ops

```bash
gh repo view <org>/<repo> --json description,topics,visibility,defaultBranchRef
gh repo edit --add-topic go --add-topic websocket --description "..."
gh repo clone <org>/<repo>                     # gh respects ssh by default
gh repo fork upstream/repo --clone                     # fork + clone
gh repo create new-thing --private --source=. --remote=origin --push
gh repo archive old-thing                             # archive (read-only)

# rulesets / branch protection (newer API)
gh api repos/<org>/<repo>/rules/branches/main --jq '.[].type'
```

## Aliases (you have these — `gh push` / `gh pull`)

Set / list:

```bash
gh alias list
gh alias set co 'pr checkout'                        # gh co 123
gh alias set --shell push '!git push && gh pr view --web || true'
```

The shell variant (`--shell`) lets you pipe / chain — useful for "push and open the PR" combos.

## Extensions

```bash
gh extension list
gh extension install <owner>/gh-<name>
gh extension upgrade --all
gh extension create gh-my-thing                       # scaffold your own (Go/script)
```

Notable extensions worth knowing:
- `gh-dash` — TUI dashboard for PRs/issues/notifications
- `gh-copilot` — Copilot suggest/explain in shell
- `gh-eco` — discover extensions

## Foot-guns (real ones)

- **GPG signing**: you require `-S`. `gh pr merge --squash` honours `commit.gpgsign=true` from global config. If gpg-agent times out during merge: cancel, unlock manually, retry — same recipe as direct git.
- **Scope drift**: `gh auth status` will look green but a specific operation 403s. Look at the operation's required scope (visible in API error) and `gh auth refresh -s <scope>`.
- **Default branch confusion**: `gh pr create` without `--base` assumes `main`. If you renamed to `master` / `develop`, pass explicitly.
- **Cache delete needs --repo when not in a checkout**: `gh cache delete --all` alone fails confusingly. Always pair with `--repo owner/name` when running outside the repo dir.
- **PR template not picked up**: `gh pr create --fill` ignores `.github/pull_request_template.md`. Use `--body-file .github/pull_request_template.md` explicitly.
- **`gh repo clone` defaults to SSH**: this is what you want; some CI envs need `gh repo clone --http`.
- **`gh release create` with file paths that don't exist** fails silently per file — use `ls dist/*` first to confirm.

## When to use which (gh vs gh-search vs raw API)

| Task | Tool |
|---|---|
| Find code patterns across all of GitHub | `gh-search` skill |
| Operate on your own repos' PRs / issues / releases | this skill (`gh` CLI) |
| Bulk read of issue/PR fields not in `--json` (e.g. `body_html`) | `gh api repos/x/y/issues/N --jq '...'` |
| GitHub Apps / OAuth flows / advanced auth | `gh api` + direct API docs |
| Issue / PR templates rendering | `gh issue create --body-file <template>` |

## TUIs to know exist (skip in agent context)

- `gh dash` — human-friendly dashboard
- `lazygit` — broad git TUI with gh integration via custom commands

For agent calls, prefer the `--json` + `--jq` pattern above. For human review of a complex PR queue, `gh dash` is faster than scrolling list output.
