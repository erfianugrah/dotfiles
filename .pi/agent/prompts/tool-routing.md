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
- Open-ended research where the answer is a SET of candidates (shopping, product comparison, vendor/tool/visa/location options, "alternatives to X", "should I buy") → the `open-ended-research` skill owns the METHOD (breadth-first longlist, eliminate-don't-select, adversarial pass, provenance matrix, widen-on-pushback). The first plausible answer is a lead, not a conclusion.
- User says "use the research tools/stack", or the task is non-coding web research (shopping, product comparison, local recommendations) → the `research` skill's self-hosted stack: SearXNG `https://searxng.erfi.io/search?q=...&format=json` (multi-engine; stronger than Exa for SG-local and long-tail results) plus crawler `https://crawler.erfi.io/extract` for page content. Read the research SKILL.md and drive it via `bash curl`. Exa (`websearch` / `web_research`) alone does NOT satisfy an explicit "use the research tools" request. These two self-hosted hosts are the ONLY carve-out to the "never bash curl a search engine" rule.
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
- **Zero-results path**: if `docs_search` returns `[no results for "..."]`, do NOT call `docs_sources` (that lists sources, it is not a search fallback). Instead: (1) retry once with a shorter/broader query, (2) if still 0 results try `docs_grep path=/docs/<source>/` for the key term. Only escalate to `web_research` after both fail. `docs_sources` is only for verifying a source exists — never as a search workaround.
- Disputed doc-based answer → `docs_read` (or `docs_grep` for inline context) on the source, not another `docs_search`.
- `docs_grep` with `path=/docs/<source>/` beats `docs_search` when you already know the source and want a specific phrase or symbol.
- Always cite the source path in your response to the user when answering from docs (e.g. `Source: /docs/supabase/guides/auth.md`). The path appears in `[source]` headers on `docs_read` output, in `docs_search` result rows, and in `docs_grep` match lines.

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
- `session_search` BEFORE rebuilding context from scratch when the user references past work ("how did we do X last time?", "remember when...", "like before"). For anything older than ~30 days or spanning opencode/claude as well as pi, use `memledger_search` instead - local session logs get pruned after 30d and memledger (Postgres, all clients) is the only full copy.
- `session_search` BEFORE bash+jq when the user message contains a path under `~/.pi/agent/sessions/`, references "previous session" / "where we left off" / "pick up from", or names a session UUID. The .jsonl is the storage format; the FTS5 index is the access path. Pasted bash transcripts referencing a session file are the canonical trigger — don't match the demonstrated tool register, route to the right tool.

## Bash discipline

- File finding: `rg --files <root>` (parallel, gitignore-aware), NEVER `find` (hangs on the 18GB home tree).
- Edits on files >1000 lines or >100KB: `sd` / `sed -i` / `ast-grep --rewrite`, NOT `edit` (Edit/Write degrade; see opencode#20471, #19604).
- Multi-file pattern rewrites (5+ files): `ast-grep --rewrite` for AST precision, `sd` for plain text. Single `edit` per file is the slow path.
- Lockfiles (package-lock.json, pnpm-lock.yaml, Cargo.lock, poetry.lock): query with `jq` / `yq` / `rg`, NEVER full-read.
- Probe before reading unknown files: `wc -l file` or `stat file`. >300 lines → `read` with `offset` / `limit`, not full-file.
- **Secrets: use, never print.** Run commands WITH credentials by var reference (`curl -H "X-API-Key: $COMPOSER_API_KEY" ...`) - the var NAME in the command is harmless. NEVER print resolved values: no `env` / `printenv` / bare `set` / `export -p` dumps, no `echo $KEY`, no `cat .env` to "check auth". To verify a var is set: `env | grep ^NAME | sed 's/=.*/=<set>/'`. The `secret-output-guard` extension blocks env dumps and redacts known secret values in tool results, but it only knows pi's own env - a key that lives only in a file can still leak if you print the file.

## CLI-wrapped pi tools (prefer over raw `bash`)

Pi has wrapper tools that return token-efficient structured output. Prefer them over the raw binary when both exist — the raw form floods your context window with prose; the wrapper returns just the actionable bits.

- **Vuln scan** → `osv_scan` (flattens to one line per CVE), NOT `bash osv-scanner` (paragraphs of nested JSON).
- **Leaked secrets** → `secret_scan` (truncates secrets to 12 chars in output — keeps full secrets OUT of your context), NOT `bash gitleaks detect` (full values leak into context). Use `backend="noseyparker"` for entropy/provenance scans, `scan_history=true` for git history.
- **HTTP integration test** → `hurl_test` (returns failed entries only with the failing assertion), NOT `bash hurl --test` (full request/response dump per entry).
- **Go tests** → `go_test` (returns failed-only with last 30 output lines per test), NOT `bash go test ./...` (full pass/skip/fail stream). Pass `run=` regex to narrow, `race=true` for race detector.
- **Benchmarks** → `bench` (statistical compare via hyperfine, returns winner + speedup), NOT `bash time` or `bash hyperfine` directly (table-formatted human prose).
- **OCI image tags** → `oci_tags`, NEVER `websearch` for container versions (the registry API is authoritative; web search returns stale blog posts).
- **PDF / scanned document** → `pdf` tool, NEVER `read` (pi's `read` handles text + images only, it cannot open a PDF) and NEVER `bash pdftotext`/model-vision-first. It diagnoses text-layer vs scanned (`pdffonts`) and auto-routes: born-digital → `pdftotext`, scanned → `tesseract` OCR. Use `mode:"visual"` to rasterize pages to PNG and `read` those only when layout/figures/tables need the model's eye.

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

- **Minimal-diff discipline (the ladder)**: before writing code, stop at the first rung that holds: (1) does this need to exist at all? speculative need = skip it, say so in one line; (2) already in this codebase? reuse the helper/util/pattern - re-implementing what lives a few files over is the most common slop; (3) stdlib does it? use it; (4) a native platform feature covers it (`<input type="date">` over a picker lib, CSS over JS, DB constraint over app code)? use it; (5) an already-installed dependency solves it? use it - never add a new dep for what a few lines can do; (6) one line? make it one line; (7) only then: the minimum code that works. The ladder runs AFTER understanding the problem, not instead of it - read the code the change touches and trace the real flow first; a small diff you don't understand is a confident wrong fix. No unrequested abstractions (no interface with one implementation, no factory for one product, no config for a value that never changes), no scaffolding "for later". Deletion over addition; boring over clever.
- **Bug fix = root cause in the shared function**: a report names a symptom. Grep every caller of the function you are about to touch; one guard in the shared function is a smaller diff than one guard per caller, and patching only the path the ticket names leaves every sibling caller still broken.
- **Never minimize away**: input validation at trust boundaries, error handling that prevents data loss, security measures, accessibility basics, hardware calibration knobs (the platform is never the spec ideal), anything explicitly requested. User insists on the full version - build it, no re-arguing.
- **Mark deliberate corner-cuts**: a simplification with a known ceiling (global lock, O(n^2) scan, naive heuristic) gets a `simplify:` comment naming the ceiling and the upgrade path - `# simplify: global lock; per-account locks if throughput matters`. Grep-able, honest, and the next agent knows exactly when to revisit.
- **Over-scoped request?** Ship the minimal version and question it in the same response: "Did X; Y covers it. Need full X? Say so." Never stall on an answer you can default.
- **Code answers: code first, then at most three short lines** - what was skipped and when to add it. Pattern: `[code] -> skipped: [X], add when [Y].` No feature tours, no design notes, no paragraphs defending a simplification. Requested explanation (a report, walkthrough, per-phase notes) is exempt - give it in full.

<!-- The ladder / marker / output-shape rules above are adapted from the
     ponytail skill (github.com/DietrichGebert/ponytail, MIT), stripped of
     its mode machinery and merged with the existing TDD/verification rules. -->

- **TDD where useful**: write tests before non-trivial business logic, complex algorithms, anything with multiple branches, or bug fixes (red test reproduces the bug, green test fixes it). Skip TDD for scaffolding, glue code, CLI plumbing, infra config, one-off scripts, prototypes you'll throw away. "No exceptions" TDD mandates fight pragmatism — the goal is correct code with appropriate test coverage, not ritual.
- **Verification before completion**: never claim "done" / "fixed" / "passing" without running the verification command in the same turn and quoting the relevant output. Evidence before assertions. The `verification-before-completion` skill has the full checklist when invoked deliberately.
- **Worktree cleanup**: only `git worktree remove` paths under `.worktrees/` or `worktrees/`. `cd` to the main repo root before removing. Verify the path with `git worktree list` first. Never `rm -rf` a worktree directly — it leaves a stale entry in `.git/worktrees/` that confuses git.
- **Scaffolding new projects**: when the user asks to start / scaffold / build a new project, invoke the `scaffold-new-project` skill rather than running an ad-hoc question loop. That skill orchestrates the relevant concrete-tech skills (`frontend-stack`, `infrastructure-stack`, `software-architecture`, `design-utilitarian`, `ci-workflows`) so user defaults are applied without re-asking.

## Agent-surface routing (registering skills / MCP servers / rules)

- **pi.dev is the primary harness. Claude Code is the user's WORK harness.** (opencode was retired 2026-08-15; its config tree is deleted - git history is the archive. The `opencode` PROVIDER in pi's auth is opencode-zen, the self-hosted gateway - that stays.)
- **New skill** -> `~/dotfiles/.pi/agent/skills/<name>/` (canonical). Promote to Claude Code only if work-relevant: per-skill symlink in `~/dotfiles/.claude/skills/`. NEVER promote private-corpus (mnemo, personal session data), media/GPU (comfyui/lora-train/whisper/arr/jellyfin), local-hardware (xikectl/eaves/gloryhole), or purely-personal (discord-wipe) skills to the work harness.
- **New MCP server**: with secrets -> `~/.pi/agent/mcp-bridge.json` (untracked, chmod 600, never commit); one project only -> `<repo>/.pi/mcp-bridge.json`; shared no-secret -> `~/dotfiles/.pi/agent/mcp-servers.json` (tracked, stow-linked to `~/.pi/agent/mcp-servers.json`; pi reads it via pi-mcp-bridge). Remote (HTTP) servers are NOT bridged - pi covers those with native extensions (context7, gh-search).
- **Claude Code MCP is a separate surface** (`claude mcp add` / `~/.claude/mcp/toolkit.ts`); CC never reads the pi registry. Private-corpus servers (mnemo) never go to work CC.
- **Rule changes**: universal rules go in BOTH `.pi/agent/prompts/tool-routing.md` (pi prepend; canonical since 2026-08-15) and `~/.claude/CLAUDE.md`. Full policy: `~/dotfiles/AGENTS.md` section "Agent-surface routing".

<!-- tool-routing:end - ~/.pi/agent/extensions/tool-routing.ts prepends only
     what is ABOVE this marker into pi's system prompt. Canonical home since
     2026-08-15: .pi/agent/prompts/tool-routing.md (ships inside the pi
     package, so package-only machines get the rules too). The Documentation +
     General-computer-use sections moved to .pi/agent/APPEND_SYSTEM.md on
     2026-08-09 to fix the double injection (pi natively loaded this whole
     file via the old ~/.pi/agent/AGENTS.md symlink while tool-routing
     prepended the top slice). The OpenCode-specific gotchas that used to
     live below this marker were deleted when opencode was retired
     (2026-08-15) - git history has them. -->
