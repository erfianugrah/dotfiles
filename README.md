# dotfiles

Cross-platform dotfiles managed with [GNU Stow](https://www.gnu.org/software/stow/).
Targets Arch Linux (native + WSL2), macOS, and Steam Deck (SteamOS via Nix).

The pi coding-agent harness under `.pi/agent/` (66 extensions, 61 skills,
8 prompt templates, theme) is also packaged as a **pi package**
(`@erfianugrah/pi-harness`, root `package.json`). Install it standalone on any
machine - no stow required - with `pi install git:github.com/erfianugrah/dotfiles`.
See [`.pi/agent/README.md`](.pi/agent/README.md) and the "Cross-machine install"
section of [`AGENTS.md`](AGENTS.md).

## Repository layout

```
.zshrc                         # main shell config (zinit, plugins, aliases, PATH)
.p10k.zsh                      # Powerlevel10k theme (lean 8-color, 1-line)
.tmux.conf                     # tmux config (TPM, tokyo-night, vim-navigator)
.wezterm.lua                   # WezTerm terminal (workspaces, splits, WSL)
.gitconfig                     # Git (GPG signing, delta pager, diff3 merge)
.vimrc                         # minimal vim (numbers, syntax, mouse)
.ssh/config                    # SSH hosts (Cloudflare Tunnel, Proxmox, TuringPi, etc.)

functions.zsh                  # modular loader - sources functions.d/*
functions.d/
  system.zsh                   # OS detection, update_all, fix_file_limits
  crypto.zsh                   # SOPS/Age encrypt & decrypt
  bitwarden.zsh                # bw serve API, cache, env loaders
  terraform.zsh                # tf_out, debug toggles, cf_permissions
  misc.zsh                     # ansible, tmux, yazi, p10k helpers
  packages.zsh                 # install_packages, save_packages, diff_packages

packages/
  arch-repo.txt                # pacman native repo packages
  arch-aur.txt                 # AUR packages (paru)
  brew.txt                     # Homebrew formulae (macOS)
  brew-cask.txt                # Homebrew casks (GUI apps)
  npm-globals.txt              # npm global packages
  go-tools.txt                 # go install modules
  cargo-tools.txt              # cargo install crates
  pip-requirements.txt         # pip user packages
  deno-tools.txt               # deno installed tools
  standalone.txt               # binary downloads (~/.local/bin)
  nix/
    flake.nix                  # Home Manager flake (Steam Deck)
    home.nix                   # declarative package list + config

bin/
  caddyfmt                     # Caddyfile formatter (Python, stdin/stdout)

.config/
  atuin/config.toml            # Atuin shell history (self-hosted sync)
  systemd/user/bw-serve.service  # Bitwarden CLI REST API service

.claude/                       # Claude Code wiring (user-level, stow-linked to ~/.claude/)
  CLAUDE.md                    # universal agent rules (harness-agnostic subset of APPEND_SYSTEM.md)
  skills/                      # per-skill relative symlinks -> ../../.pi/agent/skills/<name>
                               # (23 promoted today - the directory IS the allowlist, see AGENTS.md
                               #  "Agent-surface routing"; coexists with the local Cloudflare skill set.
                               #  settings.json deliberately NOT tracked - Claude mutates it live)

.pi/agent/                     # pi AI coding agent (PRIMARY harness; canonical skills + resources)
  APPEND_SYSTEM.md             # appended: Commit/PR, Safety, Epistemic calibration, Confidential-IDs, Output
  skills/                      # 61 skills, flat (canonical since 2026-05-27; superpowers tree absorbed 2026-08-16)
  prompts/                     # markdown sources loaded by extensions
    local-model-rules.md       #   prepended only for gemma/qwen/llama-server models
    commit.md, pr.md, review.md, test.md, init.md, rollback.md, docs-reference.md
  extensions/                  # TypeScript plugins
    tool-routing.ts            #   prepends prompts/tool-routing.md (above the tool-routing:end
                               #   marker) as system-prompt prefix; resolves self-relative to
                               #   its own module path so pi-package checkouts work
    exa.ts, webfetch.ts, oci-tags.ts, web-research.ts
    docs.ts, context7.ts, session-search.ts
    memory.ts, todowrite.ts, task.ts, question.ts
    git-gh-gate.ts, local-model-rules.ts, lsp/
    render-diagram.ts          #   mermaid + d2 via local mmdc / d2 CLI
    build-favicon-set.ts       #   SVG/PNG → full PWA favicon set
  themes/                      # pi TUI themes (opencode-dark, etc.)
  models.json, settings.json

.git-template/hooks/pre-commit # global pre-commit: block unencrypted secrets
wezterm.sh                     # WezTerm shell integration (OSC 7/133)

tests/
  run-all.sh                   # Docker test matrix runner
  harness.zsh                  # shared test assertions
  test-arch.zsh                # Arch Linux test (system + ecosystem)
  test-steamos.zsh             # Steam Deck test (nix + detection)
  test-macos.zsh               # macOS simulation (Linuxbrew + validation)
  Dockerfile.arch              # cached Arch image
  Dockerfile.steamos           # Arch + Nix + deck markers
  Dockerfile.macos             # Ubuntu + Linuxbrew
```

## Multi-OS support

| Platform | Pkg manager | Lists |
|---|---|---|
| **Arch Linux** (native, WSL2) | pacman + paru (AUR) | `packages/arch-repo.txt`, `packages/arch-aur.txt` |
| **macOS** | Homebrew (formulae + casks) | `packages/brew.txt`, `packages/brew-cask.txt` |
| **Steam Deck** (SteamOS) | Nix (Home Manager + flakes) | `packages/nix/flake.nix`, `packages/nix/home.nix` |

Platform detected automatically at shell startup via `_SYS_OS` / `_SYS_PKG`
(set by `system.zsh`). Steam Deck identified by `/etc/steamos-release` or
`$USER == deck`.

## Quick start

```sh
# 1. Clone and stow
git clone git@github.com:erfianugrah/dotfiles.git ~/dotfiles
cd ~/dotfiles
stow .

# 2. Install packages for your platform
install_packages     # auto-detects: brew / pacman+paru / nix

# 3. First shell launch auto-installs zinit, powerlevel10k, and plugins
```

## Platform-specific bootstrap

### Arch Linux (native / WSL2)

```sh
sudo pacman -S zsh stow git
chsh -s /usr/bin/zsh

# Install paru (AUR helper) if not present
sudo pacman -S --needed base-devel
git clone https://aur.archlinux.org/paru.git /tmp/paru && cd /tmp/paru && makepkg -si

cd ~/dotfiles && stow .
install_packages
```

### macOS

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install zsh stow git
chsh -s /opt/homebrew/bin/zsh

cd ~/dotfiles && stow .
install_packages
```

> **Note:** Terraform requires the HashiCorp tap (`hashicorp/tap/terraform`).
> The brew list includes the full tap path; `install_packages` handles this
> automatically.

### Steam Deck

SteamOS is immutable - `pacman` installs get wiped on OS updates. Nix
survives updates by storing everything in `/nix/store`.

```sh
# Switch to Desktop Mode, open Konsole, set password
passwd

# Install Nix (Determinate Systems installer)
curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install
sudo reboot

# After reboot
nix run nixpkgs#hello   # verify nix works
cd ~/dotfiles && stow .
install_packages         # copies flake to ~/.config/home-manager, runs home-manager switch
```

To add/remove packages, edit `packages/nix/home.nix` and run
`install_packages` again. To update all nix packages:

```sh
cd ~/.config/home-manager
nix flake update
home-manager switch --flake .#deck
```

## Package management

`install_packages` runs three phases in order:

| Phase | What | Lists |
|---|---|---|
| **1. System** | pacman+paru / brew / nix | `arch-repo.txt`, `arch-aur.txt`, `brew.txt`, `brew-cask.txt`, `nix/` |
| **2. Ecosystems** | npm, go, cargo, pip, deno | `npm-globals.txt`, `go-tools.txt`, `cargo-tools.txt`, `pip-requirements.txt`, `deno-tools.txt` |
| **3. Standalone** | Binary downloads to `~/.local/bin` | `standalone.txt` |

Phase 1 installs runtimes (node, go, rust, python, deno). Phase 2 needs
those runtimes. Phase 3 handles tools with custom install methods.

> **npm globals isolation:** On Arch, npm is installed via pacman and its
> global prefix is `/usr/lib`. `install_packages npm` automatically redirects
> globals to `~/.npm-global/` to avoid conflicts with pacman-managed packages
> on `pacman -Syu`. The `~/.npm-global/bin` is in PATH via `.zshrc`.
> System npm packages (`bitwarden-cli`, `pnpm`, `yarn`) are always owned by
> the system package manager.

```sh
install_packages             # all three phases
install_packages system      # phase 1 only (pacman+paru / brew / nix)
install_packages ecosystem   # phase 2 only (npm, go, cargo, pip, deno)
install_packages standalone  # phase 3 only (binary downloads)
install_packages npm         # single ecosystem
install_packages go          # single ecosystem
```

```sh
save_packages                # snapshot all installed packages to list files
save_packages system         # system lists only
save_packages ecosystem      # ecosystem lists only
diff_packages                # show drift: + installed but not in list, - missing
```

`save_packages` captures the current state:
- **Arch:** `pacman -Qqen` (repo) and `pacman -Qqem` (AUR)
- **macOS:** `brew leaves` (formulae) and `brew list --cask` (casks)
- **Ecosystems:** `npm list -g`, `go version -m`, `cargo install --list`,
  `pip list --user`, deno bins
- **Steam Deck:** packages managed declaratively in `home.nix`

> **Tapped formulae caveat:** `brew leaves` outputs short names. Tapped
> packages (e.g. `hashicorp/tap/terraform`) may save as `terraform`. Verify
> tap paths after running `save_packages`.

## Post-install setup

These tools need one-time setup beyond package installation.

### Font

IosevkaTerm Nerd Font is the configured font for WezTerm and the terminal.

- **Arch:** `ttf-iosevkaterm-nerd` (included in package lists)
- **macOS:** download from [Nerd Fonts releases](https://github.com/ryanoasis/nerd-fonts/releases)

### tmux + TPM

```sh
git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
tmux source ~/.tmux.conf
# prefix (Ctrl-A) + I to install plugins
```

> **macOS yellow status bar:** `tokyo-night-tmux`'s `themes.sh` uses `declare -A`
> (bash >= 4.2), but macOS ships bash 3.2 at `/bin/bash` and the script bails ->
> default yellow/orange bar. Fix: `brew install bash` (now in `packages/brew.txt`,
> so `install_packages` handles it), then `tmux kill-server` and reopen - the
> running server caches the old PATH, so a restart is required. `.tmux.conf`
> already prepends Homebrew to the tmux server PATH so `env bash` finds 4.2+.

### pi (coding agent)

Installed automatically by `install_packages` (Phase 3 standalone). Run
`install_pi` directly to update or to replace an npm/Node pi install.

```sh
install_pi   # fetches the standalone Bun binary -> ~/.local/opt/pi + ~/.local/bin/pi
```

> Use the **standalone Bun binary**, not `npm install -g` / `pi.dev/install.sh`
> (those install the Node build, which lacks `bun:sqlite` and breaks Bun-only
> extensions like `session-fts` with "bun:sqlite module not found").

### Neovim

```sh
git clone https://github.com/erfianugrah/kickstart.nvim.git "${XDG_CONFIG_HOME:-$HOME/.config}"/nvim
```

### Atuin (shell history sync)

Self-hosted sync server at `atuin.erfi.io`. Install the client:

```sh
curl --proto '=https' --tlsv1.2 -LsSf https://setup.atuin.sh | sh
```

Config at `.config/atuin/config.toml` (stowed automatically).

### Rust

```sh
curl https://sh.rustup.rs -sSf | sh
```

### bun and deno

```sh
curl -fsSL https://bun.sh/install | bash
curl -fsSL https://deno.land/install.sh | sh
```

### GPG signing

Git commits are signed with GPG key `B9D283E8AE4E56B4`. Import your key and
ensure `gpg-agent` is running:

```sh
gpg --import <your-key>
export GPG_TTY=$(tty)   # already in .zshrc
```

`gpg-agent.conf` (tracked at `.gnupg/gpg-agent.conf`, stow-linked) caches the
passphrase for 7 days idle / 30 days max, so headless shells (tmux loops,
`pi -p` subagents) can sign without a TTY for pinentry. If a commit dies
with `gpg failed to sign the data`, the cache is cold - NEVER bypass with
`--no-gpg-sign`; warm it instead:

```sh
gpg_unlock   # seeds from Vaultwarden item GPG_KEY_PASSPHRASE via bw serve
             # (no TTY needed), or prompts once via pinentry interactively
```

In practice you should never need to run it: `bw_serve_start` seeds the
agent automatically after unlocking, and a zsh `preexec` hook re-seeds
silently before any `git commit`/`tag`/`merge`/`rebase`/`cherry-pick`/
`revert`/`am` when the TTL has lapsed. Pinentry only appears when bw serve
is locked or the item is missing.

The bw item holds the passphrase in its `notes` field. Signing must never be
bypassed; pi's tool-guard hard-blocks `--no-gpg-sign` /
`-c commit.gpgsign=false`.

### bw-serve (Bitwarden CLI REST API)

Secrets are served via `bw serve` on `127.0.0.1:8087`. On Linux, runs as a
systemd user service. On macOS, runs via `nohup` in background.

```sh
# Linux: enable the systemd service (one-time, after stow)
systemctl --user daemon-reload
systemctl --user enable bw-serve.service

# All platforms: unlock vault and start the API
bw_serve_start
```

Daily usage:

```sh
bw_serve_start        # unlock vault, start API (once after login/reboot)
load_bw               # export personal secrets to env
load_wrangler_token   # export Cloudflare Wrangler token
load_sops_age_keys    # export SOPS Age keys
bw_serve_status       # check if API is running
bw_serve_sync         # pull latest from Bitwarden server
bw_serve_stop         # stop API, clear session
unset_bw_vars         # wipe all exported secrets from current shell
```

`load_bw` auto-starts the service if not running. The session survives
terminal/tmux restarts. `.zshrc` runs it automatically: the first
interactive shell after login prompts for the master password once (which
also seeds the gpg-agent signing cache), later shells re-export silently.
If you skip that first prompt, run `bw_serve_start` manually.

**Shell-startup cost.** Resolving the secrets means ~20 sequential HTTP
calls to the daemon (1 sync + 17 items + 2 SOPS notes), and `.zshrc` used to
pay that in *every* interactive shell - so every new tmux window. `load_bw`
therefore snapshots the resolved exports to `$XDG_RUNTIME_DIR/bw-env.zsh`
(0600, tmpfs, wiped on logout/reboot, so secrets never touch disk), and
later shells just source it.

Measured on one idle machine, min of 5: full load 1.11s, snapshot hit 0.52s,
and a shell with the Bitwarden block stubbed out entirely 0.56s. That last
comparison is the useful one - **a snapshot hit is indistinguishable from not
doing Bitwarden at all**. The absolute saving is not a fixed number: it was
~2.2s when first measured on a loaded box with cold page caches and ~0.6s
once everything was warm, so treat it as "between half a second and a couple
of seconds, largest exactly when the machine is busy".

On hosts without `XDG_RUNTIME_DIR` (macOS) the snapshot falls back to
`$TMPDIR`, which is real disk and not guaranteed to be cleared on logout -
the file is still 0600, but the never-touches-disk property does not hold
there. Set `_BW_ENV_CACHE_TTL=0` to disable the snapshot entirely if that
matters on a given machine.

The snapshot is stamped with the bw session epoch and a write time, and is
refused unless all of these hold: the stamp matches the live session, the
file is owned by you, and it is younger than `_BW_ENV_CACHE_TTL`. So it is
invalidated by `bw_serve_start` (new session) and by `bw_set` /
`clear_bw_cache` (explicit), and expires on its own after an hour. Any miss
falls through to a normal full load, which rewrites the snapshot.

Practical consequence: a secret you rotate **in the web vault** can be up to
an hour stale in newly-opened shells. `bw_set` has no such lag (it
invalidates), and `load_bw` in an existing shell always forces a fresh sync.
Already-running shells and agents keep their old env either way - that is
fundamental to env vars, not a caching artifact.

**Staleness gotcha:** a long-running serve daemon's access token can expire
silently - `/status` still says "unlocked" and `/sync` still returns
success, but the data goes stale (observed 2026-07-29). The accessors warn
on stderr once the session is >12h old, and `bw_serve_status` shows the
session age. If served secrets ever look stale, the fix is `bw_serve_start`
(fresh unlock + restart), not `bw_serve_sync`.

## Configurations

### Zsh (`.zshrc`)

- **Plugin manager:** [Zinit](https://github.com/zdharma-continuum/zinit)
  (auto-installs on first launch)
- **Theme:** [Powerlevel10k](https://github.com/romkatv/powerlevel10k) (lean
  8-color, 1-line, nerdfont-v3)
- **Plugins:** fzf-tab, zsh-completions, zsh-autosuggestions,
  history-substring-search, fast-syntax-highlighting
- **OMZ snippets:** tmux, git, kubectl, kubectx, terraform, opentofu, npm,
  python, gh, rust, ansible, sudo, colored-man-pages, and more

### Shell aliases

| Alias | Command | Notes |
|---|---|---|
| `k` | `kubectl` | |
| `t` | `tofu` | OpenTofu |
| `tf` | `terraform` | |
| `w` | `wrangler` | Cloudflare |
| `v` | `nvim` | |
| `p` | `python3` | |
| `c` | `cargo` | Rust |
| `s` | `sentry-cli` | |
| `sb` | `supabase` | |
| `ls` | `eza` | guarded - falls back if eza missing |
| `cat` | `bat` | guarded - falls back if bat missing |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `EDITOR` | `nvim` → `vim` → `nano` → `code` | first available; `bindkey -e` after to keep standard keybindings (zsh auto-enables vi mode when EDITOR contains `vi`/`nvim`) |
| `DOCKER_BUILDKIT` | `1` | always on |
| `LANG` / `LC_ALL` | `C.UTF-8` | |
| `ANSIBLE_PLAYBOOK_DIR` | `~/my-playbooks` | used by `ansible_on/off/update` |
| `BW_SERVE_PORT` | `8087` | Bitwarden serve port |
| `_BW_CACHE_TTL` | `300` | in-process `_bw_get` cache TTL in seconds |
| `_BW_ENV_CACHE_TTL` | `3600` | cross-shell secret snapshot TTL in seconds; bounds how long a web-vault edit can be stale in new shells |
| `_TF_CACHE_TTL` | `300` | tf_out cache TTL in seconds |

### tmux (`.tmux.conf`)

- **Prefix:** `Ctrl-A`
- **Plugins (TPM):** sensible, vim-tmux-navigator, tmux-yank, tokyo-night
- **Splits:** `-` horizontal, `=` vertical
- **Copy (WSL):** `y` in copy-mode sends to `clip.exe`
- **Base index:** 1 (windows and panes)
- **Mouse:** enabled

### WezTerm (`.wezterm.lua`)

- **Colorscheme:** Lovelace
- **Font:** IosevkaTerm NF, 12pt
- **Leader key:** `Ctrl-A` (same as tmux prefix - WezTerm handles workspaces,
  tmux handles sessions inside)
- **Workspaces:** `Leader+n/p` next/prev, `Leader+s` fuzzy picker,
  `Leader+c` create new
- **Panes:** `Leader+-` split vertical, `Leader+=` split horizontal,
  `Leader+h/j/k/l` navigate, `Leader+m` zoom, `Leader+Space` rotate
- **Tabs:** `Leader+t` new, `Leader+1-8` switch, `Leader+w` close pane,
  `Leader+x` close tab
- **WSL:** auto-connects to `WSL:archlinux` domain on Windows
- **Scrollback:** 10,000 lines, 120fps animations

### Git (`.gitconfig`)

- **Signing:** GPG commit signing enabled (key `B9D283E8AE4E56B4`)
- **Pager:** [delta](https://github.com/dandavison/delta) with navigation
- **Merge:** `diff3` conflict style
- **Pull:** rebase by default
- **Rerere:** enabled (remembers conflict resolutions)
- **Fetch:** auto-prune deleted remote branches
- **Push:** `autoSetupRemote` (push new branches without `-u`)
- **Template:** `~/.git-template` (includes pre-commit hook)
- **HTTP:** 500MB post buffer, HTTP/2

### SSH (`.ssh/config`)

Hosts organized by access method:

- **Cloudflare Tunnel:** `*.proxmox.erfianugrah.com`, `pie.erfianugrah.com`,
  `*.vyos.erfianugrah.com` - uses `cloudflared access ssh` as ProxyCommand
- **Self-hosted services:** `docs.erfi.io` (port 2222), `git.erfi.io` (port
  2223, Gitea)
- **Infrastructure:** Proxmox, VyOS routers, TuringPi cluster (rock1-4),
  servarr, KVMs
- **Tailscale mesh:** hosts accessible via `*.manticore-diatonic.ts.net`
- **Cloud:** GCP instances, Steam Deck

Global defaults (`Host *`):
- `ServerAliveInterval 60` - keepalive every 60s
- `IdentitiesOnly yes` - only offer configured keys (no agent key spray)
- `AddKeysToAgent yes` - auto-add keys on first use
- `HashKnownHosts yes` - privacy for known_hosts

### Pre-commit hook (`.git-template/hooks/pre-commit`)

Global Git hook (applied to all repos via `init.templateDir`). Blocks
committing unencrypted sensitive files:

- **Always checked:** `.env`, `.tfvars`, `.tfstate` - must be SOPS/Age
  encrypted
- **Content-scanned:** `.yaml`, `.yml`, `.json` - flagged only if they contain
  secret-like patterns (`password`, `secret`, `token`, `api_key`, etc.)
- **`.sops.yaml` integration:** files matching `path_regex` creation rules are
  checked for SOPS encryption
- **Escape hatches:**
  - `touch .allow-unencrypted` - skip all checks for this repo
  - `.allow-unencrypted-paths` - one glob pattern per line to skip specific
    files

### Atuin (`.config/atuin/config.toml`)

- **Sync:** self-hosted at `atuin.erfi.io`, v2 records enabled
- **Enter behavior:** `enter_accept = true`
- **Up arrow:** disabled (uses `Ctrl-R` for search)

---

## Shell functions

`functions.zsh` is a thin loader that sources modular scripts from
`functions.d/` in order. Each module is self-contained. The loader resolves
its own real path (`${0:A:h}`), so stow symlinks work transparently.

Load order: `system` → `crypto` → `bitwarden` → `terraform` → `misc` →
`packages`. Order matters: `system.zsh` sets `_SYS_OS`/`_SYS_PKG` used by
all other modules.

### `system.zsh` - System maintenance

OS-aware - detects platform and package manager at source time
(`apt`, `dnf`, `pacman`, `zypper`, `brew`). Also picks up Flatpak and Snap.

| Function | Description |
|---|---|
| `update_all` / `upall` | Update all detected package managers (apt, dnf, pacman + AUR, zypper, brew, flatpak, snap) |
| `fix_file_limits` / `fixfiles` | Inspect and optionally raise file descriptor limits (Linux: `limits.conf` + sysctl, macOS: `launchctl` + LaunchDaemon) |

### `crypto.zsh` - password hashing + SOPS / Age encryption

`bcrypt_hash [rounds]` prompts for a password (hidden, entered twice for
confirmation) and prints its bcrypt hash, verifying the hash round-trips
before printing. Default cost factor 12; requires the `bcrypt` python
package. Useful for seeding htpasswd / Authelia / app credential hashes.

Encrypt and decrypt files in-place using SOPS with Age keys. Requires
`SOPS_AGE_KEYS` to be set (use `load_sops_age_keys` or `load_bw`).

Private keys are never exported to the environment - passed inline to sops
commands via `SOPS_AGE_KEY="$key" sops ...` so they exist only for the
duration of each command.

| Function | Description |
|---|---|
| `bcrypt_hash [rounds]` | Prompt for a password (hidden, confirmed) and print its bcrypt hash (default cost 12); verifies round-trip before printing |
| `encrypt <file\|dir>` | Encrypt a file or all files in a directory |
| `decrypt <file\|dir>` | Decrypt a file or all files in a directory |
| `encrypt_all` / `decrypt_all` | Operate on current directory (alias for `encrypt .` / `decrypt .`) |
| `encrypt_k3s_secret <file>` | Encrypt K8s Secret YAML (only `data`/`stringData` fields) |
| `decrypt_k3s_secret <file>` | Decrypt K8s Secret YAML |
| `encrypt_tf` / `decrypt_tf` | Encrypt/decrypt Terraform sensitive files (`secrets.tfvars`, `terraform.tfvars`, `blueprint-export.yaml`, `*.tfstate*`) |

### `bitwarden.zsh` - Bitwarden Serve API

Local REST API (`bw serve`) with a two-tier cache. Secret mappings defined
in `_BW_SECRETS` / `_BW_WRANGLER_SECRETS` arrays - single source of truth
for `load_bw`, `load_wrangler_token`, and `unset_bw_vars`.

- **`_BW_CACHE`** (5 min TTL) - per-process associative array behind
  `_bw_get`. Only helps repeated lookups *within one shell*; a new shell
  always starts empty.
- **`_BW_ENV_CACHE`** (1h TTL) - the cross-shell snapshot at
  `$XDG_RUNTIME_DIR/bw-env.zsh` that makes new tmux windows cheap. See
  [bw-serve](#bw-serve-bitwarden-cli-rest-api) for the invalidation rules.
  Values are written with zsh `${(qq)}` quoting, so quotes, newlines and
  `$(...)` round-trip literally and cannot execute when sourced.

| Function | Description |
|---|---|
| `bw_serve_start` | Unlock vault, sync, start service (systemd on Linux, nohup on macOS), wait for API |
| `bw_serve_stop` | Stop service, clear session file and cache |
| `bw_serve_status` | Check if API is reachable, show service status/logs |
| `bw_serve_sync` | Sync vault from Bitwarden server, clear local cache |
| `clear_bw_cache` | Flush the in-process cache and drop the cross-shell snapshot |
| `load_bw` | Sync, export personal secrets (Cloudflare, AWS, Authentik, SOPS Age keys, etc.), then write the cross-shell snapshot |
| `load_wrangler_token` | Export Cloudflare Wrangler API token |
| `load_sops_age_keys` | Export the current SOPS Age keypair (key 2) into `SOPS_AGE_KEYS` |
| `unset_bw_vars` | Wipe all Bitwarden-loaded env vars from current shell |

### `terraform.zsh` - Terraform / OpenTofu

#### `tf_out` - output accessor

Generic, project-agnostic accessor for `tofu output` / `terraform output`.
Auto-detects the IaC tool. Supports fuzzy name matching, nested key
extraction, clipboard copy, env export, fzf interactive picker, and
category-based grouping.

Output JSON is cached per-project (TTL: 5 min, configurable via
`_TF_CACHE_TTL`). Cache files are `chmod 600` inside a `700` directory under
`$XDG_RUNTIME_DIR`, cleaned up on shell exit via `zshexit` hook.

```sh
# Browse & extract
tf_out                              # grouped, color-coded summary
tf_out <name>                       # show single output with metadata
tf_out <name> <key>                 # extract key from object output
tf_out <name> <key.subkey>          # dot-path nested extraction

# Interactive
tf_out -i  | --pick                 # fzf picker with preview and ctrl-y copy

# Listing & filtering
tf_out -l  | --list                 # output names only
tf_out -s  | --sensitive            # sensitivity & type matrix
tf_out -f  | --search <pattern>     # regex search output names
tf_out -y  | --type <type>          # filter by value type
tf_out -n  | --count                # count outputs by type and sensitivity
tf_out -T  | --tokens               # API token outputs only
tf_out -S  | --s3                   # S3 credential outputs only

# Data formats
tf_out -j  | --json [name]          # full JSON (all or single output)
tf_out -r  | --raw <name> [key]     # raw value for piping (no labels)
tf_out -t  | --table <name>         # object as aligned key=value table
tf_out -k  | --keys <name>          # list keys of an object output

# Actions
tf_out -c  | --copy <name> [key]    # copy to clipboard (wl-copy/xclip/pbcopy)
tf_out -e  | --env <name> [PREFIX]  # export object keys as env vars
tf_out -d  | --diff <name>          # diff vs last state backup

# Cache
tf_out -F  | --flush                # clear cache for current project
```

**Tab completion** (works with fzf-tab):
- `tf_out <TAB>` - output names with type/sensitivity
- `tf_out -<TAB>` - flags with descriptions
- `tf_out <name> <TAB>` - object keys
- Preview pane shows metadata; sensitive values redacted

#### Other Terraform helpers

| Function | Description |
|---|---|
| `tf_debug_on` / `tf_debug_off` / `tf_debug_toggle` | Toggle `TF_LOG=debug` |
| `cf_permissions <tf\|tofu> <category>` | Query Cloudflare permission groups via console (`account`, `zone`, `user`, `r2`, `roles`, `all`) |

### `misc.zsh` - Ansible, tmux, utilities

| Function | Description |
|---|---|
| `ansible_on` / `ansible_off` / `ansible_update` | Ansible playbook shortcuts (`$ANSIBLE_PLAYBOOK_DIR`, default: `~/my-playbooks`) |
| `tx_switch [name]` | Create and switch to a tmux session |
| `yy` | Open yazi file manager; cd into its last directory on exit |
| `p10k_colours` | Print all 256 terminal colors |
| `time_now` | ISO 8601 timestamp with milliseconds (cross-platform) |

### `packages.zsh` - Multi-OS package management

Three-phase hierarchical install: system → ecosystems → standalone.
Auto-detects platform. Supports per-phase and per-ecosystem targeting.

| Function | Description |
|---|---|
| `install_packages [phase]` | Install packages (`all`, `system`, `ecosystem`, `standalone`, or single: `npm`/`go`/`cargo`/`pip`/`deno`) |
| `save_packages [phase]` | Snapshot installed packages to lists (`all`, `system`, `ecosystem`) |
| `diff_packages` | Show drift: installed-not-in-list (+), in-list-not-installed (-) |

---

## `.stow-local-ignore`

Files and directories excluded from symlinking into `~`:

- `.git` - prevents `~/.git` symlink (would make `~` look like a repo)
- `README.md`, legacy package lists (`brew_packages_list.txt`, `pacman_list.txt`, `yay_list.txt`)
- `packages/`, `tests/` - data/test files, not dotfiles
- `.config/nvim` - managed in a [separate repo](https://github.com/erfianugrah/kickstart.nvim)

## Branches

| Branch | Purpose |
|---|---|
| `main` | Primary config (Arch WSL2) |
| `deck` | Steam Deck deployment |
| `macos` | macOS deployment |
| `vyos` | VyOS router config |

All platform branches track `main` - divergence is handled by the
cross-platform detection in `system.zsh` rather than branch differences.

## Testing

Docker-based test matrix covering all three platforms:

```sh
./tests/run-all.sh               # run all platforms
./tests/run-all.sh arch          # single platform
./tests/run-all.sh steamos macos # subset
```

| Test | Base image | What it tests |
|---|---|---|
| `arch` | `archlinux:latest` | Full system + ecosystem install, all binaries, crypto, security, config |
| `steamos` | `archlinux:latest` + Nix | Steam Deck detection, nix home-manager switch, all nix packages |
| `macos` | `ubuntu:24.04` + Linuxbrew | Brew dispatch, tap handling, list validation, crypto, config |

Arch test caches system packages in a Docker layer - rebuilds only re-run
ecosystem installs unless `packages/arch-repo.txt` changes.

## Coding agents (pi.dev primary; Claude Code for work)

pi.dev (Earendil Works) is the primary harness - it owns the daily-driver
TUI, extension model, skills loader, and sessions. Claude Code is the work
harness, wired to a curated subset of the same skills tree via per-skill
symlinks (see AGENTS.md "Agent-surface routing"). opencode (the earlier
custom fork at `~/opencode`) was RETIRED 2026-08-15: its `.config/opencode/`
tree is deleted from this repo - git history is the archive.

**Claude Code install**: on Arch it's the AUR `claude-code` package
(`packages/arch-aur.txt`) - `/opt/claude-code/bin/claude` + a `/usr/bin/claude`
wrapper that sets `DISABLE_UPDATES=1`, so updates flow only through
`paru -Syu`. NOT npm-global: 2.1.242+ native binaries segfault at startup on
ERFI1 (WSL2, 5090 - not the missing-AVX bug class), so the AUR pin at 2.1.241
is deliberate; smoke-test new releases before bumping (see arch-aur.txt). On
macOS use the native installer (`curl -fsSL https://claude.ai/install.sh | bash`).

### Shared surface

The tool-routing rules live once at `.pi/agent/prompts/tool-routing.md`
(canonical since 2026-08-15, shipped in the pi package). Skills were
relocated to be pi-canonical on 2026-05-27: the source of truth is
`.pi/agent/skills/`.

Result: any skill added or AGENTS rule edited applies to pi on the next
launch; Claude Code gets it only via deliberate per-skill promotion.

### Tool routing (the policy layer)

- **pi** - `.pi/agent/extensions/tool-routing.ts` reads
  `~/.pi/agent/prompts/tool-routing.md` (everything above the
  `tool-routing:end` marker; resolves self-relative to its own module
  path so pi-package checkouts loaded in place work too) and prepends it
  via the `before_agent_start` hook (re-runs every user prompt, so
  post-compaction re-injection is automatic).

The routing rules cover: search-family reformulation loop, web research
escalation (Exa <-> research SearXNG bidirectional on 0-results, fetch ->
crawler Playwright), docs.erfi.io
pipeline (search -> summary -> read), LSP for code intel, subagent
delegation (incl. the no-further-delegation rule for leaf research
subagents), memory + session_search, bash discipline (no `find`, sd /
ast-grep for large edits, lockfile guards).

### Skills (`.pi/agent/skills/`)

Harness audit 2026-05-25 disabled the superpowers methodology gates; the
superpowers tree was fully removed 2026-08-16. The six surviving skills
(`writing-plans`, `writing-skills`, `subagent-driven-development`,
`systematic-debugging`, `verification-before-completion`,
`requesting-code-review`) are now first-class top-level skills - vendored,
locally curated, no upstream sync. TDD lives in the global agent rules, not
a skill. `writing-specs` (added the same day) is the spec-driven-design
artifact upstream of `writing-plans`: EARS acceptance criteria with
requirement IDs that flow into plan tasks and loop sensors.

**Scaffolding + process** (the orchestrators):

| Skill | Purpose |
|---|---|
| `scaffold-new-project` | Triggers on "start / build / scaffold a new X" - routes to the relevant concrete-tech skills below, asks at most 3 batched questions, produces project skeleton + repo-level AGENTS.md cross-referencing user-level skills. **No design doc, no plan doc** - just code with conventions baked in |
| `software-architecture` | Backend/system design - DDD bounded contexts, interface-driven deps, REST+WS surface with correlation IDs, Postgres+Valkey persistence (with the user's signature flat-single-binary go:embed full-stack Go pattern documented), slog+Prometheus observability |
| methodology skills | `writing-specs` / `writing-plans` / `writing-skills` / `subagent-driven-development` / `systematic-debugging` / `verification-before-completion` / `requesting-code-review` - explicit-ask-only process skills, vendored from the superpowers cut + our own additions. See `.pi/agent/README.md` for the three-layer taxonomy |
| `sa-pov` | Solutions-Architect PoV / PoC methodology - scope + negotiate success criteria, validate each live (not from docs), solution runbook with real evidence, package for the customer |
| `open-ended-research` | Research METHOD for set-of-candidates questions (shopping, vendors, locations, visas) - breadth-first longlist, eliminate-don't-select, adversarial pass, per-cell provenance matrix, widen-on-pushback; curator-hunt query family + research-subagent prompt rules (no further delegation) |
| `self-correcting-loop` | Unattended sensor-gated agent loop - runs a fresh `pi -p` per iteration until computational + inferential sensors (build / test / judge / visual) pass. Governor: wall-clock budgets per sensor + per agent (process-group kill, so a hang can't stall a run), optional `systemd-run` cgroup limits, git checkpoint/rollback, write-scope fence, bwrap jail, model-escalation ladder. Steering: `rules` + `guide` hot-reloaded from the manifest between iterations, and `--trial` verdicts the *harness* before you spend the budget. `judge --adversarial N` runs N independent reviewers (any reject = fail) |
| `epistemics` | Answering-from-memory discipline - the provenance test, cheapest-verifier routing table per claim type, the four claim labels, calibrate-do-not-hedge, and the hold-ground-under-pushback protocol. Third leg beside `verification-before-completion` (own work) and `validating-empirically` (external runtime behaviour); companion to the `epistemic-guard` extension |
| `abuse-operations` | Anti-abuse / fraud-detection system design - risk scoring, indicator design, actor / campaign tracking, false-positive handling |
| `validating-empirically` | Probe load-bearing claims about EXTERNAL systems on throwaway infra before asserting them - doc-reads are not runtime verification. Sibling to `epistemics` (recalled specifics) and `verification-before-completion` (own work) |
| `git-worktrees` | Worktrees as the default for parallel agent work (loops, concurrent sessions) - concurrency-safety argument, `.worktrees/<task>` convention |
| `relocating-repos` | Move/rename/consolidate repos safely - pre-move entanglement survey, cross-tree reference sweep, post-move verification |

**Frontend + UI**:

| Skill | Purpose |
|---|---|
| `frontend-stack` | Astro 6 / React (tsrouter) / Next.js with biome / shadcn v4 / Tailwind v4 / zod v4 / tanstack-form+query+router - includes embedded-into-Go-binary Astro pattern for full-stack Go |
| `design-utilitarian` | McMaster-Carr visual + interaction ethos for ANY web UI work - info density, tables over cards, no animation tax, two-color palette, no marketing prose in product surfaces |
| `mermaid-d2` | Diagram language picker + render via `render_diagram` tool |
| `favicons-and-icons` | SVG-first or ComfyUI-raster to `build_favicon_set` to full PWA favicon set |

**Writing + docs**:

| Skill | Purpose |
|---|---|
| `erfi-voice` | Draft replies / emails / reviews / PR comments in Erfi's voice with verifiable references |
| `paste-formatting` | Get Markdown prose into WYSIWYG (Gmail / Docs / Notion) or chat (Slack / Discord / Telegram) targets intact via `mdclip` |
| `quarto` | Quarto documents + projects - multi-format output (HTML / PDF / Revealjs / Typst), freeze/cache, and reveal.js deck building |
| `deck-screenshot` | Screenshot or contact-sheet a reveal.js / Quarto deck to view + visually verify it inside a session |
| `writing-structure` | Long-form structure (headings, paragraph order, thesis placement) + citation conventions (Source lines, APA 7, RFC-style [TAG]) |
| `lexicanum` | Authoring/restructuring docs on the lexicanum site (~/lexicanum, erfi.dev) - taxonomy frontmatter, guide vs reference, IEEE-footnote citations |

**Infrastructure + deploy**:

| Skill | Purpose |
|---|---|
| `infrastructure-stack` | Self-hosted Docker Compose stacks - bridge networks + static IPs, expose-not-ports, host-mode Caddy, PUID/PGID, cross-stack shared networks |
| `composer` | Self-hosted Docker Compose mgmt platform at composer.servarr.erfi.io - ~109-endpoint REST API, auth, pipeline footguns, release workflow |
| `docker` | Dockerfile authoring, buildx multi-arch + cache, image inspection, registry workflows, BuildKit cache mounts / secrets / SSH |
| `fly` | Fly.io app lifecycle - deploy, secrets, certs, machines, volumes, scale + auto-stop, .internal DNS |
| `terraform` | OpenTofu (preferred) / Terraform - module structure, state backends, SOPS+age secrets, `terraform import` + `cf-terraforming` for adopting existing resources |
| `cloudflare` | CF API + wrangler + bulk Python automation - zones / DNS / rulesets / Workers / R2 / Pages / Zero Trust |
| `knot-dns` | Self-hosted authoritative DNS - Knot 3.5 on Fly anycast, TSIG-keyed RFC 2136 ACME for Caddy, AXFR/IXFR primary↔secondary, the CF → Knot migration path with all the documented-IPs-are-wrong gotchas |
| `ci-workflows` | GitHub + Gitea Actions YAML - verified-current action pins, language setup, Docker build+push, pages deploy |
| `gh` | gh CLI ops: PR/issue/release lifecycle, Actions runs + cache, repo + auth, gh extensions - token-efficient `--json` + `--jq` patterns |
| `gh-search` | Cross-repo GitHub code/issue/PR search via `gh` CLI |
| `caddy` | Custom Caddy build + WAF stack at `~/infra/ergo/caddy-compose` - xcaddy plugin set, snippet idiom, wafctl dashboard, TSIG/rfc2136 chain to Knot |
| `knotctl` | `knotctl` CLI for live DNS edits (TSIG RFC 2136 over TCP) against the merged knotea authority |
| `gloryhole` | Self-built DNS resolver `glory-hole` (Go + embedded Unbound + loopback knotd + dashboard); also authoritative NS for the zones post-cutover |
| `tailscale-homelab` | SSH into + operate the tailscale-routed homelab (servarr etc.) - per-host identity convention, subnet routing, the `ssh servarr docker ...` operator idiom |
| `compose-backups` | Automated backup sidecars for compose stacks (offen/docker-volume-backup) - restore drills, retention pruning to R2/MinIO |
| `drawbridge` | mTLS-gated route-allowlisted reverse proxy for the Docker Engine API - fronts servarr's docker.sock for composer over the tailnet |
| `eaves` | Read-only CLI for the NixOS edge router - DHCP leases, NAT, conntrack, nftables, vnstat, doctor suite, offline fixtures |
| `xikectl` | Read-only CLI for the XikeStor SKS8300 switch - VLANs, interfaces, MAC table, jumbo MTU, smoke/verify suites |
| `souin` | Edge HTTP cache on the Caddy stack (cache-handler + nuts) - cache misses, Cache-Status anomalies, purge/reclaim |
| `waf-api` | wafctl WAF management API + waf-dashboard - endpoint CRUD, event export, store-vs-deploy split, adding rule/event types end-to-end |

**Database + data**:

| Skill | Purpose |
|---|---|
| `supabase` | All Supabase products (db, auth, edge fns, storage, realtime, ssr) |
| `supabase-postgres-best-practices` | Postgres query/schema/index patterns from Supabase |
| `pg-analyser` | `pg-analyser` CLI - Postgres performance analyzer (formerly sbperf; advisors + SQL diagnostics + infra metrics) rendering self-contained HTML + PDF reports with windowed trends |
| `sbshift` | `sbshift` CLI - near-zero-downtime Postgres to Postgres migration via native logical replication |

**Local services + AI**:

| Skill | Purpose |
|---|---|
| `research` | Multi-engine search + Playwright crawler + OSINT (SearXNG :8888, crawler :8889, OSINT :8890) - includes the platform access walls (Reddit bypass order: PullPush -> redlib -> crawler), the API-driven locator pattern (near-empty render = grep raw HTML for wp-json//api//.json), and the SearXNG silent-empty -> Exa escalation |
| `comfyui` | SDXL / Illustrious / Flux image generation via llm-compose proxy |
| `lora-train` | LoRA fine-tuning for SDXL / Flux via kohya sd-scripts |
| `whisper` | WhisperX audio/video transcription (YouTube, local files) |
| `gocurl` | `gocurl` CLI - HTTP performance measurement: httptrace phase breakdown (DNS / TCP / TLS / TTFB / transfer), load testing, streaming analysis |
| `memledger` | Cross-client session store + search (pi + opencode + claude) beyond the 30-day local retention; ingester/prune CLI, compose stack |

**Homelab media (servarr)**:

| Skill | Purpose |
|---|---|
| `arr-stack` | The *arr pipeline on servarr (radarr / sonarr / prowlarr / bazarr + sabnzbd / qbittorrent / flaresolverr), TRaSH guides, quality profiles |
| `jellyfin` | Media-consumer stack on servarr - Jellyfin + Jellyseerr + Navidrome, NVENC transcoding on the GTX 1070 |
| `discord-wipe` | Delete the user's own Discord messages (guild/DM purge, rolling retention) via the discord-wipe-go daemon on servarr |

**Diagnostics**:

| Skill | Purpose |
|---|---|
| `git-troubleshooting` | Diagnostic battery for `git mv` / `git add` / pathspec failures - gitignore-first hypothesis, the symptom → cause table, recovery patterns |
| `powershell` | Run/write pwsh locally or on Windows machines over SSH - Get-WinEvent / Get-CimInstance patterns, PSRemoting, the `powershell` tool |

### pi extensions (`.pi/agent/extensions/`)

Custom TypeScript plugins that register tools, gates, TUI behaviour, and
background jobs. Some are direct ports of opencode fork built-ins; others
are pi-only because pi's extension API supports things opencode's plugin
API doesn't (mid-turn tool-call gating, custom footer rendering, sync
DB access, session lifecycle hooks).

**Tools** (called by the LLM):

| Extension | Provides |
|---|---|
| `docs.ts` (symlink) | docs.erfi.io SSH tools: `docs_search` / `read` / `grep` / `find` / `summary` / `sources` |
| `opendata.ts` | `dataset_search` / `dataset_fetch` - official open-data portals (data.gov.sg) via crawler `/dataset/*`; fetch writes a FILE, rows never enter context |
| `bash-error-hints.ts` | Decorates bash tool results with one-line hints when stderr matches a known footgun (gitignore traps, pathspec mismatch, mv ENOENT, permission denied, Anthropic stream cutoff) - the agent sees actionable next-probe text appended to the error, no context cost when no pattern fires |
| `exa.ts` | `websearch` + `codesearch` via mcp.exa.ai |
| `webfetch.ts` | URL → markdown / text / html (5MB cap, Cloudflare retry) |
| `web-research.ts` | Exa + auto-fetch top results + optional SearXNG cross-check; eliminates snippet-only reasoning |
| `oci-tags.ts` | Docker Hub / ghcr.io / quay.io tag query (no stale registry data) |
| `context7.ts` | Library docs via context7.com MCP |
| `session-search.ts` | Full-text search across past pi sessions - FTS5 fast path, ripgrep fallback for unindexed files |
| `glob.ts` | `**/*.ts`-style file pattern lookup, mtime-sorted |
| `grep.ts` | Ripgrep regex content search with `include` glob filter |
| `render-diagram.ts` | mermaid + d2 render via local `mmdc` / `d2` CLI |
| `build-favicon-set.ts` | SVG/PNG → favicon.ico + apple-touch + 192/512/maskable + manifest + HTML snippet |
| `apply-patch.ts` | Multi-file Add/Update/Delete patch envelope, atomic |
| `task.ts` | Subagent delegation (fresh context) |
| `memory.ts` | Persistent cross-session memory |
| `todowrite.ts` | Session todo list |
| `lsp/` | LSP integration (multi-language: ts, rust, py, go, lua, clangd) |
| `write-stream.ts` | Chunked atomic file writes for content above the tool-call-input size ceiling (`first` / `middle` / `last`) |
| `pdf.ts` | Diagnostic-first PDF extraction: born-digital to `pdftotext`, scanned to `tesseract` OCR, plus tables + visual rasterize modes |
| `osint.ts` | OSINT tools (domain / IP / email / username / phone / URL / threat / CVE / harvest) via the research FastAPI service |
| `bench.ts` | Statistical command benchmarking via `hyperfine` (mean / stddev / winner) |
| `go-test.ts` | `go test -json` wrapper - failures-only triage |
| `hurl-test.ts` | Run a `.hurl` file, return only failing entries |
| `osv-scan.ts` | `osv-scanner` wrapper - one flattened line per vuln |
| `secret-scan.ts` | `gitleaks` / `noseyparker` wrapper - secret values truncated out of context |
| `video-review.ts` | Transcribe + diarize a video, overlap / metrics analysis, evidence bundle (whisper stack) |
| `pg-analyser.pi.ts` | Drive the `pg-analyser` Postgres performance analyzer as a single tool |
| `session-ledger/` | Cross-session work ledger - queryable structured summaries of past sessions (`ledger_search` / `ledger_sql`) |
| `yank.ts` | Copy a code block from the last assistant message to the system clipboard |

**Gates + safety** (intercept tool calls):

| Extension | Provides |
|---|---|
| `tool-guard.ts` | ~30 rules blocking bash + write anti-patterns (incl. docs-first chain + oversized-`write` -> `write_stream`): npm-when-bun, `sed -i` on source files, `:latest` docker images, unsigned commits, hallucinated CLIs (`bun create @tanstack/router`), `\uXXXX` escapes in bash strings, `chmod 777`, force-push to main, edits on `.env` / lockfiles / `node_modules` / `.git` internals. Also a reformulation-loop guard that blocks the 4th consecutive search-family call when no drill-in tool fired between |
| `git-gh-gate.ts` | Confirmation modal before mutating git/gh commands (truncates display body to avoid long-session scroll cascade) |
| `ascii-punctuation-guard.ts` | Blocks mojibake-prone smart punctuation (em/en dash, smart quotes, ellipsis) in write / edit / apply_patch / commit payloads - keeps committed + pasted text ASCII |
| `confidential-write-guard.ts` | Nudges once per repo before persisting prose to a remote-backed repo; hard-blocks user-confirmed confidential third-party identifiers |
| `epistemic-guard.ts` | Provenance gate for the specifics the model emits. Builds a corpus of every literal seen in tool results / user messages / system prompt, then blocks writes, commits and PR bodies carrying a version, flag, system path, deep URL, CVE, perf number or date with NO provenance this session (once per specific - verifying it silences it for good). A perf number sitting in a because-clause is marked `derived` and routed to "name the mechanism and a precondition" instead of "go verify the literal", because a number you reasoned to is a recalled RULE applied without checking that it applies. Annotates interactive answers with a `recalled, not verified` footer; no footer and a block budget under `pi -p` so subagent payloads and loop iterations are not corrupted or taxed. `/epistemics` reports state. Kill switches: `PI_EPISTEMIC_GUARD_OFF=1`, `PI_EPISTEMIC_FOOTER_OFF=1`, `PI_EPISTEMIC_MAX_BLOCKS=0` |
| `lookup-before-ask.ts` | Nudges once per session when the assistant asks the user for a fact about their OWN infrastructure - a measurement, spec, part number, date or past decision - with no `memledger_search` / `search_ledger` / `session_search` call this session. Those stores are pull-only, so nothing fires them when the AGENT has the gap; the cheap alternatives are asking (spends the user's turn on something already recorded) or recalling (fabricates the specific). Any lookup call disarms it. Signals are ANDed per SENTENCE, not per message. Kill switch: `PI_LOOKUP_NUDGE_OFF=1` |
| `entity-qualifier-nudge.ts` | Nudges when a device identifier (`eth0`, `enp2s0f0np0`, `br0`, `nvme0n1`, switch ports) is cited as EVIDENCE with no host named. `eth0` is not unique across boxes, so a real fact about one interface silently becomes an argument about a different one; writing "servarr's eth0" is the moment the mismatch shows. A date does not qualify - "eth0 flapped on 2026-08-08" says when, not which box. Kill switch: `PI_ENTITY_NUDGE_OFF=1` |
| `skill-guard.ts` | Actively routes to a matching skill the model would otherwise skip: intent nudge on the prompt (`before_agent_start`) + block-once on skill-relevant file edits / commands (`tool_call`). Companion to the passive skill-description layer |
| `slash-typo-guard.ts` | Catches typo'd slash commands before they reach the LLM |
| `cd-agents-reload.ts` | Warns when you `cd` into a repo whose `AGENTS.md` was not loaded at session start |

**Prompt + policy layer:**

| Extension | Provides |
|---|---|
| `tool-routing.ts` | Prepends `prompts/tool-routing.md` (above the `tool-routing:end` marker; legacy-path fallback) with CRITICAL framing on every user prompt |
| `local-model-rules.ts` | Per-model rules for gemma / qwen / llama-server |
| `style-toggle.ts` | Per-session output-style switcher |

**Session lifecycle + UX:**

| Extension | Provides |
|---|---|
| `atuin.ts` | Tracks pi's bash calls in Atuin history (author `pi`) via tool_call/tool_execution_end events |
| `custom-footer.ts` (**disabled**) | Retired to `custom-footer.ts.disabled` - pi's built-in footer now covers cost/tokens/context. Kept for reference: cumulative cost + per-turn delta, true input tokens (sums `input + cacheRead + cacheWrite`), width-aware right-side field drop, NaN-guarded accumulators (pi#4158), status aggregation |
| `session-auto-title.ts` | Auto-generates a 3-6 word session title from the first user message via a small cheap model. Model picker reads `~/.pi/agent/models.json`, scores every configured `provider/id` pair by (provider weight + name pattern weight) - local llama-server / ollama / lmstudio first, then haiku / mini / nano patterns, then gemma / qwen3-4 / phi / llama-3-small patterns. First with valid auth wins. Falls back to current session model only if nothing else has auth. Records a marker so it runs once per session and respects manual `/session-name` overrides |
| `session-summary.ts` | On `startup` / `new` session_start, injects a project briefing: branch + ahead/behind, working-tree status counts, last 3 commits, up to 3 open PRs. Hard 1.5s budget; silent outside git working trees |
| `session-fts/` | Background SQLite FTS5 indexer for `~/.pi/agent/sessions/`. Two files: `index.ts` (main-thread façade - spawns worker, owns read-only DB handle for `searchFts()` + `indexStats()`) and `worker.ts` (Bun Worker - owns writer-side DB, runs all synchronous SQLite churn off the main event loop). On a 1.3GB index every INSERT costs ~3ms because FTS5 has to update its inverted index; 100 files × ~150 rows = ~45s of unyielding work that previously caused visible typing lag at every session_start. Worker thread eliminates that. WAL mode allows concurrent reader+writer. 100 newest-first files per startup, 5s startup delay, single-flight guard prevents stacked requests. `/session-index status \| rebuild \| gc` |
| `compaction-progress.ts` | Live spinner + token-before/after toast during /compact |
| `tool-output-prune.ts` | opencode-style surgical pruning of oversized tool outputs to preserve context |
| `compaction-model.ts` | Runs pi's compaction summarizer on a cheaper / faster model |
| `continue-after-error.ts` | Recovery affordance for provider 401 / 402 / 429 - resume instead of ending the run |
| `clipboard-image-shrink.ts` | Auto-downscales pasted clipboard images before they reach the model |
| `bookmark.ts`, `migrate-sessions.ts`, `notify.ts`, `question.ts`, `session-name.ts`, `session-undo.ts`, `trigger-compact.ts`, `inline-bash.ts` | Smaller utilities (`/undo`, bookmarks, desktop notify, prompts, session naming, threshold compaction, `!{cmd}` inline bash) |

Two extensions are parked as `.disabled`: `custom-footer.ts` (superseded by pi's built-in footer) and `stuck-state-recovery.ts`.

### Why pi.dev (and why the shared surface matters)

pi.dev is the current daily driver: a richer extension API
(`before_agent_start`, `tool_call` / `tool_result` gating, custom tool
rendering), larger TUI primitives (modals, widgets, status slots), a `task` /
subagent system, and the extension surface documented above. opencode (the
earlier fork, with its `output-rules.ts` plugin pattern and builtin Exa /
codesearch / context7) was retired 2026-08-15. Claude Code gets a curated
subset: symlink individual skills into
`~/.claude/skills/` (whole-dir symlink would clobber the existing Cloudflare
skill set there; a tracked `dotfiles/.claude/skills/<name>` ->
`../../.pi/agent/skills/<name>` per-skill symlink stows cleanly alongside
them). A user-level `~/.claude/CLAUDE.md` carries the universal rules.

## Other tools

### `bin/caddyfmt`

Minimal Caddyfile formatter (Python 3, stdin/stdout). Replicates `caddy fmt`:
normalizes indentation, handles Caddy placeholders (`{$ENV}`,
`{http.request.uri}`), strips trailing whitespace.

```sh
caddyfmt < Caddyfile > Caddyfile.formatted
```

### `wezterm.sh`

WezTerm shell integration (sourced by `.zshrc`). Sets up:
- OSC 7: report current working directory to terminal
- OSC 133: semantic prompt zones (command input vs output)
- User vars for WezTerm's Lua API
