# ~/infra - agent notes

Container directory for the infrastructure repo family. NOT itself a git repo
(except each child). Most child repos have their own AGENTS.md with canonical
build/deploy/test commands - read it before working in that repo (not all do;
check first).

## Layout rules

- One repo per domain; each maps to a private GitHub repo under `erfianugrah/`.
  Exceptions: `ai/llm-compose` is PUBLIC; `bombe/`, `lockstep/`, `mnemosyne/`
  are local-only (no remote yet); `openwrt/` tracks upstream
  `openwrt/openwrt` as origin (erfianugrah fork as `fork` remote,
  plus `ecsv` remote at ecsv/openwrt).
  Not repos at all: `docs/`, `knotea-build/`,
  `storage-migration-tracker.md`.
- `ai/` and `ergo/` are the only sub-groupings. `ergo/` has its own workspace
  AGENTS.md covering its Go projects.
- New infra repos go directly under `~/infra/`, not in `$HOME`. Don't create
  new top-level `~/*-compose` dirs.

## Cross-cutting conventions

- **Secrets**: SOPS+age everywhere. `.env` files in compose repos are
  SOPS-encrypted in place; never commit plaintext (pre-commit hooks enforce).
  Current age recipient lives in the dev-box keys.txt (both legacy + current
  keys); see the composer skill for the key story.
- **Deploys**: composer-managed stacks deploy via the Composer API
  (composer.erfi.io), NOT by running docker compose against servarr by hand.
  See the `composer` and `eaves` skills.
- **NixOS hosts** (`router/`, `servarr-nixos/`, `hearth/`): uniform
  `make deploy` / `make diff` / `make check` in each repo - consolidated
  2026-08-26. Each host holds a git clone force-reset to `origin/main` on
  every deploy (`/etc/nixos` for router + servarr, `~/hearth` for the Pi), so
  the clone is a cache and never an edit surface. Per-host read-only GitHub
  deploy key + `gh-<host>` ssh alias; private key never leaves the box. The
  dev box has `nix` for eval only - no `nixos-rebuild` here, ever. Full
  conventions + rollback: the `nixos` skill.
  - **Always declare MTU explicitly, even at the default 1500**: networkd and
    the NixOS activation only manage MTU when the option is present, so
    deleting it leaves the last-set value live forever (bit both the router
    trunk and servarr's NIC on 2026-08-26).
  - **Shared profiles live in `nixos-fleet/`** (a LIBRARY, not a monorepo -
    a monorepo was tried and rejected 2026-08-26 because almost nothing in
    these configs is reusable). Hosts import it as a flake input with
    `inputs.nixpkgs.follows = "nixpkgs"`, so each builds the profiles against
    its OWN pin and bumps `fleet` when it chooses. Adopted on hearth
    2026-08-26, router 2026-08-28 (shell profile); servarr pending.
    Host-specific config, and anything hardware-specific, stays in the host
    repo.
  - `make cache` in `nixos-fleet/` before adding any package: the fleet is
    mixed-arch (x86_64 router + servarr, aarch64 hearth + RK1) and an
    uncached aarch64 package is compiled on the target, where its test suite
    gates the deploy.
- **MCP tool paths**: pi-mcp-bridge reads `~/.pi/agent/mcp-servers.json`
  (a stow symlink into `~/dotfiles`), which hardcodes
  `/home/erfi/infra/ai/llm-compose/mcp/*.py` (whisper/comfyui/train servers).
  If `ai/llm-compose` moves again, update that file or those tools break.
  (The old `~/.config/opencode/opencode.json` path is gone - opencode was
  retired 2026-08-15.)
- **Skill references**: pi skills that point into this tree live in
  `~/dotfiles/.pi/agent/skills/`. Path changes here must be mirrored there
  (rg --hidden, .pi is a hidden dir).
- **Pi session cwd**: sessions started in `~/infra` do NOT auto-load child
  AGENTS.md files; the cd-agents-reload guard surfaces them on first `cd`
  into a child.

## History

2026-08-08 consolidation: 16 repos moved from `$HOME` into `~/infra`
(incl. ergo workspace whole, llm-compose+whisper-transcribe under `ai/`,
all *-compose stacks, k3s, cf-tf, composer). Path references updated in
dotfiles skills/extensions, opencode.json, ssh config. k3s retired in favour
of bombe (Talos-vs-NixOS decision pending, see bombe/docs/research/).

Since then (as of 2026-09-01): `knotea` moved INTO `~/infra`;
`erfianugrah-cf-tf` now lives at `~/cf-stuff/erfianugrah-cf-tf`;
`gitea-compose` replaced by `forgejo-compose`; ~30 new repos added
(see README.md for the full inventory).
