# Porting the pi harness to Claude Code

Status: IMPLEMENTED - merged to main 2026-08-12 (PR #1, 20 commits). The
topology below is live: shared cores in `.pi/agent/extensions/lib/`, thin pi
adapters, `.claude/mcp/toolkit.ts` (22 MCP tools), `.claude/hooks/` (11 guard
hooks), `.claude/commands/` + `.claude/skills/` symlinks, and `install.sh
do_claude()` wiring MCP registration + hooks merge.

## Goal

The dotfiles repo should support **both pi and Claude Code (CC) automatically**:
one `install.sh` / `stow` on any machine wires up both harnesses from a single
source of truth, with no per-harness manual step and no divergent copies of the
logic. The output of this doc is the dual-harness topology, a per-extension
decision (port / skip / native), a refactor pattern that keeps one copy of the
logic, and a loop-consumable phased checklist.

## Dual-harness by construction (the stow topology)

This is already how skills work - we extend the same pattern to tools + guards.

Facts established from the live repo (2026-08-11):

- `install.sh` runs `stow -d $DOTFILES -t $HOME` unconditionally on every OS
  branch. So `.claude/` and `.pi/` in the repo are BOTH linked into `~` on
  every machine. Neither harness needs detection - each reads only its own dir.
- **Source of truth is `.pi/agent/`** (real files: `extensions/`, `skills/`,
  `extensions/lib/`).
- **`.claude/` holds thin links/adapters back into it.** Already true for
  skills: `.claude/skills/caddy -> ../../.pi/agent/skills/caddy` (curated
subset: the promoted per-skill symlinks - `.claude/skills/` IS the allowlist,
see repo AGENTS.md "Agent-surface routing"). opencode does the whole dir: `.config/opencode/skills ->
  ../../.pi/agent/skills`.
- No tracked `.claude/settings.json` or `.mcp.json` exists yet - those (plus
  `.claude/mcp/` servers, `.claude/hooks/`, `.claude/commands/`) are the
  missing adapter layer this port adds.
- Rules files are three-way, manually synced: `.pi/agent/APPEND_SYSTEM.md`
  (pi superset, 21k) is canonical; `.claude/CLAUDE.md` (5.5k) is the universal
  subset (says so in its own header); `AGENTS.md` (opencode) sits between.

So "automatic" needs no new machinery: add the CC adapter files to the repo,
let stow link them. The work is authoring adapters over shared cores, not
building an installer.

### Target repo layout

```
.pi/agent/extensions/
  lib/<name>-core.ts       SOURCE OF TRUTH: pure logic, zero harness imports
  <name>.ts                pi adapter (defineTool / tool_call)        [exists]
.claude/
  settings.json            [new, tracked] hooks{} wiring the guard scripts
  mcp/<server>.ts          [new] MCP servers importing ../../.pi/agent/.../lib cores
  hooks/<name>.ts          [new] CC hook scripts importing the same cores
  commands/<name>.md       [new] slash commands mirroring .pi/agent/prompts/
  skills/<name> -> ...     [exists] symlinks into .pi/agent/skills
.mcp.json                  [new, tracked] registers .claude/mcp/* servers
```

Hook `command`s and MCP `command`s reference stable stowed paths under
`$HOME/.claude/...` and `$HOME/.pi/agent/...` (run via `bun`), so they resolve
identically on every machine after stow.

## The architectural mismatch

pi runs **one in-process TypeScript runtime**. A single `.ts` file can
register an LLM-callable tool (`defineTool`), guard tool calls (`tool_call`
hook returning `{block, reason}`), inject context (`context` event), and paint
the TUI (`ctx.ui.setWorkingMessage`, footer, toasts) - all through
`@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai`.

Claude Code splits that same surface across **five separate mechanisms**, none
of which is an in-process TS API (that is the Agent SDK, a different product):

| pi capability | Claude Code home | Fidelity |
|---|---|---|
| `defineTool(...)` LLM tool | MCP server (stdio/http/sse), separate process | full, but out-of-process |
| `tool_call` hook -> `{block,reason}` | hook `PreToolUse` (exit 2 or `permissionDecision:deny`) | superset (see below) |
| `context` event injection | hook `additionalContext` (Pre/PostToolUse, SessionStart, Stop) | partial (advisory, not raw message) |
| `ctx.ui.setWorkingMessage` / footer / toasts | statusline (read-only JSON -> stdout) | none for mid-tool progress |
| slash prompt templates (`prompts/`) | `.claude/commands/*.md` or skill | near 1:1 |
| `task.ts` subagent | native subagents (`.claude/agents/*.md`) | native, richer |

### CC hook capability matrix

Verified this session against docs.claude.com (hooks, mcp, skills,
output-styles, statusline, sub-agents pages). CC hooks are a **superset** of
pi's block-only `tool_call`:

| Event | Block? | Rewrite input? | Modify output? | Inject context? |
|---|---|---|---|---|
| `PreToolUse` | yes (`permissionDecision:deny`) | yes (`updatedInput`) | no | yes (`additionalContext`) |
| `PostToolUse` | yes (`decision:block`) | no | yes (`updatedToolOutput`) | yes (`additionalContext`) |
| `UserPromptSubmit` | yes | no | - | (see caveat) |
| `SessionStart` / `CwdChanged` | - | - | - | yes (`additionalContext`) |
| `Stop` / `SubagentStop` | yes | - | - | yes (`additionalContext`) |
| `Notification` | - | - | - | - |

Hook handler types: `command` (shell), `http` (POST), `mcp_tool`, `prompt`,
`agent`. Configured in `settings.json` under `hooks{}` with a `matcher`
(exact tool name, `Edit|Write`, or `mcp__server__tool`) and exit-code / stdout
JSON contract. `command` hooks receive a JSON payload on stdin including
`session_id`, `transcript_path`, `cwd`, `hook_event_name`, and the tool
input/output.

> Epistemic caveat: `updatedInput`, `updatedToolOutput`, and the skill
> `trigger:` frontmatter are current per docs.claude.com but are recent and
> move fast. Confirm each against the *installed* `claude` build (`claude
> --version`, `/hooks`, a throwaway hook that echoes its stdin) before
> building on them. `UserPromptSubmit` context injection specifically: older
> CC behaviour injected exit-0 stdout as context; the current docs describe a
> `decision:block` contract. Verify empirically in the worktree before relying
> on prompt-time injection.

The practical upshot: several guards that pi can only *block-and-ask-for-
resubmit* (its `tool_call` hook cannot rewrite input) can become **auto-fixes**
under CC via `updatedInput`. `ascii-punctuation-guard` is the clearest case -
its own header (line 9) notes the block-only limitation.

## The leverage point: one core, thin adapters

You already do this partially: `extensions/lib/` holds `guard-commit-shared.ts`,
`memledger-core.ts`, `sentences.ts`, `tool-label.ts` - pure logic imported by
the pi adapters, covered by `extensions/tests/*.test.ts`. Extend that to every
portable extension:

```
.pi/agent/extensions/lib/<name>-core.ts   pure logic, ZERO harness imports
.pi/agent/extensions/<name>.ts            thin pi adapter (defineTool/tool_call) [exists]
.claude/mcp/<server>.ts                   thin CC MCP adapter (Bucket 2 tools)   [new]
.claude/hooks/<name>.ts                   thin CC hook adapter (Bucket 3 guards) [new]
```

One copy of the logic, two (or three) thin adapters, and the existing bun unit
tests keep covering the core regardless of harness. This mirrors exactly what
the README says you already did porting opencode -> pi.

Where a pi extension already exports pure functions (`oci-tags` exports
`parseImage`; `ascii-punctuation-guard` exports `scan`, `isProsePath`,
`WRITE_BASH`; guards import `lib/`), the core-extraction is mostly moving code
down a directory and re-importing.

## Per-extension decision matrix

Decision key: **MCP** = re-expose as MCP tool(s); **HOOK** = CC hook;
**CMD** = slash command / skill; **NATIVE** = CC already has it, skip;
**SKIP** = pi-runtime-specific (TUI/session internals), no CC analogue.

### Bucket 2 - port as MCP tools (external services + CLI wrappers)

Highest ROI, lowest risk: logic is already harness-agnostic (shells out,
emits JSON, or hits an HTTP service). `memledger` and `video-review` are the
easiest since they are already pure service clients; `memledger` was literally
an MCP server before being folded into pi.

| Extension | Decision | Wraps / calls | Notes |
|---|---|---|---|
| `memledger.ts` | MCP | PostgREST `memledger.erfi.io` | was an MCP server; near-zero-effort re-export. LAN-open, no creds. |
| `docs.ts` | MCP | docs.erfi.io over SSH | 6 tools (search/read/grep/find/summary/sources). |
| `exa.ts` | MCP | mcp.exa.ai + SearXNG fallback | websearch/codesearch. Could also be a plain CC MCP passthrough to exa's own MCP. |
| `web-research.ts` | MCP | exa + Playwright crawler | overlaps exa; expose one, not both. |
| `osint.ts` | MCP | osint.erfi.io `:8890` | 9 tools. |
| `video-review.ts` | MCP | whisper `:7860` | pure service client. |
| `oci-tags.ts` | MCP | OCI registry APIs | exports `parseImage` already. |
| `pdf.ts` | MCP | pdftotext / tesseract / pdfplumber | fills CC's PDF-read gaps for scanned docs. CC `Read` handles born-digital PDFs. |
| `render-diagram.ts` | MCP | mermaid / d2 CLIs | - |
| `build-favicon-set.ts` | MCP | image CLIs | niche; low priority. |
| `context7.ts` | MCP | context7 REST | or just add context7's official MCP server directly. |
| `osv-scan.ts` | MCP | `osv-scanner` | CLI wrapper, JSON out. |
| `secret-scan.ts` | MCP | `gitleaks` / `noseyparker` | truncates secrets to 12 chars - keep that in the core. |
| `hurl-test.ts` | MCP | `hurl` | - |
| `go-test.ts` | MCP | `go test -json` | - |
| `bench.ts` | MCP | `hyperfine` | - |
| `pg-analyser.pi.ts` | MCP | `pg-analyser` CLI | single tool; core already shells out. |
| `session-search.ts` | MCP or SKIP | SQLite FTS5 of pi sessions | indexes *pi* sessions; only useful in CC if pointed at a shared corpus. Prefer `memledger` (cross-client) for CC. |

Design (as built): **one stdio MCP server** - `.claude/mcp/toolkit.ts`
carries both the CLI wrappers (oci/osv/secret/hurl/go-test/bench/pg-analyser)
and the service clients (docs/exa/osint/memledger/video-review/render-diagram/
pdf/context7/build-favicon-set); the planned second `research.ts` server was
folded in during Phase 4. Built on the official `@modelcontextprotocol/sdk`
(v1.30, `McpServer` + `registerTool` + `StdioServerTransport`, Zod raw-shape
schemas).

Dependency model: deps in `.claude/mcp/{package.json,node_modules}`
(node_modules + bun.lock git/stow-ignored via the repo's bare regexes). Because
there is a real dep, the server runs from the REPO checkout (so both the SDK
and the `../../.pi/agent` cores resolve), NOT the stow symlink. Register
per-project via tracked `.mcp.json`, or globally via `install.sh` -> `bun
install` + `claude mcp add --scope user erfi-toolkit -- bun
$HOME/dotfiles/.claude/mcp/toolkit.ts`. Sensor: a headless smoke test drives
the server with the SDK's own stdio client - no `claude` binary needed.

### Bucket 3 - port as hooks (guards / behavior)

| Extension | Decision | CC event | Notes |
|---|---|---|---|
| `ascii-punctuation-guard.ts` | HOOK | `PreToolUse` (Edit\|Write\|Bash) | upgrade: auto-rewrite via `updatedInput` instead of block-and-resubmit. |
| `confidential-write-guard.ts` | HOOK | `PreToolUse` (Edit\|Write\|Bash) | deny + reason; core is the term-scanner. |
| `git-gh-gate.ts` | HOOK | `PreToolUse` (Bash) | deny mutating git/gh; CC has no apply_patch to also guard, simpler. |
| `tool-guard.ts` | HOOK | `PreToolUse` (multi) | anti-pattern blocks; drop the apply_patch/pi-tool-name cases. |
| `bash-error-hints.ts` | HOOK | `PostToolUse` (Bash) | `additionalContext` with the footgun hint (pi decorates result text; CC annotates). |
| `entity-qualifier-nudge.ts` | HOOK | `PreToolUse` (Edit\|Write) | nudge via `additionalContext`, or deny. |
| `skill-guard.ts` | HOOK | `UserPromptSubmit` / `PreToolUse` | docblock cites anthropics/claude-code#30387 - the CC fix IS this hook. High value: CC skill auto-trigger is unreliable for trained-overlap skills. |
| `lookup-before-ask.ts` | HOOK | `PreToolUse` (AskUserQuestion) | nudge to search memledger/session first. Depends on Bucket-2 memledger MCP existing. |
| `epistemic-guard.ts` | HOOK | `PostToolUse` / `Stop` | reads `transcript_path` as provenance corpus, annotates unverified specifics. Advanced; port last. |
| `cd-agents-reload.ts` | HOOK | `CwdChanged` / `SessionStart` | inject repo `AGENTS.md`/`CLAUDE.md` via `additionalContext`. CC already reads CLAUDE.md at start; value is the mid-session `cd`. |
| `tool-routing.ts` | HOOK or NATIVE | `SessionStart` | pi prepends routing rules; in CC put these in `CLAUDE.md` (native) unless dynamic. |
| `inline-bash.ts` | NATIVE | - | CC already expands `!` / `!{...}` in prompts. Verify syntax parity, else HOOK on `UserPromptSubmit`. |
| `notify.ts` | HOOK | `Notification` / `Stop` | desktop ping; CC has a Notification hook already. |
| `local-model-rules.ts` | SKIP | - | pi-specific (llama-server gemma/qwen). Irrelevant to CC's model set. |
| `superpowers.ts` | CMD | skill w/ `trigger` | it is already a skill-injection; register the superpowers skills in `.claude/skills/`. |

### Bucket 1 - native in CC, skip

| Extension | Why skip |
|---|---|
| `grep.ts`, `glob.ts` | CC has Grep/Glob built in. |
| `webfetch.ts` | CC has WebFetch (verify SPA-escalation gap; if it matters, keep as MCP). |
| `apply-patch.ts`, `write-stream.ts` | CC Edit/Write/MultiEdit cover multi-file + large writes. |
| `memory.ts` | CC memory dir + CLAUDE.md. (Cross-session *search* = `memledger` MCP, Bucket 2.) |
| `task.ts` | CC subagents are native and richer. |
| `todowrite.ts` | CC TodoWrite is native. |
| `question.ts` | CC AskUserQuestion is native. |
| `compaction-model.ts`, `compaction-progress.ts`, `trigger-compact.ts` | CC `/compact` + `PreCompact` + auto-compaction. |
| `cost-guard.ts` | mostly native: statusline JSON exposes `cost.total_cost_usd` + `context_window.used_percentage`. Port the ladder as a statusline script if you want the rungs. |
| `tool-activity.ts` | needs mid-tool progress UI; CC statusline does not update mid-tool. No analogue. |
| `custom-footer.ts.disabled` | already disabled; statusline covers it. |

### Bucket SKIP - pi session/TUI internals, no CC analogue

`bg-tasks.ts` (CC has background bash + subagents instead), `bookmark.ts`,
`yank.ts`, `session-undo.ts`, `session-name.ts`, `session-summary.ts`,
`session-auto-title.ts`, `session-fts/`, `session-ledger/`, `migrate-sessions.ts`,
`clipboard-image-shrink.ts` (CC handles paste), `continue-after-error.ts`
(CC has its own provider-error retry), `slash-typo-guard.ts`, `style-toggle.ts`
(-> CC output-styles if desired), `stuck-state-recovery.ts.disabled`, `lsp/`
(CC has no LSP tool surface to feed).

### Prompt templates -> slash commands

`prompts/*.md` (`/init`, `/review`, `/commit`, `/pr`, `/test`, `/rollback`,
`/local-model-rules`) port to `.claude/commands/*.md` or skills almost
verbatim. Note CC already ships `/init`, `/review`, `/pr`-like flows; only port
the ones whose behaviour you specifically want (e.g. the commit template that
enforces the no-AI-attribution rule).

## Live verification (2026-08-12, real Claude Code 2.1.228)

The `[blocked: needs live CC]` foundation items are now VERIFIED end-to-end
against a real `claude` binary:

- **MCP server**: `claude mcp add --scope local erfi-toolkit -- bun <abs>/toolkit.ts`
  then `claude mcp list` -> `erfi-toolkit ... ✔ Connected`. A headless
  `claude -p "call oci_tags image=nginx limit=3"` returned real registry tags
  (`trixie, trixie-otel, trixie-perl`) - real CC -> MCP client -> official-SDK
  server -> shared oci-tags-core -> Docker Hub -> back. All 7 tools present.
- **ascii-guard hook**: verified at USER scope. A `claude -p` Write of `«hi»`
  was DENIED and the model echoed the verbatim hook reason
  (`guillemet (U+00AB/BB/2039/203A) ... ASCII-folded form to resubmit: "hi"`) -
  text that only ascii-core/reason() produces.

Findings that shape the design (all now reflected in install.sh + docs):

1. **Auto-updater self-clobber**: invoking the npm-global `claude` triggers a
   self-update that re-drops the stub binary, breaking the NEXT invocation.
   `DISABLE_AUTOUPDATER=1` (env) stops it. Durable fix remains migrating to the
   native installer. The stopgap is `node .../install.cjs`.
2. **Project-scope hooks are NOT applied by headless `claude -p`** (untrusted
   project). Hooks must live in `~/.claude/settings.json` (user scope) to fire -
   exactly what `install.sh do_claude()` merges them into. Verified there.
3. **`${CLAUDE_PROJECT_DIR}` in `.mcp.json`** raised a "Missing environment
   variable" warning in the `claude mcp list` health-check context. So the
   RELIABLE registration path is `do_claude()`'s user-scope `claude mcp add`
   with an absolute `$HOME/dotfiles/.claude/mcp/toolkit.ts` (verified ✔
   Connected). The tracked `.mcp.json` stays as a project-scope convenience
   (pending-approval + the cosmetic warning).

## Full-parity ledger (all 60 extensions)

"Full feature parity" = every extension is either PORTED to CC, satisfied by a
CC NATIVE, or consciously SKIPPED as pi-runtime-internal (no CC meaning). This
table is the authoritative finish line - nothing is silently dropped.

Legend: DONE = ported+verified · MCP/HOOK/CMD = to-port (bucket) · NATIVE = CC
already provides it · SKIP = pi TUI/session internals, no CC analogue.

| Extension | Status | Notes |
|---|---|---|
| oci-tags | DONE (MCP) | oci_tags |
| osv-scan | DONE (MCP) | osv_scan |
| secret-scan | DONE (MCP) | secret_scan |
| hurl-test | DONE (MCP) | hurl_test |
| go-test | DONE (MCP) | go_test |
| bench | DONE (MCP) | bench |
| pg-analyser.pi | DONE (MCP) | pg_analyser |
| ascii-punctuation-guard | DONE (HOOK) | PreToolUse, live-verified |
| memledger | DONE (MCP) | 5 tools (search/ledger/memories/sessions) |
| docs | DONE (MCP) | docs.erfi.io over SSH; 6 sub-tools |
| exa | DONE (MCP) | web_search / code_search |
| osint | DONE (MCP) | osint.erfi.io; 9 sub-tools |
| video-review | DONE (MCP) | whisper service client |
| render-diagram | DONE (MCP) | mermaid/d2 CLIs |
| pdf | DONE (MCP) | pdftotext/tesseract/pdfplumber |
| context7 | DONE (MCP) | resolve_library_id + query_docs |
| build-favicon-set | DONE (MCP) | niche |
| web-research | FOLD -> exa | overlaps exa; expose one |
| confidential-write-guard | DONE (HOOK) | PreToolUse deny |
| git-gh-gate | DONE (HOOK) | PreToolUse deny (Bash|Write|Edit|MultiEdit) |
| tool-guard | DONE (HOOK) | PreToolUse anti-patterns (Bash|WebFetch) |
| bash-error-hints | DONE (HOOK) | PostToolUse Bash additionalContext |
| entity-qualifier-nudge | DONE (HOOK) | PreToolUse additionalContext (live-verified) |
| skill-guard | DONE (HOOK) | PreToolUse additionalContext (live-verified) |
| lookup-before-ask | DONE (HOOK) | PreToolUse additionalContext on AskUserQuestion |
| epistemic-guard | DONE (HOOK) | PostToolUse (Write|Edit|MultiEdit) transcript-provenance |
| notify | DONE (HOOK) | Stop |
| cd-agents-reload | DONE (HOOK) | PreToolUse Bash additionalContext (live-verified) |
| secret-output-guard | DONE (HOOK) | PreToolUse Bash deny (env dumps) + PostToolUse (Bash\|Read\|Grep\|WebFetch) leak alarm - CC cannot mutate tool_response, so pi's redaction layer ports as detection-only additionalContext |
| superpowers | DONE (CMD) | 6 subskills symlinked into .claude/skills |
| prompt templates | DONE (CMD) | commit/pr/test/rollback -> .claude/commands |
| grep | NATIVE | CC Grep |
| glob | NATIVE | CC Glob |
| webfetch | NATIVE | CC WebFetch (SPA-escalation gap acceptable) |
| apply-patch | NATIVE | CC Edit/Write/MultiEdit |
| write-stream | NATIVE | CC Write/MultiEdit |
| memory | NATIVE | CC memory dir + CLAUDE.md (search -> memledger MCP) |
| task | NATIVE | CC subagents |
| todowrite | NATIVE | CC TodoWrite |
| question | NATIVE | CC AskUserQuestion |
| inline-bash | NATIVE | CC expands ! in prompts |
| compaction-model | NATIVE | CC compaction |
| trigger-compact | NATIVE | CC auto-compact + PreCompact |
| continue-after-error | NATIVE | CC provider-error retry |
| style-toggle | NATIVE | CC output-styles |
| tool-routing | NATIVE | put routing rules in CLAUDE.md |
| cost-guard | NATIVE | CC statusline exposes cost; optional statusline port |
| session-search | SKIP->memledger | prefer cross-client memledger MCP over pi-local FTS |
| bg-tasks | SKIP | CC background bash + subagents |
| bookmark | SKIP | pi TUI |
| yank | SKIP | pi clipboard TUI |
| clipboard-image-shrink | SKIP | CC handles paste |
| compaction-progress | SKIP | CC UI |
| tool-activity | SKIP | no mid-tool progress hook in CC |
| tool-output-prune | SKIP | CC context mgmt |
| session-name | SKIP | pi sessions |
| session-auto-title | SKIP | pi sessions |
| session-summary | SKIP | pi sessions |
| session-undo | SKIP | CC has its own |
| migrate-sessions | SKIP | pi sessions |
| slash-typo-guard | SKIP | CC slash handling |
| local-model-rules | SKIP | pi llama-server only |

**PARITY ACHIEVED (2026-08-12)** for all MCP + HOOK ports (workflow of 19
parallel agents + integration). The toolkit MCP now exposes **22 tools**;
**11 CC hooks** are wired in settings.json. All shared logic lives in
`lib/*-core.ts`, so pi and CC run identical code.

Verification after integration: pi unit 589 · pi integration 76 · pi manifest 7
· 30 core tests 665 · 11 hook smokes 68 · toolkit smoke (all 22 tools connect
via the real SDK client). Zero regressions across 18 refactored pi adapters.

MCP tools added (15): search_messages/semantic_search/search_ledger/
search_memories/list_sessions (memledger), docs, web_search/code_search (exa),
osint, render_diagram, pdf, context7_resolve_library_id/context7_query_docs,
build_favicon_set, video_review - on top of the 7 from Phase 1-2.
Hooks added (10): confidential-write-guard, git-gh-gate, tool-guard,
bash-error-hints, entity-qualifier-nudge, skill-guard, lookup-before-ask,
notify, cd-agents-reload, epistemic-guard - plus ascii-guard.

**CMD group DONE:** 6 ACTIVE superpowers subskills symlinked into
`.claude/skills/` (the 8 the user disabled in pi via SKILL.md.disabled are
intentionally NOT exposed); 4 portable prompt templates symlinked into
`.claude/commands/` (commit, pr, test, rollback). Skipped by design: init/review
(collide with CC built-in skills), local-model-rules (pi llama-server only),
docs-reference (a reference doc, not a command). NATIVE/SKIP rows are
parity-satisfied by CC built-ins.

**PARITY COMPLETE** across MCP tools, hooks, skills, and commands. Only the
NATIVE (CC built-in) and SKIP (pi-internal) rows remain unported by design.

Original tally (pre-workflow): 8 DONE · ~12 MCP+HOOK + 2 CMD remaining ·
~16 NATIVE · ~15 SKIP.

## Phased checklist (loop-consumable)

Loop protocol: each iteration does the FIRST unchecked item, verifies with the
stated sensor, flips `[ ]` to `[x]`, and commits to `cc-port`. If the sensor
fails, fix within the same iteration; do not advance. Sensor for all code
items unless noted: `bun test` green in the worktree (avoid the shadowed
`grep`/`rg` shell functions - use `/usr/bin/grep` or `bun`). Env note: `bun
1.3.14`, `node`, `/usr/bin/grep` work; `claude` at `/opt/homebrew/bin/claude`.

**Phase 0 - verify the CC contract empirically (no logic yet).**
Environment note (2026-08-11): the `claude` binary in this build env is broken
(`/opt/homebrew/bin/claude` -> "native binary not installed"), and `rg`/`grep`
are broken shell-snapshot functions. So NO live-CC verification is possible
from the loop's Bash env; these items are all owner-run in a working CC
session. The loop verifies everything else with `bun test` + headless
JSON-RPC smoke tests (no `claude` binary needed).
- [x] `claude --version` -> 2.1.228. PreToolUse hook fires with `{tool_name, tool_input}` payload (verified live: ascii-guard read tool_input.content and denied).
- [x] PreToolUse `permissionDecision: deny` + `permissionDecisionReason` honored by CC (verified: the guillemet Write was blocked, reason surfaced to the model).
- [ ] `updatedInput` auto-rewrite: NOT yet tested (ascii-guard uses the deny path). Still the future enhancement for auto-fold.
- [ ] `UserPromptSubmit` injection: NOT yet tested (no UserPromptSubmit hook until Phase 3 skill-guard).
- [x] PreToolUse `additionalContext` honored (verified live 2026-08-12, CC 2.1.220): cd-agents-reload injected a probe repo's AGENTS.md carrying a unique codename; the model quoted the codename verbatim and the CC debug log shows `provided additionalContext (670 chars)`. First probe attempt returned a false negative because the hook's own framing ("rules below are NOT in your current context") led the model to answer NONE when asked what it could "see in context" - probe questions must not collide with the injected framing.
- [x] Findings recorded above under "Live verification (2026-08-12)".

**Phase 1 - vertical slice (proves the whole architecture end to end).**
Smallest set that exercises MCP + hook + shared core + stow, all at once.
- [x] Extract `lib/oci-tags-core.ts` from `oci-tags.ts`; re-point pi adapter (re-exports helpers); core test 13 pass + pi suite 589 pass.
- [x] `.claude/mcp/toolkit.ts` (bun stdio MCP, official `@modelcontextprotocol/sdk@1.30`) exposing `oci_tags` via the core. Headless smoke test (`toolkit.smoke.test.ts`, real SDK client over stdio) 1 pass: handshake + tools/list + schema.
- [x] `.mcp.json` (tracked, project scope). Live-verified: user-scope `claude mcp add` (absolute path) -> `✔ Connected` + live `oci_tags` call returned real tags. Caveat found: `${CLAUDE_PROJECT_DIR}` warns "missing env var" in the health-check context, so `do_claude()`'s absolute-path user-scope registration is the reliable primary; `.mcp.json` is the project-scope convenience.
- [x] Extract `lib/ascii-core.ts` (scan/isProsePath/WRITE_BASH/reason + new `foldToAscii`); re-point pi adapter (re-exports); ascii-core 48 pass (every code point) + pi suite/e2e 600 pass.
- [x] `.claude/hooks/ascii-guard.ts` (PreToolUse Write|Edit|MultiEdit|Bash) + `.claude/settings.json` fragment. Emits `permissionDecision: deny` + the exact ASCII-folded form (guaranteed one-shot fix). Hook smoke test 4 pass. NOTE: true auto-rewrite via `updatedInput` is a [blocked: needs live CC] enhancement - deny-with-folded-form is the verified-correct baseline.
- [x] Wire `install.sh` `do_claude()`: native-binary repair (postinstall re-run when `claude --version` reports "native binary not installed"), `bun install`, user-scope MCP registration probed via `~/.claude.json` (a `claude mcp list` grep false-matches the project-scope `.mcp.json` entry); deep jq-merge of `.claude/settings.json` hooks into `~/.claude/settings.json` (per-event concat + order-preserving first-seen dedup, perms preserved). All `claude` invocations carry `DISABLE_AUTOUPDATER=1`. `.claude/settings.json` and `.mcp.json` in `.stow-local-ignore`.
- [x] Commit; this slice is the reference pattern for every later item. THE DUAL-HARNESS FOUNDATION IS COMPLETE: shared core + pi adapter + CC MCP tool + CC guard hook + automatic install, all verified without a `claude` binary. Remaining phases are BREADTH (more tools/guards) over this proven pattern.

**Phase 2 - widen MCP (toolkit server, CLI wrappers).**
- [x] osv-scan -> lib/osv-core.ts (parseOsvJson/buildOsvArgs/renderOsv/runOsvScanner/scanOsv); pi adapter re-exports parseOsvJson; osv_scan added to toolkit.ts. Sensors: osv-core 8 pass, toolkit smoke asserts both tools, pi suite 589 pass. Live osv-scanner run [blocked: needs binary].
- [x] secret-scan -> lib/secret-scan-core.ts (parseGitleaksJson/parseNoseyparkerJsonl with 12-char truncation baked in via truncateSecret; runGitleaks/runNoseyparker; renderSecrets; scanSecrets). pi adapter re-exports both parsers; secret_scan added to toolkit.ts. Sensors: secret-core 6 pass (incl. "full secret never survives"), toolkit smoke 3 tools, pi suite 589 pass. Live gitleaks/noseyparker run [blocked: needs binary].
- [x] hurl-test -> lib/hurl-core.ts (parseHurlJson/renderHurl/normalizeVars/runHurlTest); pi adapter re-exports parseHurlJson; hurl_test added to toolkit. Sensors: hurl-core 9 pass, toolkit smoke 4 tools, pi suite 589. Live hurl run [blocked: needs binary].
- [x] go-test -> lib/go-test-core.ts (parseGoTestJson/buildGoTestArgs/renderGoTest/runGoTests); pi adapter re-exports parseGoTestJson; go_test added to toolkit. Sensors: go-test-core 8 pass, toolkit smoke 5 tools, pi suite 589. Live go run [blocked: needs binary].
- [x] bench -> lib/bench-core.ts (parseHyperfineJson/fmtSeconds/buildBenchArgs/renderBench/runBench); pi adapter re-exports parseHyperfineJson; bench added to toolkit. Sensors: bench-core 7 pass, toolkit smoke 6 tools, pi suite 589. Live hyperfine run [blocked: needs binary].
- [x] pg-analyser -> lib/pg-analyser-core.ts (validatePgAction/buildPgArgs/findReportDir/runPg/runPgAnalyser); thin pi adapter (no test re-exports needed); pg_analyser added to toolkit. Sensors: pg-analyser-core 9 pass, toolkit smoke 7 tools, pi suite 589. Live pg-analyser run [blocked: needs binary].

**PHASE 2 COMPLETE.** Toolkit MCP exposes 7 tools: oci_tags, osv_scan, secret_scan, hurl_test, go_test, bench, pg_analyser - each over a shared dependency-free lib/*-core.ts with a pure unit test, all asserted by the SDK-client smoke test. pi suite held at 589 pass throughout.

**Phase 3 - the guard hooks.** All DONE (2026-08-12). 11 hooks in
`.claude/hooks/`, each with a subprocess smoke test. Post-merge review fixes:
CC hooks honor BOTH the unprefixed and the PI_-prefixed kill switches (the
shared cores' deny reasons advertise the PI_ names); confidential-write-guard's
agentDir defaults to `~/.pi/agent` (a cwd-relative fallback silently lost the
global store outside the dotfiles repo).

**Phase 4 - research MCP + advanced + commands.** All DONE (2026-08-12).
- [x] research tools shipped in `toolkit.ts` directly (memledger x5, docs, osint,
  exa, video-review, render-diagram, pdf, context7 x2, build-favicon-set) - the
  separate `research.ts` server was folded in; 22 tools total.
- [x] `.claude/commands/`: commit, pr, test, rollback (zero-copy symlinks to
  `.pi/agent/prompts/`).
- [x] epistemic-guard transcript-provenance hook (reads `transcript_path`).

**Phase 5 - packaging + docs.**
- [ ] Decide distribution (open question 1): stow'd `.claude/` (default) vs CC plugin.
- [x] Global MCP registration: DONE in `install.sh do_claude()` (idempotent
      `claude mcp add --scope user`, guarded by `command -v claude/bun`). The
      tracked `.mcp.json` additionally gives PROJECT scope when cwd = the repo.
      Hooks/commands/skills stow globally via `~/.claude/`.
- [ ] README: add a CC section mirroring the pi one; note the shared-core rule.
- [ ] Merge `cc-port` -> `main` per phase once tests pass.

## Non-destructive testing strategy

- All work stays on branch `cc-port` in
  `/Users/erfi/dotfiles.worktrees/cc-port`. The live `~/.pi/agent/` symlinks
  point at `~/dotfiles` (main), so nothing here is loaded by a running pi.
- CC MCP servers register at `local` scope (`.mcp.json` in the worktree) so
  they never touch the global `~/.claude.json`.
- Hooks go in the worktree's `.claude/settings.json`, not `~/.claude/`.
- Test CC by launching it *with cwd = the worktree*. Nothing writes outside it.
- Merge to `main` only per-phase, after the core-extraction tests pass.

## Open questions

1. Distribution: CC plugin vs stow'd `.claude/` vs both? Affects directory layout.
2. Do you want the CC hooks to share the *exact* term lists / regexes with pi
   (single source in `lib/`), or can they drift? (Recommend: shared core.)
3. `session-search` under CC: point it at `memledger` (cross-client) rather
   than pi's local FTS db? (Recommend: yes; drop local FTS for CC.)
4. Which prompt templates are worth porting vs relying on CC's built-ins?
