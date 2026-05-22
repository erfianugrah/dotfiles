# dotfiles

Cross-platform dotfiles managed with [GNU Stow](https://www.gnu.org/software/stow/).
Targets Arch Linux (native + WSL2), macOS, and Steam Deck (SteamOS via Nix).

## Repository layout

```
.zshrc                         # main shell config (zinit, plugins, aliases, PATH)
.p10k.zsh                      # Powerlevel10k theme (lean 8-color, 1-line)
.tmux.conf                     # tmux config (TPM, tokyo-night, vim-navigator)
.wezterm.lua                   # WezTerm terminal (workspaces, splits, WSL)
.gitconfig                     # Git (GPG signing, delta pager, diff3 merge)
.vimrc                         # minimal vim (numbers, syntax, mouse)
.ssh/config                    # SSH hosts (Cloudflare Tunnel, Proxmox, TuringPi, etc.)

functions.zsh                  # modular loader — sources functions.d/*
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
  superpowers-sync             # sync obra/superpowers skills/ into .config/opencode/skills/superpowers/
                               # → see .config/opencode/skills/superpowers/.sync.json for ref/sha/timestamp
                               # → opencode fork (erfianugrah/opencode) has built-in conditional injection
                               # → run with --status, --check, --ref <tag|sha>, --main, or --help

.config/
  atuin/config.toml            # Atuin shell history (self-hosted sync)
  systemd/user/bw-serve.service  # Bitwarden CLI REST API service
  opencode/                    # opencode AI coding agent (custom fork)
    AGENTS.md                  # shared agent context (linked from .pi/agent/)
    opencode.json              # MCP servers (context7, gh-grep, whisper, comfyui, lora-train, research)
    plugins/output-rules.ts    # prepends AGENTS.md output rules to system prompt
    tools/docs.ts              # docs.erfi.io SSH tool (docs_search/read/grep/find/summary/sources)
    skills/                    # 11 skills (see Coding-agents section)

.pi/agent/                     # pi AI coding agent (sibling to opencode)
  APPEND_SYSTEM.md             # appended to system prompt: Commit/PR + Safety only
  prompts/                     # markdown sources loaded by extensions
    tool-routing.md            #   prepended via before_agent_start with CRITICAL framing
    local-model-rules.md       #   prepended only for gemma/qwen/llama-server models
    commit.md, pr.md, review.md, test.md, init.md
  extensions/                  # TypeScript plugins
    tool-routing.ts            #   inject tool-routing.md as system prompt prefix
    exa.ts, webfetch.ts, oci-tags.ts, web-research.ts
    docs.ts (symlinked from opencode/tools/), context7.ts, session-search.ts
    memory.ts, todowrite.ts, task.ts, question.ts
    git-gh-gate.ts, superpowers.ts, local-model-rules.ts, lsp/
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

SteamOS is immutable — `pacman` installs get wiped on OS updates. Nix
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
terminal/tmux restarts. After a reboot, run `bw_serve_start` again.

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
| `ls` | `eza` | guarded — falls back if eza missing |
| `cat` | `bat` | guarded — falls back if bat missing |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `EDITOR` | `nvim` → `vim` → `nano` → `code` | first available; `bindkey -e` after to keep standard keybindings (zsh auto-enables vi mode when EDITOR contains `vi`/`nvim`) |
| `DOCKER_BUILDKIT` | `1` | always on |
| `LANG` / `LC_ALL` | `C.UTF-8` | |
| `ANSIBLE_PLAYBOOK_DIR` | `~/my-playbooks` | used by `ansible_on/off/update` |
| `BW_SERVE_PORT` | `8087` | Bitwarden serve port |
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
- **Leader key:** `Ctrl-A` (same as tmux prefix — WezTerm handles workspaces,
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
  `*.vyos.erfianugrah.com` — uses `cloudflared access ssh` as ProxyCommand
- **Self-hosted services:** `docs.erfi.io` (port 2222), `git.erfi.io` (port
  2223, Gitea)
- **Infrastructure:** Proxmox, VyOS routers, TuringPi cluster (rock1-4),
  servarr, KVMs
- **Tailscale mesh:** hosts accessible via `*.manticore-diatonic.ts.net`
- **Cloud:** GCP instances, Steam Deck

Global defaults (`Host *`):
- `ServerAliveInterval 60` — keepalive every 60s
- `IdentitiesOnly yes` — only offer configured keys (no agent key spray)
- `AddKeysToAgent yes` — auto-add keys on first use
- `HashKnownHosts yes` — privacy for known_hosts

### Pre-commit hook (`.git-template/hooks/pre-commit`)

Global Git hook (applied to all repos via `init.templateDir`). Blocks
committing unencrypted sensitive files:

- **Always checked:** `.env`, `.tfvars`, `.tfstate` — must be SOPS/Age
  encrypted
- **Content-scanned:** `.yaml`, `.yml`, `.json` — flagged only if they contain
  secret-like patterns (`password`, `secret`, `token`, `api_key`, etc.)
- **`.sops.yaml` integration:** files matching `path_regex` creation rules are
  checked for SOPS encryption
- **Escape hatches:**
  - `touch .allow-unencrypted` — skip all checks for this repo
  - `.allow-unencrypted-paths` — one glob pattern per line to skip specific
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

### `system.zsh` — System maintenance

OS-aware — detects platform and package manager at source time
(`apt`, `dnf`, `pacman`, `zypper`, `brew`). Also picks up Flatpak and Snap.

| Function | Description |
|---|---|
| `update_all` / `upall` | Update all detected package managers (apt, dnf, pacman + AUR, zypper, brew, flatpak, snap) |
| `fix_file_limits` / `fixfiles` | Inspect and optionally raise file descriptor limits (Linux: `limits.conf` + sysctl, macOS: `launchctl` + LaunchDaemon) |

### `crypto.zsh` — SOPS / Age encryption

Encrypt and decrypt files in-place using SOPS with Age keys. Requires
`SOPS_AGE_KEYS` to be set (use `load_sops_age_keys` or `load_bw`).

Private keys are never exported to the environment — passed inline to sops
commands via `SOPS_AGE_KEY="$key" sops ...` so they exist only for the
duration of each command.

| Function | Description |
|---|---|
| `encrypt <file\|dir>` | Encrypt a file or all files in a directory |
| `decrypt <file\|dir>` | Decrypt a file or all files in a directory |
| `encrypt_all` / `decrypt_all` | Operate on current directory (alias for `encrypt .` / `decrypt .`) |
| `encrypt_k3s_secret <file>` | Encrypt K8s Secret YAML (only `data`/`stringData` fields) |
| `decrypt_k3s_secret <file>` | Decrypt K8s Secret YAML |
| `encrypt_tf` / `decrypt_tf` | Encrypt/decrypt Terraform sensitive files (`secrets.tfvars`, `terraform.tfvars`, `blueprint-export.yaml`, `*.tfstate*`) |

### `bitwarden.zsh` — Bitwarden Serve API

Local REST API (`bw serve`) with in-memory cache (5 min TTL). Secret
mappings defined in `_BW_SECRETS` / `_BW_WRANGLER_SECRETS` arrays — single
source of truth for `load_bw`, `load_wrangler_token`, and `unset_bw_vars`.

| Function | Description |
|---|---|
| `bw_serve_start` | Unlock vault, sync, start service (systemd on Linux, nohup on macOS), wait for API |
| `bw_serve_stop` | Stop service, clear session file and cache |
| `bw_serve_status` | Check if API is reachable, show service status/logs |
| `bw_serve_sync` | Sync vault from Bitwarden server, clear local cache |
| `clear_bw_cache` | Flush in-memory key-value cache |
| `load_bw` | Export personal secrets (Cloudflare, AWS, Authentik, SOPS Age keys, etc.) |
| `load_wrangler_token` | Export Cloudflare Wrangler API token |
| `load_sops_age_keys` | Export SOPS Age public + secret key into `SOPS_AGE_KEYS` |
| `unset_bw_vars` | Wipe all Bitwarden-loaded env vars from current shell |

### `terraform.zsh` — Terraform / OpenTofu

#### `tf_out` — output accessor

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
- `tf_out <TAB>` — output names with type/sensitivity
- `tf_out -<TAB>` — flags with descriptions
- `tf_out <name> <TAB>` — object keys
- Preview pane shows metadata; sensitive values redacted

#### Other Terraform helpers

| Function | Description |
|---|---|
| `tf_debug_on` / `tf_debug_off` / `tf_debug_toggle` | Toggle `TF_LOG=debug` |
| `cf_permissions <tf\|tofu> <category>` | Query Cloudflare permission groups via console (`account`, `zone`, `user`, `r2`, `roles`, `all`) |

### `misc.zsh` — Ansible, tmux, utilities

| Function | Description |
|---|---|
| `ansible_on` / `ansible_off` / `ansible_update` | Ansible playbook shortcuts (`$ANSIBLE_PLAYBOOK_DIR`, default: `~/my-playbooks`) |
| `tx_switch [name]` | Create and switch to a tmux session |
| `yy` | Open yazi file manager; cd into its last directory on exit |
| `p10k_colours` | Print all 256 terminal colors |
| `time_now` | ISO 8601 timestamp with milliseconds (cross-platform) |

### `packages.zsh` — Multi-OS package management

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

- `.git` — prevents `~/.git` symlink (would make `~` look like a repo)
- `README.md`, legacy package lists (`brew_packages_list.txt`, `pacman_list.txt`, `yay_list.txt`)
- `packages/`, `tests/` — data/test files, not dotfiles
- `.config/nvim` — managed in a [separate repo](https://github.com/erfianugrah/kickstart.nvim)
- `.config/opencode/node_modules`, lock files

## Branches

| Branch | Purpose |
|---|---|
| `main` | Primary config (Arch WSL2) |
| `deck` | Steam Deck deployment |
| `macos` | macOS deployment |
| `vyos` | VyOS router config |

All platform branches track `main` — divergence is handled by the
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

Arch test caches system packages in a Docker layer — rebuilds only re-run
ecosystem installs unless `packages/arch-repo.txt` changes.

## Coding agents (opencode + pi)

Two AI coding agents are configured side-by-side and share a single skills /
AGENTS.md surface so behaviour stays consistent across both. opencode is the
primary daily driver (a custom fork at `~/opencode`); pi is the secondary
harness for sessions where its TUI / extension model fits better.

### Shared surface

`AGENTS.md` lives once at `.config/opencode/AGENTS.md` and is symlinked from
`.pi/agent/AGENTS.md`. Skills live once at `.config/opencode/skills/` and are
linked into pi via `~/.pi/agent/skills`.

Result: any skill added or AGENTS rule edited applies to both agents on the
next launch.

### Tool routing (the policy layer)

Both agents use a *plugin-injected* policy block prepended to the system
prompt with `CRITICAL MANDATORY INSTRUCTION` framing. Same content, two
implementations:

- **opencode** — `.config/opencode/plugins/output-rules.ts` reads AGENTS.md
  and unshifts the pre-`## Documentation` section onto `output.system`.
- **pi** — `.pi/agent/extensions/tool-routing.ts` reads
  `.pi/agent/prompts/tool-routing.md` and prepends it via the
  `before_agent_start` hook (re-runs every user prompt, so post-compaction
  re-injection is automatic).

The routing rules cover: search-family reformulation loop, web research
escalation (Exa → fetch → research SearXNG / Playwright), docs.erfi.io
pipeline (search → summary → read), LSP for code intel, subagent
delegation, memory + session_search, bash discipline (no `find`, sd /
ast-grep for large edits, lockfile guards).

### Skills (`.config/opencode/skills/`)

| Skill | Purpose |
|---|---|
| `superpowers` | obra/superpowers methodology (brainstorming → plans → TDD) |
| `frontend-stack` | Scaffold Astro 6 / React (tsrouter) / Next.js with biome / shadcn v4 / Tailwind v4 / zod v4 / tanstack-form+query+router |
| `design-utilitarian` | McMaster-Carr visual + interaction ethos for ANY web UI work (info density, tables over cards, no animation tax, two-color palette, no marketing prose in product surfaces) |
| `software-architecture` | Backend/system design — bounded contexts, interface-driven deps, REST+WS surface, Postgres+Valkey persistence, slog+Prometheus observability |
| `infrastructure-stack` | Self-hosted Docker Compose stacks — bridge networks + static IPs, expose-not-ports, host-mode Caddy, PUID/PGID, cross-stack shared networks |
| `ci-workflows` | GitHub + Gitea Actions YAML — verified-current action pins, language setup, Docker build+push, pages deploy |
| `composer` | User's self-hosted Docker Compose mgmt platform at composer.erfi.io — 106-endpoint REST API, auth, pipeline footguns, release workflow |
| `supabase` | All Supabase products (db, auth, edge fns, storage, realtime, ssr) |
| `supabase-postgres-best-practices` | Postgres query/schema/index patterns from Supabase |
| `research` | Multi-engine search + Playwright crawler + OSINT (SearXNG :8888, crawler :8889, OSINT :8890) |
| `gh-search` | Public-GitHub code/issues/PRs via `gh` CLI |
| `comfyui` | SDXL / Illustrious / Flux image generation via llm-compose proxy |
| `lora-train` | LoRA fine-tuning for SDXL / Flux via kohya sd-scripts |
| `whisper` | WhisperX audio/video transcription (YouTube, local files) |
| `mermaid-d2` | Diagram language picker + render via `render_diagram` tool |
| `favicons-and-icons` | SVG-first or ComfyUI-raster → `build_favicon_set` → full PWA favicon set |

`bin/superpowers-sync` keeps `superpowers/` synced from
obra/superpowers upstream; see `.config/opencode/skills/superpowers/.sync.json`
for the pinned ref/sha. Run `--status`, `--check`, `--ref <tag|sha>`,
`--main`.

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
| `exa.ts` | `websearch` + `codesearch` via mcp.exa.ai |
| `webfetch.ts` | URL → markdown / text / html (5MB cap, Cloudflare retry) |
| `web-research.ts` | Exa + auto-fetch top results + optional SearXNG cross-check; eliminates snippet-only reasoning |
| `oci-tags.ts` | Docker Hub / ghcr.io / quay.io tag query (no stale registry data) |
| `context7.ts` | Library docs via context7.com MCP |
| `session-search.ts` | Full-text search across past pi sessions — FTS5 fast path, ripgrep fallback for unindexed files |
| `glob.ts` | `**/*.ts`-style file pattern lookup, mtime-sorted |
| `grep.ts` | Ripgrep regex content search with `include` glob filter |
| `render-diagram.ts` | mermaid + d2 render via local `mmdc` / `d2` CLI |
| `build-favicon-set.ts` | SVG/PNG → favicon.ico + apple-touch + 192/512/maskable + manifest + HTML snippet |
| `apply-patch.ts` | Multi-file Add/Update/Delete patch envelope, atomic |
| `task.ts` | Subagent delegation (fresh context) |
| `memory.ts` | Persistent cross-session memory |
| `todowrite.ts` | Session todo list |
| `lsp/` | LSP integration (multi-language: ts, rust, py, go, lua, clangd) |

**Gates + safety** (intercept tool calls):

| Extension | Provides |
|---|---|
| `tool-guard.ts` | 29 rules blocking bash + write anti-patterns: npm-when-bun, `sed -i` on source files, `:latest` docker images, unsigned commits, hallucinated CLIs (`bun create @tanstack/router`), `\uXXXX` escapes in bash strings, `chmod 777`, force-push to main, edits on `.env` / lockfiles / `node_modules` / `.git` internals. Also a reformulation-loop guard that blocks the 4th consecutive search-family call when no drill-in tool fired between |
| `git-gh-gate.ts` | Confirmation modal before mutating git/gh commands (truncates display body to avoid long-session scroll cascade) |

**Prompt + policy layer:**

| Extension | Provides |
|---|---|
| `tool-routing.ts` | Prepends `prompts/tool-routing.md` with CRITICAL framing on every user prompt |
| `local-model-rules.ts` | Per-model rules for gemma / qwen / llama-server |
| `superpowers.ts` | Conditional injection of using-superpowers/SKILL.md on build/debug intent |
| `style-toggle.ts` | Per-session output-style switcher |

**Session lifecycle + UX:**

| Extension | Provides |
|---|---|
| `custom-footer.ts` | Default-on footer: cumulative cost + per-turn delta, true input tokens (sums `input + cacheRead + cacheWrite` — the prior version of summing only `usage.input` undercounted by 6 orders of magnitude in cache-heavy sessions), context % (falls back to absolute `~Nk` when model maxTokens unknown), session name, thinking level, cwd/branch, model. Width-aware right-side drop: fields disappear front-first when terminal is narrow, model always kept. NaN-guarded accumulators (pi#4158). Aggregates `ctx.ui.setStatus()` text from other extensions as a yellow middle segment. Re-installs on session_start to survive `/new` / `/resume` / `/reload` / `/fork` |
| `session-auto-title.ts` | Auto-generates a 3-6 word session title from the first user message via a small cheap model. Model picker reads `~/.pi/agent/models.json`, scores every configured `provider/id` pair by (provider weight + name pattern weight) — local llama-server / ollama / lmstudio first, then haiku / mini / nano patterns, then gemma / qwen3-4 / phi / llama-3-small patterns. First with valid auth wins. Falls back to current session model only if nothing else has auth. Records a marker so it runs once per session and respects manual `/session-name` overrides |
| `session-summary.ts` | On `startup` / `new` session_start, injects a project briefing: branch + ahead/behind, working-tree status counts, last 3 commits, up to 3 open PRs. Hard 1.5s budget; silent outside git working trees |
| `session-fts/` | Background SQLite FTS5 indexer for `~/.pi/agent/sessions/`. Two files: `index.ts` (main-thread façade — spawns worker, owns read-only DB handle for `searchFts()` + `indexStats()`) and `worker.ts` (Bun Worker — owns writer-side DB, runs all synchronous SQLite churn off the main event loop). On a 1.3GB index every INSERT costs ~3ms because FTS5 has to update its inverted index; 100 files × ~150 rows = ~45s of unyielding work that previously caused visible typing lag at every session_start. Worker thread eliminates that. WAL mode allows concurrent reader+writer. 100 newest-first files per startup, 5s startup delay, single-flight guard prevents stacked requests. `/session-index status \| rebuild \| gc` |
| `compaction-progress.ts` | Live spinner + token-before/after toast during /compact |
| `bookmark.ts`, `migrate-sessions.ts`, `notify.ts`, `question.ts`, `session-name.ts`, `trigger-compact.ts`, `inline-bash.ts` | Smaller utilities |

### Why two agents

opencode is the daily-driver fork with better default TUI, builtin Exa /
codesearch / context7 integration, and the `output-rules.ts` plugin pattern.
pi is from a different ecosystem (Earendil Works) with a richer extension
API (`before_agent_start`, `tool_execution_*`, custom tool rendering),
larger TUI primitives (modals, widgets, status slots), and a `task` /
subagent system. Keeping both wired to the same skills + AGENTS.md means
zero ergonomic delta when switching.

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
