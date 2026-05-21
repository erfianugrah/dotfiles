---
description: Fetch, checkout, and review a GitHub PR end-to-end
argument-hint: "<PR-number|PR-URL>"
---

Fetch a GitHub PR, check it out locally, and produce a full code review.

Input: $ARGUMENTS

## Parse input

- Plain number → assume PR in the current repo (`gh pr view $1`)
- URL containing `/pull/N` → extract `owner/repo` + N
- Anything else → ask user to clarify

## Gather context (parallel)

Read all of these before touching the working tree:

```
gh pr view $ARGUMENTS --json title,body,state,files,labels,reviewDecision,mergeable,author,baseRefName,headRefName,commits
gh pr diff $ARGUMENTS --name-only
gh pr checks $ARGUMENTS
gh api repos/{owner}/{repo}/pulls/{N}/comments --jq '.[] | {path,line,body,user:.user.login}'
```

Surface:
- Title + author + branch (`headRefName → baseRefName`)
- CI status (any failing checks → flag them up front)
- Pre-existing review comments (don't repeat what someone already said)
- Mergeable status (if conflicts: tell the user before checkout)

## Checkout (only if user wants)

By default, just review against the diff fetched above. Don't pollute the local branch.

If the user explicitly says "check it out" / "test it locally" / requests test runs:

```bash
git stash push -m "pi-pr-stash-$(date +%s)" --include-untracked  # only if dirty
gh pr checkout $ARGUMENTS
```

After review, offer to return to previous branch + restore stash.

## Review

Apply the same logic as `/review` (read `~/.pi/agent/prompts/review.md` mental model):

- Project conventions from AGENTS.md
- Correctness, security, performance, maintainability
- Tests adequate? Match existing testing style?
- No AI attribution markers in commits
- For each existing inline comment: was it resolved? If not, what's the author's reply?

Specifically for PRs (beyond /review):

- **CI failures** — read the failed job logs via `gh run view --log-failed` and tell the user what's actually broken, not just "CI failed"
- **Author's commit history on this branch** — `gh pr view $N --json commits --jq '.commits[].messageHeadline'`. Are commits clean / squashed / messy? Suggest squash if many WIP commits.
- **Merge conflict risk** — if `mergeable` is false, run `git merge-tree $(git merge-base origin/$BASE HEAD) origin/$BASE HEAD` to preview conflicts
- **Scope creep** — does the PR title match what the diff actually does?

## Format output

```
PR #N: <title>
Author: @<login>  |  Branch: feature → main
CI: ✓ passing  |  Mergeable: ✓  |  Reviews: 1 approve, 0 changes-requested

## Summary
<2-3 lines on what this PR does>

## Blocking issues
<numbered list — or "none">

## Important
<numbered list — or "none">

## Nits
<bullet list — or "none">

## Recommendation
APPROVE | REQUEST_CHANGES | COMMENT

## Replying to existing inline comments
<for each unresolved comment: link + your take>
```

## Verification

Before claiming the review is done, run any spot-check that proves your claims (`rg`, `git log`, `gh api`). Evidence over assertion.
