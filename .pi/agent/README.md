# Pi setup — `~/.pi/agent/`

This directory holds the Pi (pi.dev / earendil-works/pi-coding-agent) configuration
ported from the opencode fork. Most files are symlinks back to source-of-truth
locations under `~/dotfiles/.config/opencode/` (skills, AGENTS.md) or
`~/dotfiles/.pi/agent/` (Pi-specific).

## What's here

```
~/.pi/agent/
├── AGENTS.md          → ~/dotfiles/.config/opencode/AGENTS.md (shared with opencode)
├── APPEND_SYSTEM.md   → ~/dotfiles/.pi/agent/APPEND_SYSTEM.md (commit/safety rules)
├── models.json        → ~/dotfiles/.pi/agent/models.json (llama-server + 8 local models)
├── skills/            → ~/.config/opencode/skills (zero-copy: 18 top-level + 14 superpowers subskills)
├── extensions/        contains symlinks to ~/dotfiles/.pi/agent/extensions/ (37 single-file + lsp/ + session-fts/)
├── tests/             → ~/dotfiles/.pi/agent/tests/ (bun unit tests for pure helpers)
├── settings.json      → ~/dotfiles/.pi/agent/settings.json (defaultProvider/Model + theme)
├── prompts/           → ~/dotfiles/.pi/agent/prompts/ (6 slash-command templates)
├── themes/            → ~/dotfiles/.pi/agent/themes/ (opencode-dark high-contrast)
├── auth.json          (NOT tracked — runtime auth state)
├── sessions/          (NOT tracked — session JSONL files)
├── session-fts.db     (NOT tracked — SQLite FTS5 index, populated by worker)
├── bg-tasks/          (NOT tracked — detached pi task state, GC after 24h)
├── todos/             (NOT tracked — per-session todo JSON files)
├── style.json         (NOT tracked — /style command state)
└── memories.json      (NOT tracked — populated by memory extension)
```

## Extensions

Loaded from `~/.pi/agent/extensions/`; each file is a symlink back to
`~/dotfiles/.pi/agent/extensions/`. `.disabled` suffix opts a file out of
the loader without deleting it.

### Tool extensions (register new tools the LLM can call)

| Extension | Purpose |
|---|---|
| `apply-patch.ts` | Multi-file atomic patch envelope (Add/Update/Delete File). Two-phase commit via `*.applypatch-<rand>` tmps + rename so partial failures roll back cleanly. |
| `build-favicon-set.ts` | SVG/PNG → full PWA favicon artifact set + HTML head snippet. |
| `context7.ts` | `context7_resolve_library_id` + `context7_query_docs` via REST (anon tier; `CONTEXT7_API_KEY` for higher tier). |
| `docs.ts` | `docs_search` / `docs_read` / `docs_grep` / `docs_find` / `docs_summary` / `docs_sources` against docs.erfi.io via SSH. |
| `exa.ts` | `websearch` + `codesearch` via mcp.exa.ai (SSE-MCP). Auto-falls back to SearXNG (`SEARXNG_URL`) on empty / error. |
| `glob.ts` | File-pattern lookup wrapping `rg --files -g`. mtime-sorted, capped at 100. |
| `grep.ts` | Content search via `rg` (compatible with rg 15 — no more `--column=false` foot-gun). |
| `lsp/` | Language Server Protocol — 8 operations (hover/definition/references/implementation/document\_symbols/workspace\_symbol/incoming\_calls/outgoing\_calls) + auto-install for 14 languages via bun/go/cargo/rustup. |
| `memory.ts` | Persistent cross-session memory + per-LLM-call inject. mtime cache (no per-call disk read), `MEMORY_INJECT_MAX_BYTES` cap, `MEMORY_OFF=1` kill switch. |
| `oci-tags.ts` | Query OCI registries (Docker Hub, ghcr, quay) for image tags. |
| `question.ts` | Interactive question prompts during execution (skill-compatible). |
| `render-diagram.ts` | Render mermaid/d2 source to SVG/PNG via local CLIs. Validates syntax. |
| `session-search.ts` | Full-text search past sessions via SQLite FTS5 (worker-indexed) with ripgrep fallback. |
| `task.ts` | Spawn a `pi -p` subagent in isolated context. `explore` preset boots minimal (`--no-extensions --no-skills --no-prompt-templates` + `-e docs.ts`) for cheap read-only deep-dives. |
| `todowrite.ts` | TodoWrite tool surface; persists per-session JSON + status indicator. |
| `web-research.ts` | Exa search + auto-fetch top pages with Playwright fallback. Modes: default / local / fresh / crosscheck. |
| `webfetch.ts` | Fetch URL → markdown/text/html (5MB cap). Auto-escalates to crawler `:8889/extract` with `force_js:true` on SPA-shell responses (<500 visible chars). |

### CLI-wrapping tool extensions (token-efficient JSON output)

These wrap installed binaries from the agent toolkit (pacman/paru). Each
returns structured JSON via the tool's native `--json` flag and projects
only the fields pi actually needs — avoiding token waste on raw prose output.
Full usage examples + canonical invocations in [`TOOLKIT.md`](./TOOLKIT.md).

| Extension | Wraps | Returns |
|---|---|---|
| `osv-scan.ts` | `osv-scanner -r . --format=json` | Flattened vuln list: package, version, id, severity, fixed-in, summary. One line per (package, CVE). |
| `secret-scan.ts` | `gitleaks` (default) or `noseyparker` | Findings with rule/file/line. Secret values **truncated to first 12 chars** — full secrets never enter pi's context. |
| `hurl-test.ts` | `hurl --test --json <file>` | Compact pass/fail summary. On failure: per-entry method/URL/status + the assertion that failed. Variable substitution supported. |
| `go-test.ts` | `go test -json ./...` | Filters to failed tests + last 30 output lines per failure. Supports `run`, `race`, `count`, `short`, `timeout`. |
| `bench.ts` | `hyperfine --export-json` | Statistical benchmark across N commands. Returns mean/stddev/min/max/winner/speedup. |
| `bg-tasks.ts` (4 tools) | `tmux new-session -d` + `pi -p` / `bash` | Detached parallel work. `bg_task` spawns a pi subprocess, `bg_bash` runs any shell command (polling loops, long builds, slow downloads — anything past pi's 30s bash timeout), `bg_list` enumerates with kind glyphs (π/$), `bg_status` drills in. Plus `/bg-list` and `/bg-kill` slash commands. Skips amux's Claude-Code lock-in. |

### Event / behavior extensions (no LLM-visible tool surface)

| Extension | Purpose |
|---|---|
| `bookmark.ts` | `/bookmark` + `/unbookmark` for `/tree` navigation in long sessions. |
| `compaction-progress.ts` | Spinner + token-delta toast during `/compact` and auto-compaction. |
| `yank.ts` | `/y` (alias `/yank`) — copy ONE code block from the last assistant message to the system clipboard intact, bypassing terminal wrap. Terse syntax: `/y` (block 1), `/y 2`, `/y -1` (last), `/y ?` (list), `/y ^` (previous message), `/y 2^^` (block 2, two messages back). `/y 2!` = paste-friendly transform: ASCII-fold cosmetic Unicode (em-dash → `-`, smart quotes → ASCII, NBSP, ellipsis) so PS in CP437/CP1252 doesn't mojibake; strip comment-only lines; flatten line-continuations; join shell-family statements with ` ; ` so PowerShell parses the whole block atomically. Probes clip.exe (WSL) → pbcopy → wl-copy → xclip → xsel → termux → OSC 52 fallback. Sibling to built-in `/copy` (which grabs the whole message). |
| `git-gh-gate.ts` | Confirms mutating git/gh commands; protects `.git/` from direct writes; **also inspects apply\_patch envelopes** so apply\_patch can't bypass the gate. |
| `inline-bash.ts` | Expand `!{cmd}` patterns inside user prompts before send. |
| `local-model-rules.ts` | Per-model rules for gemma/qwen (LaTeX ban, parallelism, anti-loop). |
| `migrate-sessions.ts` | `/migrate-sessions [args]` — backfill opencode → Pi sessions. |
| `notify.ts` | Desktop ping on `agent_end` (OSC 777 / OSC 99 / Windows toast). Skipped when stdout is not a TTY so it doesn't pollute `pi -p --mode json`. |
| `session-auto-title.ts` | Auto-generate session names via a cheap model after first user message. models.json mtime-cached. |
| `session-fts/` | SQLite FTS5 indexer + worker thread. Indexes session jsonl off the main loop; `/session-index status|rebuild|gc`. |
| `session-name.ts` | `/session-name <label>` — readable identifiers in `pi -r`. |
| `session-summary.ts` | Generates session summary on demand. |
| `style-toggle.ts` | `/style` command for terse ↔ socratic output style; injects style prompt via `context` event. |
| `superpowers.ts` | Intent-gated injection of obra/superpowers methodology. `SUPERPOWERS_OFF=1` to disable. |
| `tool-guard.ts` | Block-with-reason on common anti-patterns (`bash ls /docs/`, `webfetch <docs.erfi.io>`, etc) + per-session reformulation-loop detection. **Also inspects apply\_patch envelopes** so .env / lockfiles / .git / node\_modules can't be bypassed. |
| `tool-routing.ts` | Prepend AGENTS.md tool-routing rules to the system prompt with hard "CRITICAL MANDATORY" framing. |
| `trigger-compact.ts` | Auto-compact when context crosses 100k tokens + `/trigger-compact`. |

## Prompt templates (slash commands)

| Template | Purpose |
|---|---|
| `/init [focus]` | Guided AGENTS.md setup (Pi-aware: docs.erfi.io refs, `.pi/agent/` paths, stricter "would agent miss this?" filter) |
| `/review [target]` | Review uncommitted / commit / branch / PR — defaults to uncommitted; gh-aware for PRs |
| `/commit [context]` | Inspect repo's recent log style → write commit matching it. Blocks AI attribution per APPEND_SYSTEM rules |
| `/pr <num\|URL>` | Fetch + review GitHub PR end-to-end; reads CI status + existing inline comments |
| `/test [filter]` | Detect toolchain (cargo/bun/pnpm/pytest/go/etc) → run targeted tests for the diff |
| `/local-model-rules` | Inject per-model rules when running gemma/qwen on llama-server |

### Disabled

| Extension | Why |
|---|---|
| `custom-footer.ts.disabled` | Pi's default footer now handles cache-aware token totals (`R` / `W` segments) natively. The custom footer's only remaining value was moving session-name to the right, which wasn't worth replacing the entire footer. Kept as a `.disabled` file in case we want to revisit. |

## Themes

| Theme | Source |
|---|---|
| `opencode-dark` | dotfiles — VS Code Dark+ palette with brighter contrast than Pi's built-in `dark` |
| `dark` `light` | Built-in (Pi) |

Switch via `/settings` or set `"theme"` in `settings.json`.

## Skills

All skills live in `~/.config/opencode/skills/` and are reused zero-copy.
List loaded at startup; each has its own `SKILL.md` with the actual rules.

| Skill | Purpose |
|---|---|
| `caddy` | Custom xcaddy build + WAF management stack (Caddyfile snippet idiom, TSIG/rfc2136 secret chain, wafctl, Authelia, the `make restart` vs `make restart-caddy` SOPS footgun). Sibling to `knot-dns`. |
| `ci-workflows` | GitHub / Gitea Actions workflows, action pinning, CI patterns. |
| `cloudflare` | Cloudflare API + `wrangler` CLI (Workers / Pages / R2 / D1 / KV / Tunnels) + bulk Python automation + `cf-terraforming` import workflow. Pairs with `terraform`. |
| `comfyui` | ComfyUI image-gen via llm-compose proxy on `localhost:11434`. |
| `composer` | Self-hosted Docker Compose management platform (your deployed instance). |
| `design-utilitarian` | McMaster-Carr-style information-dense UI ethos. |
| `docker` | Dockerfile authoring, buildx (multi-arch + cache mounts + secrets), image inspection, registry workflows, container debugging. Companion to `infrastructure-stack` (Compose) and `composer` (GitOps). |
| `favicons-and-icons` | Favicon + PWA icon set generation. |
| `fly` | Fly.io app lifecycle via `flyctl` — deploy, secrets (Vaultwarden → flyctl set), certs + DNS, machines, volumes, scaling, debug, cost knobs. |
| `frontend-stack` | Astro/React/Next scaffolding with biome + tanstack + shadcn. |
| `gh` | Full GitHub CLI workflow — PR lifecycle, issue ops, releases with assets, Actions runs + cache, auth scopes, repo ops, extensions. Sibling to `gh-search`. |
| `gh-search` | Cross-repo GitHub code/issue/PR search via `gh search`. Sibling to `gh` (which covers everything-but-search). |
| `gloryhole` | Self-built DNS server `glory-hole` — Go binary + embedded Unbound + Astro/React dashboard. Pi-hole-style filtering, expr policy engine, sharded LRU cache, REST/WS API, DoT/DoH. Home + Fly deploy profiles. |
| `infrastructure-stack` | Docker Compose with bridge-network + static-IP + host-mode-Caddy.
| `knot-dns` | Self-hosted authoritative DNS — Knot DNS on Fly anycast, TSIG/rfc2136 to Caddy, CF→Knot migration. Sibling to `fly`, `cloudflare`, `caddy`. |
| `lora-train` | kohya sd-scripts LoRA training via proxy on `localhost:11434`. |
| `mermaid-d2` | mermaid / d2 diagram authoring + render via local CLIs. |
| `research` | SearXNG (`:8888`) + Playwright crawler (`:8889`) + OSINT (`:8890`). |
| `software-architecture` | DDD-lite system design for Go backends + full-stack apps. |
| `supabase` | Supabase products (Database / Auth / Storage / Realtime / Edge Functions / pgvector / pgmq / Branching) + `@supabase/server` BFF patterns + RLS + migrations + connection pooling + Postgres extensions. |
| `supabase-postgres-best-practices` | Postgres perf + index choice + connection management + RLS patterns. |
| `tailscale-homelab` | SSH into and operate the homelab over Tailscale — identity-file convention, dual `10.0.X.Y` / `10.68.X.Y` alias pattern, MagicDNS, ACL grants, failure-mode diagnostic order. Cross-references every other infra skill. |
| `terraform` | OpenTofu / Terraform — module structure, R2/S3 state backends, SOPS+age secrets, `import` blocks, Cloudflare provider patterns, `for_each` + `dynamic` block recipes. |
| `whisper` | whisper-transcribe HTTP API on `localhost:7860`. |
| `superpowers/` | 14 subskills (obra/superpowers v5.1.0 via `superpowers-sync`): brainstorming, TDD, systematic-debugging, writing-plans, executing-plans, receiving / requesting code review, finishing-a-development-branch, using-git-worktrees, dispatching-parallel-agents, subagent-driven-development, verification-before-completion, writing-skills, using-superpowers. |

## What's intentionally NOT in this directory

- **Sessions**: per-machine state. Migrated from opencode via `bin/opencode-to-pi-sessions`.
- **Auth**: `auth.json` is runtime — log in via `pi /login` or env var.
- **Memories**: `memories.json` is per-machine personal context. Don't sync.
- **Image compression extension**: deferred. Pi/Anthropic handles up to 5MB images natively; opencode's jsquash compression saves tokens but isn't critical. Add as Pi package when needed.

## Daily workflow

```bash
pi                          # start interactive TUI
pi -p "quick question"      # one-shot non-interactive

# Sessions
pi -r                       # browse migrated + new sessions
pi -c                       # continue most recent

# Customize
/style                      # toggle terse ↔ socratic
/skill:test-driven-development  # explicitly load a skill
/session-name <label>       # name session for pi -r selector
/bookmark [label]           # bookmark last assistant message
/trigger-compact            # compact conversation now (auto at 100k)
/session-index status       # FTS5 indexer state (also: rebuild | gc)

# Model switching
/model                      # full model picker (or Ctrl+L)
/scoped-models              # edit which models appear in Ctrl+P cycle (saves to settings.json)
Ctrl+P / Shift+Ctrl+P       # cycle forward/back through enabled models
```

## Migrating new opencode work to Pi

When you create new opencode sessions you want to bring across:

```bash
~/dotfiles/bin/opencode-to-pi-sessions --db prod    # re-runs, skips existing
```

## Customising further

Edit the source-of-truth files in `~/dotfiles/.pi/agent/`. Pi hot-reloads:

```
/reload                     # in TUI, reloads extensions / skills / prompts
```

## Tests

Unit tests for the pure parsers in each extension:

- tool-guard segment splitter + apply_patch path extraction
- apply-patch envelope parser
- oci-tags image parser + version compare
- session-search tokenizer
- session-fts query tokenizer
- osv-scan JSON parser
- secret-scan gitleaks + noseyparker parsers
- hurl-test JSON parser
- go-test JSON event parser
- bench hyperfine output parser
- bg-tasks duration formatter + slug generator

```bash
~/dotfiles/.pi/agent/tests/run.sh        # all (86 tests)
~/dotfiles/.pi/agent/tests/run.sh -t "tool-guard"   # filter
```

The runner preloads `tests/preload.ts` which `mock.module()`s the
`@earendil-works/pi-*` SDK packages — they're baked into the pi binary
and not separately resolvable from bun. Pure-helper tests don't actually
call the mocked functions; the stubs just satisfy the module top-level
imports.

## Useful env

```bash
# Methodology / context injection
SUPERPOWERS_OFF=1                 # disable superpowers methodology injection entirely
SUPERPOWERS_MINIMAL=1             # inject the 4-essential-skill version (~250 tok, vs ~1.4k full)
SUPERPOWERS_BOOTSTRAP=<path>      # custom using-superpowers SKILL.md path
SUPERPOWERS_INTENT=<regex>        # override intent-match regex (forces inject on match)
MEMORY_OFF=1                      # don't inject memories into context
MEMORY_INJECT_MAX_BYTES=8000      # cap on injected memory block (oldest dropped)

# External services (defaults are localhost services on the dev box)
EXA_API_KEY=<key>                 # Exa MCP higher-tier auth (anonymous works without)
CONTEXT7_API_KEY=<key>            # context7 higher-tier auth
SEARXNG_URL=http://localhost:8888 # research SearXNG (exa fallback + web_research)
CRAWLER_URL=http://localhost:8889 # research Playwright crawler (webfetch SPA escalation)

# Pi runtime
PI_OFFLINE=1                      # disable startup network checks (update + telemetry)
PI_SKIP_VERSION_CHECK=1           # only disable the version-check ping
PI_VERBOSE=1                      # verbose subagent stderr in task.ts
```

## See also

- [`TOOLKIT.md`](./TOOLKIT.md) — Reference for the 33-binary agent toolkit + 6 CLI-wrapping extensions + workflows. Token-efficient invocation patterns, bg-task usage, when to use each editing strategy, template for new extensions.
- [`AGENTS.md`](./AGENTS.md) — Tool-routing rules, docs.erfi.io conventions, bash discipline.
- [`APPEND_SYSTEM.md`](./APPEND_SYSTEM.md) — Commit authorship, safety rules, Unicode-output rules.
- Pi docs: `/opt/pi-coding-agent/docs/` (extensions.md, skills.md, models.md, etc.)
- Pi examples: `/opt/pi-coding-agent/examples/extensions/`
- Upstream: https://pi.dev / https://github.com/earendil-works/pi
