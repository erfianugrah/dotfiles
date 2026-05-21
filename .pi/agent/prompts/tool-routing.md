These rules override default tool intuition. Audit of past sessions shows the agent reaches for `websearch` / `bash` / `edit` / `grep` from habit and misses specialised tools that would do the job better. Follow as policy.

# Search-family pipeline

Applies to every search tool: `websearch`, `docs_search`, `codesearch`, `context7_resolve_library_id`, `lsp` workspace_symbol, `session_search`, `gh-search` skill.

- After 2 search calls on the same topic with NO drill-in (fetch / read / hover / definition), STOP searching. Open the most likely hit. Rewording the query a third time is the failure mode.
- NEVER claim a fact or make a recommendation from search-result snippets alone. Drill into the source first.
- If the user disputes a result, the next call MUST be a drill-in on the disputed source — not another search with new wording.

# Web research

- Making a recommendation / asserting a fact / answering a disputed question → `web_research` (auto search + fetch top results).
- Quick discovery only, no claims yet → `websearch`.
- Known URL → `webfetch`. If it returns empty/SPA-shell content, escalate to research crawler `:8889/fetch` with `force_js:true`.
- Local business / maps / reviews / opening hours → `web_research` with `mode: "local"` (forces Playwright on JS-heavy hosts).
- Freshness-sensitive (<1 week) → `web_research` with `mode: "fresh"` (livecrawl=preferred + SearXNG cross-check).
- Exa returns 0 useful results or errors twice → fall back to research SearXNG `:8888`.
- OSINT (domain / IP / email / username / phone / CVE / VirusTotal) → research skill `:8890/osint/*`. Not in `websearch` scope.
- Container image versions → `oci_tags`, NEVER `websearch`.
- Library API docs and framework concepts → `context7_query_docs`, NOT `websearch`. Resolve with `context7_resolve_library_id` first if no ID given.
- Code patterns across many repos → `codesearch` or `gh-search` skill, NOT `websearch`.
- NEVER `bash curl` a search engine.

# Documentation (docs.erfi.io)

- `/docs/<source>/` paths live on the docs.erfi.io server, NOT on local disk. NEVER `ls` / `find` / `cat` / `bash`-read them. Use `docs_sources` (verify source exists), `docs_find` (find by name), `docs_search` (find by content), `docs_read` (read content), `docs_grep` (regex), `docs_summary` (outline). Confusing the two is the #1 docs-tool mistake.
- Workflow is `docs_search` → `docs_summary` → `docs_read` with `offset` / `lines`. Skipping `docs_summary` on files >300 lines wastes tokens — don't.
- ALWAYS pass `source=` on `docs_search` when the source is known (it usually is).
- After 2 `docs_search` calls on the same topic with no read in between, STOP and `docs_read` the top hit.
- Disputed doc-based answer → `docs_read` (or `docs_grep` for inline context) on the source, not another `docs_search`.
- `docs_grep` with `path=/docs/<source>/` beats `docs_search` when you already know the source and want a specific phrase or symbol.

# Code intelligence

- Symbol definition / references / hover / call graph / implementation → `lsp`, NOT `grep` / `rg`. LSP is accurate; regex matches comments and strings.
- Workspace-wide symbol search → `lsp` workspace_symbol, not `rg`.
- Use `grep` / `rg` only for text patterns, comments, strings, log scans, and non-symbol matches.

# Subagent delegation (task)

Use `task` when:
- 2+ independent subtasks parallelizable (dispatch in one turn for concurrency).
- Large-context exploration that would pollute parent context (codebase summary, multi-file research, big log triage).
- Read-only deep dives where parent doesn't need every step.

Don't use `task` for: reading 1-3 known files, simple `grep`, work needing parent-session memory.

# Memory & session search

- Save to `memory` when: user states a preference, you discover a project convention, you spot a recurring pattern. `list` first to avoid duplicates; `update` rather than create when overlap.
- `session_search` BEFORE rebuilding context from scratch when the user references past work ("how did we do X last time?", "remember when...", "like before").

# Bash discipline

- File finding: `rg --files <root>` (parallel, gitignore-aware), NEVER `find` (hangs on the 18GB home tree).
- Edits on files >1000 lines or >100KB: `sd` / `sed -i` / `ast-grep --rewrite`, NOT `edit` (Edit/Write degrade; see opencode#20471, #19604).
- Multi-file pattern rewrites (5+ files): `ast-grep --rewrite` for AST precision, `sd` for plain text. Single `edit` per file is the slow path.
- Lockfiles (package-lock.json, pnpm-lock.yaml, Cargo.lock, poetry.lock): query with `jq` / `yq` / `rg`, NEVER full-read.
- Probe before reading unknown files: `wc -l file` or `stat file`. >300 lines → `read` with `offset` / `limit`, not full-file.
