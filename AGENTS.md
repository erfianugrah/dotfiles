# dotfiles repo — agent notes

Project-specific guidance for an agent working in `~/dotfiles`. The global
agent rules live in `.config/opencode/AGENTS.md` (which `~/.pi/agent/AGENTS.md`
symlinks to); the notes here are repo-shape only.

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
  hop). The legacy app is NOT running. Only reach for opencode docs / source when answering a
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
but should NOT be linked to `$HOME` — `.git`, `README.md`, `AGENTS.md`,
package lists, nested config dirs already managed elsewhere.

**Rule of thumb:** edit the source at `~/dotfiles/<path>`, NEVER the live
symlink target. Changes propagate instantly through the symlink.

## Pi extensions

- Source: `.pi/agent/extensions/*.ts` — one file per extension, auto-loaded
  by pi at startup. `.disabled` suffix opts a file out without deleting it.
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
  (all extensions, skills, prompts, the global `AGENTS.md`, `tool-routing`)
  is user/global and loads on every startup. Since the whole repo is
  stow-symlinked into `~/.pi/agent/`, all our mods are always loaded.
- **Trust gates `<cwd>/.pi/` + `<cwd>/AGENTS.md` only.** In `~/dotfiles`
  that's effectively just `~/dotfiles/AGENTS.md` (pi reads project
  resources from `<cwd>/.pi/`, not `<cwd>/.pi/agent/`, so our source tree
  is invisible to the project loader — no double-load).
- **Decisions persist** to `~/.pi/agent/trust.json` (runtime state, NOT
  tracked). A new repo prompts once on interactive startup; `/trust` saves
  it (restart to apply). Non-interactive `pi -p` skips project inputs
  unless the cwd is in `trust.json` or `-a`/`--approve` is passed.
- **Subagent spawners pass `-a`.** `task.ts` and `bg-tasks.ts` add
  `-a`/`--approve` to their `pi -p` invocations so subagents load
  project-local `AGENTS.md` / `.pi` resources in the parent's cwd (they
  share the parent's trust boundary). This restores the pre-0.79 default.
  If you add another `pi -p` spawner, pass `-a` too.

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

- `.pi/agent/APPEND_SYSTEM.md` — gets appended to the system prompt every
  turn. Project-wide rules go here.
- `.pi/agent/prompts/tool-routing.md` — referenced from APPEND_SYSTEM.md;
  loaded by the `tool-routing.ts` extension.
- `.pi/agent/prompts/local-model-rules.md` — appended only when a local
  llama-server model is in use.
- Other `prompts/*.md` files are slash-command templates.

## Where things DON'T live

- Live `auth.json`, `sessions/`, `session-fts.db*`, `bg-tasks/`, `todos/`,
  `memories.json` — runtime state under `~/.pi/agent/`, NOT tracked.
- `node_modules/`, `bun.lock`, `package-lock.json` under any subtree —
  see `.stow-local-ignore`.

## Commits

- Conventional Commits format (`feat:`, `fix:`, `docs:`, `chore:`, …).
- Scope by area: `feat(pi-extensions): …`, `docs(skills/foo): …`,
  `fix(prompt): …`, `chore(packages): …`.
- No AI-attribution trailers. Author is the user.
