---
name: gh-search
description: Search public GitHub code, issues, PRs, repos, users, commits via the gh CLI. Use this instead of web search when looking for real-world code examples, API usage patterns across many repositories, or specific GitHub artifacts. Equivalent to grep.app for code search but works via gh's authenticated API (5000 req/hr rate limit). For code search, prefer this over Read/Glob/Grep on your local filesystem when you need cross-repository patterns.
---

# GitHub Search via gh CLI

Replaces the grep.app remote MCP. Uses the GitHub Search API via the `gh` CLI
(authenticated, 5000 req/hr). Works for code, issues, PRs, repos, users, and
commits across public GitHub.

## Setup

```bash
gh auth status                  # verify auth
gh auth login                   # if not authenticated
```

## Search code

```bash
# Find React hook patterns
gh search code 'useState' --language=typescript --limit 20

# Code in a specific repo
gh search code 'createPool' --repo=facebook/react

# Code in a specific path
gh search code 'export default function' --filename='*.tsx'

# Phrase matches
gh search code '"@deprecated since"' --language=python
```

Output: file path + line + match snippet for each hit. Use `--json textMatches,repository,path,sha` for machine-readable output.

## Search issues + PRs

```bash
# Open issues mentioning a bug
gh search issues 'flaky test' --state=open --label=bug --limit 20

# PRs on a specific repo
gh search prs 'auth' --repo=anthropics/anthropic-sdk-python --state=closed

# By author
gh search issues 'memory leak' --author=tj
```

## Search repos

```bash
# Trending repos in a language
gh search repos --language=rust --sort=updated --limit 10

# Repos by topic
gh search repos --topic=cli --topic=tui --stars='>1000'

# Owned by a user
gh search repos --owner=anthropic-experimental
```

## Common patterns by use case

### "How do developers handle X?"

```bash
gh search code 'getServerSession' --language=typescript --limit 20 --json textMatches,repository,path \
  | jq -r '.[] | "\(.repository.nameWithOwner)/\(.path)"' | sort -u | head
```

### "Real usage of this library API"

```bash
gh search code 'from "@anthropic-ai/sdk" import' --language=typescript --limit 30
```

### "Who else is patching this CVE?"

```bash
gh search code 'CVE-2024-12345' --filename='*.md' --limit 50
```

### "Find a working example of a config file"

```bash
gh search code '"@apollo/server"' --filename='package.json' --limit 10
```

## Output as JSON

```bash
gh search code 'tRPC' --language=typescript --limit 50 \
  --json textMatches,repository,path,sha \
  | jq '.[] | {repo: .repository.nameWithOwner, path, lines: [.textMatches[].fragment]}'
```

Useful fields: `textMatches[]` (fragment, matches[]), `repository` (nameWithOwner, isFork), `path`, `sha`.

## Filters quick reference

| Flag | What |
|---|---|
| `--language` | Language name (TypeScript, Python, Rust, etc.) |
| `--repo OWNER/NAME` | Restrict to one repo |
| `--owner USER` | Restrict to repos owned by user/org |
| `--filename PATTERN` | Match path pattern (e.g. `*.tsx`, `Dockerfile`) |
| `--limit N` | Max results (default 30, max 100) |
| `--sort` | `indexed`/`best-match` for code; varies by command |
| `--state` | `open`/`closed`/`merged` (issues + PRs) |
| `--label` | Issue/PR labels |
| `--author`/`--assignee` | User filters |

## Tips

- **Code search is approximate**: GitHub's index covers default branches only, files ≤ 384 KB, and `cb2dee...` SHA-tagged content. Edge cases get missed. If you don't find what you're looking for, try varying the query.
- **Quotes matter**: `'"exact phrase"'` (note shell quoting) for exact match. Bare query is OR-ed term-by-term.
- **Path filters before language filters**: `--filename` is the most powerful filter — use it early.
- **Auth**: needs `gh auth login` (read scope). Without auth you'll hit a much lower unauthenticated rate limit.
- **No private repos** by default — code search returns public only unless you've explicitly granted org access via SSO.

## Alternatives (for completeness)

- **`rg` locally**: when you have the code cloned, `rg` is faster + more flexible than this skill.
- **grep.app**: web UI for cross-repo search; was MCP-wrapped in the opencode setup but Pi has no MCP. Use this skill instead.
- **codeberg.org search**: federated alternative for non-GitHub code.

## Related

- gh CLI docs: https://cli.github.com/manual/gh_search
- API: https://docs.github.com/en/rest/search/search
