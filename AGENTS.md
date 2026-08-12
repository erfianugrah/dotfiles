# dotfiles repo — agent notes

Project-specific guidance for an agent working in `~/dotfiles`. The global
agent rules live in `.config/opencode/AGENTS.md`; pi receives them via the
`tool-routing.ts` extension's prepend (the old `~/.pi/agent/AGENTS.md`
symlink was retired 2026-08-09 because pi loaded it natively AND the
extension prepended it - a 17.7KB/turn double injection). The notes here
are repo-shape only.

## What's running here (pi vs opencode disambiguation)

"opencode" is overloaded in this tree. Three different things share the
name; the agent has historically conflated them. Use these meanings
exactly:

- **pi** — the harness binary at `/opt/pi-coding-agent/pi`. This is what
  is running RIGHT NOW. Owns the TUI, extensions, skills loader, sessions,
  tool dispatch, clipboard paste handling, image pruning. When the user
  says "the agent", "the harness", "this session", or asks about
  extensions / commands / TUI behaviour, the answer is about **pi**.
  Source: `/opt/pi-coding-agent/`, docs at `/opt/pi-coding-agent/docs/`.

- **opencode-zen** — the AI gateway service the user self-hosts. Pi
  registers it as a provider literally named `"opencode"` (see
  `~/.pi/agent/auth.json` and `~/.pi/agent/settings.json`
  `defaultProvider: "opencode"`). It proxies model inference (Anthropic /
  OpenAI / etc.) behind a single endpoint with the user's API key. When
  the user mentions "the provider", "the gateway", model routing, API
  keys, or rate-limit handling, the answer is about **opencode-zen** —
  NOT the harness, NOT the legacy TUI.

- **opencode (legacy TUI)** — the standalone `opencode` TUI app the user
  ran BEFORE migrating to pi. Configs still live in `.config/opencode/`
  in this repo and are partially shared with pi via symlink
  (`~/.config/opencode/skills` → `~/dotfiles/.pi/agent/skills` since the
  2026-05-27 relocation; pi is canonical, opencode is the back-compat
  hop). It is an occasional alternate harness (pi.dev is the daily driver), not the current primary. Only reach for opencode docs / source when answering a
  question about the upstream project this codebase forked patterns from
  (e.g. the `tool-output-prune` algorithm is a port from
  `~/opencode/packages/opencode/src/session/compaction.ts`).

**Rule when writing**:
- Talking about harness behaviour → say **pi**, never "opencode".
- Talking about model gateway / API auth → say **opencode-zen** (or
  "the `opencode` provider in pi's auth"), never bare "opencode".
- Talking about historical patterns / forked code → say **opencode**
  with a qualifier like "upstream opencode" or "opencode TUI".

**Quick check**: if you find yourself writing "opencode handles X" or
"opencode prunes Y" about live behaviour — STOP and replace with "pi".
The legacy opencode TUI is not the thing pruning your tool output; the
`tool-output-prune.ts` extension running inside pi is.

## Layout & symlink convention

This repo is the **source of truth** for everything in `~/.pi/agent/`,
`~/.config/opencode/`, and a handful of other dotfile trees. Live copies in
`$HOME` are **stow-managed relative symlinks back into this repo**:

```
~/.pi/agent/extensions/foo.ts  →  ../../../dotfiles/.pi/agent/extensions/foo.ts
~/.config/opencode/AGENTS.md   →  ../../dotfiles/.config/opencode/AGENTS.md
~/.zshrc                       →  dotfiles/.zshrc
```

Managed by GNU stow with the repo itself as the package. To install or
repair the whole tree:

```bash
cd ~ && stow -d ~/dotfiles -t ~ -v .          # idempotent; links missing entries
cd ~ && stow -d ~/dotfiles -t ~ -n -v .       # dry run, shows what would link
```

`.stow-local-ignore` (at repo root) excludes files that live in the repo
but should NOT be linked to `$HOME` - `.git`, `README.md`, `AGENTS.md`,
the root `package.json`, package lists, nested config dirs already managed
elsewhere. It is also where DELIBERATE real-file exceptions are documented:
`.config/opencode/opencode.json` is a real file by design (pi-mcp-bridge
reads it; not stow-linked), with a comment in the ignore file saying so.

**Drift check:** `stow-drift` (in `bin/`, Go) walks the repo and flags any
`$HOME` target that is a real file instead of a symlink into the repo -
the failure mode where edits to one side silently diverge. Run it after any
manual `~/.config` or `~/.ssh` edit; exit 1 means drift. Known-good state is
`0 drifted` (opencode.json is exempted via the ignore file, everything else
must link).

**PATH tools:** `~/bin` is a folded stow link but NOT on PATH. Tools that
need to be runnable by name (`mdclip`, `stow-drift`) are additionally
linked into `~/.local/bin` by the `do_local_bin` step in `install.sh`
(which also builds the stow-drift Go binary when it's missing and a go
toolchain is present). New PATH tools: add to the `tools=(...)` list there.

**Rule of thumb:** edit the source at `~/dotfiles/<path>`, NEVER the live
symlink target. Changes propagate instantly through the symlink.

## Cross-machine install (two paths)

The pi harness (extensions / skills / prompts / theme under `.pi/agent/`)
reaches a new machine two ways. They are complementary - pick one per
machine; do NOT use both on the same machine or resources load twice.

1. **GNU stow (primary machines - full dotfiles).** Clone + `stow` as above.
   Gets everything (shell, terminal, git, AND the pi harness symlinked into
   `~/.pi/agent/`). The source-of-truth workflow.

2. **pi package (any machine - just the pi harness).** The repo root carries a
   `package.json` with a `pi` manifest (keyword `pi-package`), so pi installs
   the resources directly - no stow, no full dotfiles:

   ```bash
   pi install git:github.com/erfianugrah/dotfiles@<ref>   # pin a tag/commit
   pi update --extensions                                 # reconcile later
   ```

   This carries the 55 top-level + 3 directory extensions, 46 skills (+6
   superpowers subskills), 8 prompt templates and the theme. It does NOT carry
   user config (pi packages
   ship resources only): `settings.json`, `models.json`, `keybindings.json`,
   `APPEND_SYSTEM.md`. Bootstrap those once (idempotent; symlinks the 4 files
   into `~/.pi/agent/`, backing up any existing non-symlink; `COPY=1` to copy):

   ```bash
   bash ~/.pi/agent/git/github.com/erfianugrah/dotfiles/.pi/agent/install-config.sh
   ```

   `auth.json` / sessions / memories stay per-machine (never synced) - log in
   with `pi` then `/login`.

**Never run path 2 on a stow machine** - the resources are already loaded via
the `~/.pi/agent/` symlinks, so `pi install` would double-load them.

## Claude Code wiring (.claude/)

Claude Code is wired into the same canonical skills tree via per-skill
symlinks, NOT a whole-dir link (`~/.claude/skills/` already holds a locally
installed Cloudflare skill set a whole-dir link would clobber):

- `.claude/skills/<name>` -> `../../.pi/agent/skills/<name>` - one relative
  symlink per shared skill (17 domain skills today). Add another the same
  way + stow; stow nests it alongside the local skills, no folding.
- `.claude/CLAUDE.md` - universal agent rules (authorship, safety,
  confidential IDs, ASCII output, calibration). A handwritten
  harness-agnostic subset of `.pi/agent/APPEND_SYSTEM.md`, kept in sync
  manually - pi's APPEND_SYSTEM has no include mechanism, so a shared file
  with includes would be a sync hazard.
- `.claude/settings.hooks.json` - the tracked HOOKS FRAGMENT; `.claude/settings.json`
  itself is stow-ignored because the live `~/.claude/settings.json` is
  Claude-mutated user state (`enabledPlugins` is machine-specific), so
  `install.sh do_claude()` jq-merges the fragment's `hooks` into it instead
  of linking.
- `.claude/hooks/*.ts` + `.claude/mcp/toolkit.ts` - the CC guard hooks and
  the 22-tool MCP server over the shared `.pi/agent/extensions/lib/` cores.
  See `.pi/agent/docs/pi-to-claude-code-port.md`.

## Pi extensions

- Source: `.pi/agent/extensions/*.ts` — one file per extension, auto-loaded
  by pi at startup. `.disabled` suffix opts a file out without deleting it.
- **Shared helper modules** (imported by 2+ extensions, not extensions
  themselves) live in `.pi/agent/extensions/lib/`. Pi auto-loads top-level
  `*.ts` and `*/index.ts` only (docs/extensions.md), so a subdir without an
  `index.ts` is ignored by the loader but importable. NEVER put a helper as a
  loose top-level `.ts`: pi demands a default factory from every top-level
  file and a bare helper breaks ALL extension loading at startup
  ("does not export a valid factory function"). The pi-package manifest globs
  also exclude `lib/`, which is correct - git-package installs clone the
  whole repo, so the helper is still on disk for importers.
- Live at: `~/.pi/agent/extensions/` — each file individually symlinked.
- **Adding a new extension:**
  1. Write `.pi/agent/extensions/<name>.ts` in the repo.
  2. `cd ~ && stow -d ~/dotfiles -t ~ -v .` (idempotent — links only the new file).
  3. Restart pi (a running session won't pick up new extensions).
- Pure helpers go in unit tests. Side-effectful execute() paths get a
  /tmp/ integration test driven via the SDK preload mock (see
  `.pi/agent/tests/preload.ts` for the stub pattern).

## Project trust (pi 0.79+)

Since pi 0.79.0, pi gates **project-local** inputs behind a trust decision.
This is mostly transparent here, but know the model:

- **Global config is never gated.** Everything under `~/.pi/agent/`
  (all extensions, skills, prompts, `tool-routing`)
  is user/global and loads on every startup. Since the whole repo is
  stow-symlinked into `~/.pi/agent/`, all our mods are always loaded.
  (There is deliberately no `~/.pi/agent/AGENTS.md` - see the header
  note for why.)
- **Trust gates `<cwd>/.pi/` + `<cwd>/AGENTS.md` only.** In `~/dotfiles`
  that's effectively just `~/dotfiles/AGENTS.md` (pi reads project
  resources from `<cwd>/.pi/`, not `<cwd>/.pi/agent/`, so our source tree
  is invisible to the project loader — no double-load).
- **Decisions persist** to `~/.pi/agent/trust.json` (runtime state, NOT
  tracked). A new repo prompts once on interactive startup; `/trust` saves
  it (restart to apply). Non-interactive `pi -p` skips project inputs
  unless the cwd is in `trust.json` or `-a`/`--approve` is passed.
- **Subagent spawners pass `-a` when the parent trusts the cwd.** `task.ts`
  and `bg-tasks.ts` add `-a`/`--approve` to their `pi -p` invocations
  *conditionally* — gated on `ctx.isProjectTrusted()` (pi 0.79.1+) so the
  subagent inherits the parent's actual trust decision instead of
  force-loading project inputs the user may have declined. When the parent
  trusts the cwd, subagents load project-local `AGENTS.md` / `.pi` resources
  (pre-0.79 default); when it doesn't, they skip them too. `isProjectTrusted`
  is treated as `true` if absent (pi < 0.79.1). If you add another `pi -p`
  spawner, gate `-a` the same way.
- **Global alternative: `defaultProjectTrust`.** Since 0.79.1 a global
  settings key `defaultProjectTrust` (`"ask"` default / `"always"` /
  `"never"`) controls the fallback when no saved/CLI decision applies. We do
  NOT set it to `"always"` — that would auto-trust *every* cwd, far broader
  than the scoped per-spawner `-a`. The `-a` gate stays the mechanism.

## Tests

```bash
./.pi/agent/tests/run.sh                  # all extension unit tests
./.pi/agent/tests/run.sh tool-guard       # filter by name
bun test /tmp/test-foo.ts                 # ad-hoc integration tests
```

Unit tests cover pure helpers only — exported parsers, validators, splitters.
Side-effectful code (DB, SSH, HTTP, filesystem) goes in ad-hoc integration
tests in /tmp/ that drive the real `execute()` via the SDK preload mock.

## Skills

- Source: `.pi/agent/skills/<name>/SKILL.md` + supporting files.
  Canonical location since 2026-05-27 — pi is primary, the path mirrors
  `.pi/agent/extensions/`.
- Live at: `~/.pi/agent/skills/` (stow-managed relative symlink to the
  dotfiles tree, 1 hop).
- Opencode (legacy) reads the same tree via `~/.config/opencode/skills`
  → `~/dotfiles/.config/opencode/skills` → `../../.pi/agent/skills`. The
  in-repo `~/dotfiles/.config/opencode/skills` is a committed symlink
  preserving back-compat without duplicating the source.
- **Add a new skill:** create `.pi/agent/skills/<name>/SKILL.md` in the
  repo, then `cd ~ && stow -d ~/dotfiles -t ~ -v .` if you also added
  supporting files alongside it. Both pi and opencode pick it up
  immediately (no symlink work needed for new files; they live inside
  the already-symlinked directory).
- **Edit a skill:** edit the source file in `~/dotfiles/.pi/agent/skills/<name>/`,
  never the live `~/.pi/agent/skills/<name>/` symlink target.

## Prompts (system-prompt fragments)

- `.pi/agent/APPEND_SYSTEM.md` - gets appended to the system prompt every
  turn. Project-wide rules go here. Also carries the `## Documentation` and
  `## General computer use` sections (moved out of
  `.config/opencode/AGENTS.md` in the 2026-08-09 double-injection fix).
- `.config/opencode/AGENTS.md` - the tool-routing rules themselves. pi gets
  them ONLY via `tool-routing.ts`, which prepends everything above the
  `<!-- tool-routing:end -->` marker each turn.
- `.pi/agent/prompts/local-model-rules.md` — appended only when a local
  llama-server model is in use.
- Other `prompts/*.md` files are slash-command templates.

## Where things DON'T live

- Live `auth.json`, `sessions/`, `session-fts.db*`, `bg-tasks/`, `todos/`,
  `memories.json`, `.docs-topics.json` (tool-guard's docs-topic cache) -
  runtime state under `~/.pi/agent/`, NOT tracked.
- `node_modules/`, `bun.lock`, `package-lock.json` under any subtree —
  see `.stow-local-ignore`.

## Commits

- Conventional Commits format (`feat:`, `fix:`, `docs:`, `chore:`, …).
- Scope by area: `feat(pi-extensions): …`, `docs(skills/foo): …`,
  `fix(prompt): …`, `chore(packages): …`.
- No AI-attribution trailers. Author is the user.
