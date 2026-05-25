# dotfiles repo — agent notes

Project-specific guidance for an agent working in `~/dotfiles`. The global
agent rules live in `.config/opencode/AGENTS.md` (which `~/.pi/agent/AGENTS.md`
symlinks to); the notes here are repo-shape only.

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

- Source: `.config/opencode/skills/<name>/SKILL.md` + supporting files.
- Live at: `~/.config/opencode/skills/` (stow-managed relative symlink to
  the dotfiles tree).
- Pi reads the same tree via `~/.pi/agent/skills` (legacy absolute symlink
  pointing to `~/.config/opencode/skills`; one indirection but works).

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
