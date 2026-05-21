---
description: Write a commit message matching this repo's style, then commit
argument-hint: "[extra context]"
---

Create a commit for the currently staged/unstaged changes that reads as if the human author wrote it.

Extra context from user: $ARGUMENTS

## Inspect

Run in parallel:
- `git status --short` — what's changed
- `git diff --stat` — scope overview
- `git diff --cached` — staged diff (if anything staged)
- `git diff` — unstaged diff
- `git log --pretty=format:'%s' -20` — repo's recent subject style
- `git log -1 --format='%B'` — most recent full message format

## Detect style

From the last 20 subjects, infer:
- **Conventional commits?** (`feat:`, `fix:`, `chore(scope):`) — match the prefix scheme exactly
- **Imperative mood?** ("add X" vs "added X") — most repos use imperative
- **Scoped?** (`area: change` like `pi: port LSP harness`) — replicate the scope vocabulary
- **Subject length** — match the repo's natural average; don't pad past it
- **Body convention** — does this repo write bodies? If 18/20 commits have only a subject, don't write a body. If bodies are common, write one.

## What to stage

- If something is already staged: commit exactly what's staged. Don't `git add` more without asking.
- If nothing is staged but there are unstaged changes related to a single intent: `git add -A` is fine for a feature commit but split if files are unrelated.
- Never stage files that likely contain secrets: `.env`, `*.pem`, `credentials.json`, `auth.json`, `secrets.env`. Warn the user if they specifically ask.
- Never stage lockfiles unless the package manifest also changed in this set.

## Message rules

- **NEVER** add `Co-Authored-By:` trailers naming Claude, Pi, opencode, or any AI tool.
- **NEVER** add "Generated with", "Created with", "🤖", or any AI-attribution footer.
- **NEVER** add marketing links (claude.com, anthropic.com, opencode.ai, pi.dev).
- Don't mention the assistant, model, or tool in the message unless the user explicitly asked for it.
- Focus on **why**, not what. The diff already shows what.
- 1-2 sentences for the subject + brief body, max. Match repo's average.
- Use the same casing/punctuation as recent commits (some repos lowercase subjects, some don't).

## Verify before committing

- Read the proposed message back to yourself: would a stranger reading the log next year understand the intent?
- Does it match the style of the last 5 commits visually?
- Are you sure no secrets are staged? Run `git diff --cached --stat` once more.

## Execute

```bash
git commit -m "subject" -m "body line 1
body line 2"
```

Use a HEREDOC if the body has nested formatting. After commit, run `git status` to confirm clean state.

## Failure modes

- If pre-commit hook **fails** or **rejects** the commit: fix the actual issue and create a NEW commit. NEVER `--amend` a failed commit.
- If pre-commit hook **auto-modifies** files (formatter, linter): verify with `git log -1` that HEAD is your commit, then `git add -A && git commit --amend --no-edit` is OK.
- If hook stages unrelated files: stop, show the user what got added, ask before proceeding.
