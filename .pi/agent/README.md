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
├── skills/            → ~/.config/opencode/skills (zero-copy: 21 skills reused)
├── extensions/        contains symlinks to ~/dotfiles/.pi/agent/extensions/ (22 single-file + lsp/)
├── settings.json      → ~/dotfiles/.pi/agent/settings.json (defaultProvider/Model + theme)
├── prompts/           → ~/dotfiles/.pi/agent/prompts/ (6 slash-command templates)
├── themes/            → ~/dotfiles/.pi/agent/themes/ (opencode-dark high-contrast)
├── auth.json          (NOT tracked — runtime auth state)
├── sessions/          (NOT tracked — session JSONL files)
└── memories.json      (NOT tracked — populated by memory extension)
```

## Extensions

| Extension | Purpose | Maps to opencode fork commit |
|---|---|---|
| `git-gh-gate.ts` | Confirms mutating git/gh commands; protects `.git/` from direct writes | 560a2b983 |
| `oci-tags.ts` | Query OCI registries for image tags | 8cf0f6b87 |
| `memory.ts` | Cross-session persistent memory + per-turn injection | ffab004ea |
| `session-search.ts` | ripgrep-backed full-text search across past Pi sessions (overrides built-in; ~40ms on 18GB tree) | f9f58da11 + local |
| `compaction-progress.ts` | Spinner + token-delta toast during `/compact` and auto-compaction | local |
| `superpowers.ts` | Intent-gated injection of obra/superpowers methodology | f8eedb720 |
| `local-model-rules.ts` | Per-model rules for gemma/qwen (LaTeX ban, parallelism, anti-loop) | gemma.txt routing |
| `style-toggle.ts` | `/style` command for terse ↔ socratic output style | 4069bab24 |
| `docs.ts` | docs.erfi.io SSH access (search/grep/read/find/summary/sources) | replaces docs-mcp |
| `context7.ts` | Library documentation lookup via REST (replaces OAuth MCP) | replaces context7-mcp |
| `exa.ts` | websearch + codesearch via mcp.exa.ai REST | replaces exa-mcp |
| `webfetch.ts` | Fetch URL → markdown/text/html | port of opencode webfetch |
| `question.ts` | Interactive question prompts during execution | port of opencode question |
| `task.ts` | Spawn subagent via `pi -p` subprocess | port of opencode task |
| `todowrite.ts` | TodoWrite tool surface (bridges to TODO.md philosophy) | port of opencode todowrite |
| `lsp/` (multi-file) | Language Server Protocol — 8 operations + auto-install (bun/go/cargo/rustup) for 14 languages | port of opencode lsp |
| `notify.ts` | Desktop ping (OSC 777 / OSC 99 / Windows toast) on `agent_end` | examples/notify.ts |
| `inline-bash.ts` | Expand `!{cmd}` patterns inside prompts before send | examples/inline-bash.ts |
| `trigger-compact.ts` | Auto-compact when context crosses 100k tokens + `/trigger-compact` | examples/trigger-compact.ts |
| `migrate-sessions.ts` | `/migrate-sessions [args]` — backfill opencode → Pi sessions | wraps `bin/opencode-to-pi-sessions` |
| `session-name.ts` | `/session-name <label>` — readable identifiers in `pi -r` | examples/session-name.ts |
| `bookmark.ts` | `/bookmark` + `/unbookmark` for `/tree` navigation in long sessions | examples/bookmark.ts |
| `custom-footer.ts` | `/footer` — git branch + token/cost stats in footer | examples/custom-footer.ts |

## Prompt templates (slash commands)

| Template | Purpose |
|---|---|
| `/init [focus]` | Guided AGENTS.md setup (Pi-aware: docs.erfi.io refs, `.pi/agent/` paths, stricter "would agent miss this?" filter) |
| `/review [target]` | Review uncommitted / commit / branch / PR — defaults to uncommitted; gh-aware for PRs |
| `/commit [context]` | Inspect repo's recent log style → write commit matching it. Blocks AI attribution per APPEND_SYSTEM rules |
| `/pr <num\|URL>` | Fetch + review GitHub PR end-to-end; reads CI status + existing inline comments |
| `/test [filter]` | Detect toolchain (cargo/bun/pnpm/pytest/go/etc) → run targeted tests for the diff |
| `/local-model-rules` | Inject per-model rules when running gemma/qwen on llama-server |

## Themes

| Theme | Source |
|---|---|
| `opencode-dark` | dotfiles — VS Code Dark+ palette with brighter contrast than Pi's built-in `dark` |
| `dark` `light` | Built-in (Pi) |

Switch via `/settings` or set `"theme"` in `settings.json`.

## Skills

| Skill | Source | Purpose |
|---|---|---|
| `supabase` | dotfiles | Supabase SDK + RLS + Auth patterns |
| `supabase-postgres-best-practices` | dotfiles | Postgres perf + schema design |
| `superpowers/` (14 subskills) | obra/superpowers v5.1.0 via `superpowers-sync` | Methodology pack |
| `whisper` | dotfiles | whisper-transcribe HTTP API on localhost:7860 |
| `comfyui` | dotfiles | ComfyUI via llm-compose proxy on localhost:11434 |
| `lora-train` | dotfiles | kohya sd-scripts via proxy on localhost:11434 |
| `research` | dotfiles | SearXNG + crawler + OSINT toolkit |
| `gh-search` | dotfiles | GitHub code/issue/PR/repo search via `gh` CLI |

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
/footer                     # toggle git branch + token stats in footer
/session-name <label>       # name session for pi -r selector
/bookmark [label]           # bookmark last assistant message
/trigger-compact            # compact conversation now (auto at 100k)

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

## Useful env

```bash
SUPERPOWERS_OFF=1           # disable superpowers injection
SUPERPOWERS_BOOTSTRAP=...   # custom using-superpowers SKILL.md path
PI_OFFLINE=1                # disable startup network checks (update + telemetry)
PI_SKIP_VERSION_CHECK=1     # only disable the version-check ping
```

## See also

- Pi docs: `/opt/pi-coding-agent/docs/` (extensions.md, skills.md, models.md, etc.)
- Pi examples: `/opt/pi-coding-agent/examples/extensions/`
- Upstream: https://pi.dev / https://github.com/earendil-works/pi
