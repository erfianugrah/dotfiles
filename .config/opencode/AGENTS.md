These rules override default tool intuition. Audit of past sessions shows the agent reaches for `websearch` / `bash` / `edit` / `grep` from habit and misses specialised tools that would do the job better. Follow as policy.

## Treat user messages as complete

Every user message in pi is sent deliberately and is complete as-sent. Do NOT infer "cut off", "trailed off", or "incomplete" from terseness, lowercase start, missing terminal punctuation, mid-list pastes, or references to context outside this session. Even if EARLIER user messages in this session looked fragmentary (e.g. pasted snippets opening mid-thought), that does NOT generalise to later messages — re-evaluate each message on its own.

If a referent is unclear:
- Ask ONE direct, specific question, OR
- Proceed with the parts that are clear and flag the assumption explicitly in the reply.

Never stall, hedge, or burn a turn on assumed truncation. This applies to extended-thinking blocks too: do not write "the user's thought got cut off" in your reasoning unless the message literally ends mid-word.

## Search-family pipeline

Applies to every search tool: `websearch`, `docs_search`, `codesearch`, `context7_resolve_library_id`, `lsp` workspace_symbol, `session_search`, `gh-search` skill.

- After 2 search calls on the same topic with NO drill-in (fetch / read / hover / definition), STOP searching. Open the most likely hit. Rewording the query a third time is the failure mode.
- NEVER claim a fact or make a recommendation from search-result snippets alone. Drill into the source first.
- If the user disputes a result, the next call MUST be a drill-in on the disputed source — not another search with new wording.

## Web research

- BEFORE reaching for `websearch` / `webfetch` / `web_research` on any technical topic, do a one-shot `docs_sources <topic>` check (or `docs_sources` with a 1-token filter like 'keycloak', 'cloudflare', 'tailwind'). If the source exists on docs.erfi.io (≥1 file), prefer `docs_*` first. Escalate to web tools when docs returns nothing useful, the topic is current-events / latest-versions / external state (npm registry, GitHub API), or after one drill-in proves docs lack the specific detail.
- Making a recommendation / asserting a fact / answering a disputed question → `web_research` (auto search + fetch top results).
- Quick discovery only, no claims yet → `websearch`.
- Known URL → `webfetch`. If it returns empty/SPA-shell content, escalate to research crawler `:8889/extract` with `force_js:true`.
- Local business / maps / reviews / opening hours → `web_research` with `mode: "local"` (forces Playwright on JS-heavy hosts).
- Freshness-sensitive (<1 week) → `web_research` with `mode: "fresh"` (livecrawl=preferred + SearXNG cross-check).
- Exa returns 0 useful results or errors twice → fall back to research SearXNG `:8888`.
- OSINT (domain / IP / email / username / phone / CVE / VirusTotal) → research skill `:8890/osint/*`. Not in `websearch` scope.
- Container image versions → `oci_tags`, NEVER `websearch`.
- Library API docs and framework concepts → `context7_query_docs`, NOT `websearch`. Resolve with `context7_resolve_library_id` first if no ID given.
- Code patterns across many repos → `codesearch` or `gh-search` skill, NOT `websearch`.
- NEVER `bash curl` a search engine.

## Docs tools (docs.erfi.io)

- `/docs/<source>/` paths live on the docs.erfi.io server, NOT on local disk. NEVER `ls` / `find` / `cat` / `bash`-read them. Use `docs_sources` (verify source exists), `docs_find` (find by name), `docs_search` (find by content), `docs_read` (read content), `docs_grep` (regex), `docs_summary` (outline). Confusing the two is the #1 docs-tool mistake.
- Workflow is `docs_search` → `docs_summary` → `docs_read` with `offset` / `lines`. Skipping `docs_summary` on files >300 lines wastes tokens — don't.
- ALWAYS pass `source=` on `docs_search` when the source is known (it usually is).
- After 2 `docs_search` calls on the same topic with no read in between, STOP and `docs_read` the top hit.
- Disputed doc-based answer → `docs_read` (or `docs_grep` for inline context) on the source, not another `docs_search`.
- `docs_grep` with `path=/docs/<source>/` beats `docs_search` when you already know the source and want a specific phrase or symbol.

## Code intelligence

- Symbol definition / references / hover / call graph / implementation → `lsp`, NOT `grep` / `rg`. LSP is accurate; regex matches comments and strings.
- Workspace-wide symbol search → `lsp` workspace_symbol, not `rg`.
- Use `grep` / `rg` only for text patterns, comments, strings, log scans, and non-symbol matches.

## Subagent delegation (task)

Use `task` when:
- 2+ independent subtasks parallelizable (dispatch in one turn for concurrency).
- Large-context exploration that would pollute parent context (codebase summary, multi-file research, big log triage).
- Read-only deep dives where parent doesn't need every step.

Don't use `task` for: reading 1-3 known files, simple `grep`, work needing parent-session memory.

## Memory & session search

- Save to `memory` when: user states a preference, you discover a project convention, you spot a recurring pattern. `list` first to avoid duplicates; `update` rather than create when overlap.
- `session_search` BEFORE rebuilding context from scratch when the user references past work ("how did we do X last time?", "remember when...", "like before").

## Bash discipline

- File finding: `rg --files <root>` (parallel, gitignore-aware), NEVER `find` (hangs on the 18GB home tree).
- Edits on files >1000 lines or >100KB: `sd` / `sed -i` / `ast-grep --rewrite`, NOT `edit` (Edit/Write degrade; see opencode#20471, #19604).
- Multi-file pattern rewrites (5+ files): `ast-grep --rewrite` for AST precision, `sd` for plain text. Single `edit` per file is the slow path.
- Lockfiles (package-lock.json, pnpm-lock.yaml, Cargo.lock, poetry.lock): query with `jq` / `yq` / `rg`, NEVER full-read.
- Probe before reading unknown files: `wc -l file` or `stat file`. >300 lines → `read` with `offset` / `limit`, not full-file.
- **Batch diagnostics in one bash call.** When investigating a failure with multiple cheap probes (`git status` + `git ls-files` + `git check-ignore`; `ps` + `ss` + `journalctl`; `df` + `du` + `lsblk`), separate them with `;` or newlines in a single call. Three-round-trip sequential probing is the most common cause of "five-minute investigation that should have taken thirty seconds". For git-specific failures see the `git-troubleshooting` skill.

## CLI-wrapped pi tools (prefer over raw `bash`)

Pi has wrapper tools that return token-efficient structured output. Prefer them over the raw binary when both exist — the raw form floods your context window with prose; the wrapper returns just the actionable bits.

- **Vuln scan** → `osv_scan` (flattens to one line per CVE), NOT `bash osv-scanner` (paragraphs of nested JSON).
- **Leaked secrets** → `secret_scan` (truncates secrets to 12 chars in output — keeps full secrets OUT of your context), NOT `bash gitleaks detect` (full values leak into context). Use `backend="noseyparker"` for entropy/provenance scans, `scan_history=true` for git history.
- **HTTP integration test** → `hurl_test` (returns failed entries only with the failing assertion), NOT `bash hurl --test` (full request/response dump per entry).
- **Go tests** → `go_test` (returns failed-only with last 30 output lines per test), NOT `bash go test ./...` (full pass/skip/fail stream). Pass `run=` regex to narrow, `race=true` for race detector.
- **Benchmarks** → `bench` (statistical compare via hyperfine, returns winner + speedup), NOT `bash time` or `bash hyperfine` directly (table-formatted human prose).
- **OCI image tags** → `oci_tags`, NEVER `websearch` for container versions (the registry API is authoritative; web search returns stale blog posts).

## Background / parallel work

When a task will take >30s OR you want pi to keep working in parallel, use the bg-tasks family instead of blocking pi's `bash` tool. **But default to a synchronous `bash` call when the work fits inside the 30s budget** — the user sees output in real time, no two-step bg_status drill-in, no orphaned tmux sessions to garbage-collect.

- **Decision rule**: if a single command will plausibly finish in ≤30s AND its output is small (<200 lines), use `bash`. Only graduate to `bg_bash` once it's clear the budget is busted (long build, polling loop, GH Actions watch). Wrong-side-of-the-line is the failure mode — the user sees "Working…", interrupts, then asks the agent to check directly anyway, which proves the bg_task layer added overhead without paying off.
- **Long bash work** (polling loops, builds >30s, slow downloads, anything that would hit pi's `bash` tool 30s timeout) → `bg_bash command="..."`. Returns the session name within ~100ms. Check progress with `bg_status name=...` later. Output streams live to the tmux pane AND a persistent log at `~/.pi/agent/bg-tasks/<name>.log` since 2026-05-28 — it survives the 30s tmux grace period and bg_wait cancellation.
- **GH Actions / Fly cert / k8s rollout watch loops** are the canonical `bg_bash` use case. `gh run watch <id>` and `flyctl certs check --watch` already block until completion — wrap them in `bg_bash` so pi's bash doesn't time out, then `bg_wait until_exit=true` for the result.
- **Delegated pi work** (multi-step task that benefits from another LLM brain, expected >5 min) → `bg_task prompt="..."`. Same lifecycle as bg_bash but spawns `pi -p` instead of bash. Pass `minimal=true` for read-only exploration with no extensions/skills loaded.
- **Read-only deep dive that must complete before continuing** → existing `task subagent_type="explore"` (blocks parent; cheaper than bg_task).
- **Check on running / recent tasks** → `bg_list` (one line per task with kind glyph π/$, status, elapsed). `bg_status name=...` for details + last N lines of output (also reads the persistent .log file post-mortem).
- **Wait for an event on a bg task** → `bg_wait name=... pattern="..." timeout=...` (or `until_exit=true`). Blocks server-side until the regex matches output, the task exits, or timeout elapses — replaces the re-prompt loop of `bg_status` → "check again" → `bg_status`. Use this whenever you spawned a bg task and the next step depends on something appearing in its output. Default timeout 300s; bump for slow CI / image builds.
- **Kill a runaway task** → `bg_kill name=...` (sets exit_code=-1 + completed_at=now in state JSON; persistent log preserved). Use when a polling loop is no longer needed or a bg_task has hung.
- **Anti-patterns**:
  - A `bash` call with `sleep N` loops or `for i in $(seq 1 N); do ... done` that runs >30s — use `bg_bash` instead.
  - Polling `bg_status` across successive turns — use `bg_wait` instead.
  - Wrapping a 5-second `gh run list` or `curl` in `bg_bash` because the agent assumed it'd take longer — just run it sync. The bg layer is overhead.
  - Spawning a bg task for something the user is actively watching in another terminal — the agent narrates progress they can already see, and the result still has to be hand-fetched via bg_status.
- **Context-hygiene**: when a single session is interleaving 2+ unrelated problem domains (e.g. git reorganization + storage rebuild + DNS debugging), park one via `bg_task` or a `task` subagent. Thrashing both in shared context degrades attention on each.

## Implementation discipline

- **TDD where useful**: write tests before non-trivial business logic, complex algorithms, anything with multiple branches, or bug fixes (red test reproduces the bug, green test fixes it). Skip TDD for scaffolding, glue code, CLI plumbing, infra config, one-off scripts, prototypes you'll throw away. "No exceptions" TDD mandates fight pragmatism — the goal is correct code with appropriate test coverage, not ritual.
- **Verification before completion**: never claim "done" / "fixed" / "passing" without running the verification command in the same turn and quoting the relevant output. Evidence before assertions. The `verification-before-completion` skill has the full checklist when invoked deliberately.
- **Worktree cleanup**: only `git worktree remove` paths under `.worktrees/`, `worktrees/`, or `~/.config/superpowers/worktrees/`. `cd` to the main repo root before removing. Verify the path with `git worktree list` first. Never `rm -rf` a worktree directly — it leaves a stale entry in `.git/worktrees/` that confuses git.
- **Scaffolding new projects**: when the user asks to start / scaffold / build a new project, invoke the `scaffold-new-project` skill rather than running an ad-hoc question loop. That skill orchestrates the relevant concrete-tech skills (`frontend-stack`, `infrastructure-stack`, `software-architecture`, `design-utilitarian`, `ci-workflows`) so user defaults are applied without re-asking.

## Documentation

Docs server at `docs.erfi.io` — 158 sources (docs + API specs), searchable markdown over SSH. Check docs before implementing/debugging.

**Always use custom `docs_search`, `docs_read`, `docs_grep`, `docs_find`, `docs_summary`, `docs_sources` tools.** No raw `ssh` or `Bash` for docs access.

### Sources

Full list of 158 docs.erfi.io sources is at `~/.pi/agent/prompts/docs-reference.md`.
For runtime lookup with current file counts use `docs_sources <filter>`.


### API Reference Sources

OpenAPI specs converted to per-endpoint-group markdown. Each has `api/overview.md` (endpoint index) + `api/{tag}.md` files.

authentik-api, aws-api, cloudflare-api, docker-api, flyio-api, gitea-api, keycloak-api, kubernetes-api, supabase-api, supabase-auth-api

**API lookup pattern:**
1. `docs_search(query="dns record", source="cloudflare-api")` — find endpoint group
2. `docs_grep(query="POST.*dns_records", path="/docs/cloudflare-api/")` — find exact endpoint
3. `docs_read(path="/docs/cloudflare-api/api/dns-records-for-a-zone.md")` — read full endpoint group

### Workflow: search -> summary -> targeted read

1. **Search** index for relevant files:
   `docs_search(query="row security", source="postgres")`

2. **Outline** promising file:
   `docs_summary(path="/docs/postgres/ddl-rowsecurity.md")`

3. **Read only needed section** (e.g. lines 27-61):
   `docs_read(path="/docs/postgres/ddl-rowsecurity.md", offset=27, lines=35)`

### Tools

| Tool | Purpose | When |
|------|---------|------|
| `docs_search` | Search titles+summaries | First step — find files fast (index ~15x smaller than raw docs) |
| `docs_summary` | Headings/outline of file | Before reading — find right section |
| `docs_read` | Read file or line range | After summary — read only what needed |
| `docs_grep` | Regex search + context lines | Find content within files |
| `docs_find` | Find files by name pattern | Know part of filename |
| `docs_sources` | List sources + file counts | Check what available |

### Reading the output

Tool output uses stable markers the agent should recognise:

- `[file] N lines, M bytes` — prefix on full `docs_read` results. Use this to decide whether to re-read with `offset`/`lines` next time.
- `**matched text**` — `docs_grep` wraps matched substrings in bold so match positions are visible without re-scanning.
- `(showing X of Y)` — truncation notice in `docs_search` / `docs_grep`. Narrow the query or raise `maxResults`.
- `[truncated N chars — use docs_read with offset/lines or docs_summary ...]` — output hit the 51K char cap. Follow the hint.
- `[error] command timed out ...` — server killed the command at 60s. Narrow path/regex; don't retry the same query.
- `[error] SSH connection failed: ...` — network issue. Retry after a short delay.
- `[no results for "..."]` — search found nothing after index + filename + content fallback. Try a different term or `docs_grep` across `/docs/`.

### Token tips

- `docs_search` searches index (~15x smaller than raw docs)
- `docs_summary` before `docs_read` — find right line range first
- `offset+lines`: 35 lines = ~140 tokens vs ~2K for full file
- `docs_read` with only `offset`: reads from that line to EOF (bat open range)
- `docs_grep` with source path: `docs_grep(query="RLS", path="/docs/postgres/")` faster than searching all
- `source` param: `docs_search(query="auth", source="supabase")` filters to one source
- API specs: `docs_read(path="/docs/{source}-api/api/overview.md")` for endpoint index

### Related source groups

Cross-reference groupings (API specs, auth & identity, cloud platforms, databases, etc.) live in `~/.pi/agent/prompts/docs-reference.md`. Read it when you need to find sources related to a topic.


## General computer use

Tool outputs become next-turn input tokens. Extract, don't dump. Probe before reading.

### Deciding question

- Static file → Read / specialized extractor
- Command output or stream → bash text utils fine

### Bash text utilities (cat/head/tail/sed/awk)

System prompt forbids these for file ops. They're fine on streams.

**Correct uses**:
- Pipeline ops: `cmd | head -20`, `cmd | awk '{print $2}'`
- Live tail: `tail -f log`
- Multi-file concat: `cat f1 f2 > combined`
- Heredoc scripts: `cat <<EOF > file`

**Wrong (always)**:
- Viewing static file → Read
- First/last N lines of known file → Read with `limit`/`offset`
- Piping file into tool → `tool < file` or `tool file`, never `cat file | tool`
- Editing source → Edit / sd / ast-grep --rewrite (never sed/awk)
- Tabular files → mlr / duckdb / dsq

### Editing tool selection

| Case | Tool |
|---|---|
| Single file, surgical change | Edit |
| Single file >~1000 lines or >100KB | `sd` / `sed -i` (Edit risks freeze: opencode#19604, #20471, #16115) |
| Same pattern across 5+ files | `ast-grep --rewrite` (AST-precise) or `sd` (text-only) |
| Simple text substitution, no Read first | `sd 'pattern' 'replace' file` |
| AST-precise rewrite (avoid strings/comments) | `ast-grep --pattern 'foo($X)' --rewrite 'bar($X)' --update-all -l ts` |
| Append to file | `cat <<'EOF' >> file` |
| Insert/delete by line range | `sed -i` with line addressing (GNU sed, no `''`) |
| Whole-file regen | Write |

**GNU sed recipes** (your `sed` is GNU 4.10):

```bash
sd 'old' 'new' big-file.md                              # simple substitution, no Read
ast-grep --pattern 'oldFn($X)' --rewrite 'newFn($X)' --update-all -l ts
sed -i '99a\new content here' file                      # insert after line 99
sed -i '100,200d' file                                  # delete lines 100-200
sed -i '/pattern/d' file                                # delete matching lines
perl -i -pe 's/old/new/g' file                          # complex regex
```

### After editing source code

Run formatter only if project has one configured (check `package.json` scripts, `Makefile`, `pyproject.toml`, `biome.json`, `.eslintrc*`, `.prettierrc*`, `ruff.toml`):

- TS/JS with `biome.json`: `biome check --write`
- TS/JS with `.prettierrc*`: `prettier --write` + `eslint --fix`
- Python with `ruff.toml` or `pyproject.toml` [ruff] section: `ruff check --fix && ruff format`
- Rust: `cargo clippy --fix --allow-dirty && cargo fmt`
- Go: `gofmt -w` (or `make fmt` if Makefile target exists)

### Token discipline

**Probe before reading**:
- Unknown size? `wc -l file` or `stat file` first
- >300 lines? Read with `offset`/`limit`
- Lockfiles (package-lock.json, pnpm-lock.yaml, Cargo.lock, poetry.lock): NEVER full-read — query with `jq`/`yq`/`rg`

**GitHub via gh**:
- `gh api repos/x/y/issues/N --jq '.title,.body'` over `gh issue view N`
- `gh pr view N --json title,body,state,files`
- `gh pr diff N --name-only` first, drill into specific files only when needed

**Git**:
- Recent commits: `git log --oneline -N`
- Subjects only: `git log --pretty=format:'%h %s' -N`
- Diff overview: `git diff --stat` then drill into files
- Status: `git status --short`
- Function history: `git log -L :funcName:file`
- Blame range: `git blame -L start,end file`

### Structured data extraction

| Format | Tool | Example |
|---|---|---|
| JSON known shape | `jq` | `jq '.field' file.json` |
| JSON unknown shape | `gron \| rg key` | `gron file.json \| rg apiKey` |
| YAML/TOML/XML | `yq` | `yq '.spec.replicas' k.yaml` / `yq '.deps' Cargo.toml` (auto-detect by ext) / `yq -p xml '.config' f.xml` |
| HTML | `htmlq` | `htmlq 'h1' --text < page.html` |
| CSV/TSV transforms | `mlr` | `mlr --csv stats1 -a mean -f price data.csv` |
| SQL on heterogeneous files | `dsq` | `dsq users.csv 'SELECT * FROM {} WHERE age > 30'` |
| Large CSV/Parquet/JSON | `duckdb` | `duckdb -c "SELECT col FROM 'f.csv' WHERE x>100 LIMIT 10"` |

### Search & discovery

- Filenames only: `rg -l pattern`
- Match counts: `rg -c pattern`
- Bloat protection: `rg --max-columns 200 --max-count 3`
- **File finding: ripgrep, never `find`.** `rg --files <root>` lists files (parallel, gitignore-aware, skips `node_modules`/sessions/.git). Filter by name with a second `rg`. Examples:
  - by name: `rg --files ~/.pi | rg -i '\.log$'`
  - by ext under scoped root: `rg --files -g '*.ts' ~/.pi/agent/extensions`
  - directories: `rg --files <root> | xargs -n1 dirname | sort -u | rg <pat>` (rare — reach for `fd -t d` only here)
  - `find` on this box hangs on the 18GB home + sessions tree even with `-maxdepth`. Only fall back to `find` for capabilities ripgrep lacks (e.g. `-newer`, `-printf`, `-mtime`), and only with an explicit narrow root.
- Inline context: `rg -C 3` (avoids follow-up Read)
- Code symbols: `ast-grep --pattern '...'` or `ctags -R` then query tags
- Directory overview: `eza --tree -L 2 --git-ignore`
- LOC stats: `tokei`
- Verify own edits: `git diff <file>`, not re-Read
- Test/build logs: `rg 'FAIL|Error|ERROR' output`, not Read whole log

### OpenCode-specific gotchas

- **Edit/Write degrade past ~100KB or ~1000 lines** (opencode#20471 O(N²) diff, #19604 silent Write fail, #16115 LSP socket deadlock, #10099 4MB freeze). For large files: `sd` or `sed -i`.
- **`/messages` payload bloat** with many edits on 4MB+ files (#14543) — kills browser. Avoid Edit cycles on bundled JS / generated files.
- **MCP tool timeout default 30s** (`packages/opencode/src/mcp/index.ts:36`). JSON-RPC -32001 = timeout. Bump via `mcp.<name>.timeout` (ms) in `opencode.json`.
