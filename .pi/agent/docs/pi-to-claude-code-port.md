# Porting the pi harness to Claude Code

Status: design doc (no code yet). Branch `cc-port`, worktree
`/Users/erfi/dotfiles.worktrees/cc-port`. Nothing here touches the live
`~/.pi/agent/` runtime or `~/dotfiles` main branch.

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
  18-skill subset). opencode does the whole dir: `.config/opencode/skills ->
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

Design: **two stdio MCP servers** rather than one monolith, so context cost is
opt-in per project. Built on the official `@modelcontextprotocol/sdk` (v1.30,
`McpServer` + `registerTool` + `StdioServerTransport`, Zod raw-shape schemas):
- `.claude/mcp/toolkit.ts` - CLI wrappers (oci [done], osv/secret/hurl/go-test/bench/pg-analyser).
- `.claude/mcp/research.ts` - service clients (docs/exa/osint/memledger/video-review).

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
- [blocked: needs live CC] `claude --version`; `/hooks` to list events the build supports.
- [blocked: needs live CC] Throwaway `PreToolUse` hook echoing stdin - capture payload shape.
- [blocked: needs live CC] Throwaway hook returning `updatedInput` - confirm rewrite applies.
- [blocked: needs live CC] Confirm `UserPromptSubmit` injection (exit-0 stdout vs decision).
- [ ] Record findings here under a "CC contract, verified" section (after owner runs the above).

**Phase 1 - vertical slice (proves the whole architecture end to end).**
Smallest set that exercises MCP + hook + shared core + stow, all at once.
- [x] Extract `lib/oci-tags-core.ts` from `oci-tags.ts`; re-point pi adapter (re-exports helpers); core test 13 pass + pi suite 589 pass.
- [x] `.claude/mcp/toolkit.ts` (bun stdio MCP, official `@modelcontextprotocol/sdk@1.30`) exposing `oci_tags` via the core. Headless smoke test (`toolkit.smoke.test.ts`, real SDK client over stdio) 1 pass: handshake + tools/list + schema.
- [x] `.mcp.json` (tracked, project scope) registering it via `${CLAUDE_PROJECT_DIR}/.claude/mcp/toolkit.ts`. [blocked: needs live CC] `claude mcp list` shows it + live tool call (env-var expansion in `.mcp.json` args also needs live-CC confirmation).
- [x] Extract `lib/ascii-core.ts` (scan/isProsePath/WRITE_BASH/reason + new `foldToAscii`); re-point pi adapter (re-exports); ascii-core 48 pass (every code point) + pi suite/e2e 600 pass.
- [x] `.claude/hooks/ascii-guard.ts` (PreToolUse Write|Edit|MultiEdit|Bash) + `.claude/settings.json` fragment. Emits `permissionDecision: deny` + the exact ASCII-folded form (guaranteed one-shot fix). Hook smoke test 4 pass. NOTE: true auto-rewrite via `updatedInput` is a [blocked: needs live CC] enhancement - deny-with-folded-form is the verified-correct baseline.
- [x] Wire `install.sh` `do_claude()`: `bun install` + idempotent `claude mcp add --scope user erfi-toolkit`; deep jq-merge of `.claude/settings.json` hooks into `~/.claude/settings.json` (per-event array concat + `unique_by(tojson)` so re-runs are idempotent). `.claude/settings.json` added to `.stow-local-ignore`. Verified: `bash -n` OK, standalone jq-merge idempotent (theme preserved, count stays 1), `do_claude` dry-run emits the right commands with no side effects.
- [x] Commit; this slice is the reference pattern for every later item. THE DUAL-HARNESS FOUNDATION IS COMPLETE: shared core + pi adapter + CC MCP tool + CC guard hook + automatic install, all verified without a `claude` binary. Remaining phases are BREADTH (more tools/guards) over this proven pattern.

**Phase 2 - widen MCP (toolkit server, CLI wrappers).**
- [x] osv-scan -> lib/osv-core.ts (parseOsvJson/buildOsvArgs/renderOsv/runOsvScanner/scanOsv); pi adapter re-exports parseOsvJson; osv_scan added to toolkit.ts. Sensors: osv-core 8 pass, toolkit smoke asserts both tools, pi suite 589 pass. Live osv-scanner run [blocked: needs binary].
- [x] secret-scan -> lib/secret-scan-core.ts (parseGitleaksJson/parseNoseyparkerJsonl with 12-char truncation baked in via truncateSecret; runGitleaks/runNoseyparker; renderSecrets; scanSecrets). pi adapter re-exports both parsers; secret_scan added to toolkit.ts. Sensors: secret-core 6 pass (incl. "full secret never survives"), toolkit smoke 3 tools, pi suite 589 pass. Live gitleaks/noseyparker run [blocked: needs binary].
- [x] hurl-test -> lib/hurl-core.ts (parseHurlJson/renderHurl/normalizeVars/runHurlTest); pi adapter re-exports parseHurlJson; hurl_test added to toolkit. Sensors: hurl-core 9 pass, toolkit smoke 4 tools, pi suite 589. Live hurl run [blocked: needs binary].
- [x] go-test -> lib/go-test-core.ts (parseGoTestJson/buildGoTestArgs/renderGoTest/runGoTests); pi adapter re-exports parseGoTestJson; go_test added to toolkit. Sensors: go-test-core 8 pass, toolkit smoke 5 tools, pi suite 589. Live go run [blocked: needs binary].
- [x] bench -> lib/bench-core.ts (parseHyperfineJson/fmtSeconds/buildBenchArgs/renderBench/runBench); pi adapter re-exports parseHyperfineJson; bench added to toolkit. Sensors: bench-core 7 pass, toolkit smoke 6 tools, pi suite 589. Live hyperfine run [blocked: needs binary].
- [ ] pg-analyser tool (source is pg-analyser.pi.ts) - LAST Phase 2 item, paused before starting.

**Phase 3 - the guard hooks.**
- [ ] confidential-write-guard -> core + PreToolUse deny hook + test.
- [ ] git-gh-gate -> PreToolUse (Bash) deny hook + test.
- [ ] skill-guard -> UserPromptSubmit/PreToolUse nudge (highest behavioural value).
- [ ] bash-error-hints -> PostToolUse `additionalContext` hook.
- [ ] tool-guard, entity-qualifier-nudge, lookup-before-ask.

**Phase 4 - research MCP + advanced + commands.**
- [ ] `.claude/mcp/research.ts`: memledger (was an MCP server), docs, osint, exa, video-review.
- [ ] `.claude/commands/*.md` for the prompt templates worth keeping (commit, review, test).
- [ ] epistemic-guard transcript-provenance hook (reads `transcript_path`).

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
