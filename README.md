### Setup
#### Install zsh with brew or apt or bash

## Note
Before running `stow .` on the dotfiles, make sure all binaries are installed first

### `.stow-local-ignore`
Files and directories listed in `.stow-local-ignore` are excluded from
symlinking into `~`. Notably, `.git` must be ignored — otherwise Stow
symlinks `~/.git` → `dotfiles/.git`, which makes the entire home directory
appear as a git repository (e.g. shell prompts show a branch name in `~`).

```sh
brew install zsh
sudo apt-get install zsh
sudo apt-get install stow
sh -c "$(curl -fsSL https://raw.github.com/robbyrussell/oh-my-zsh/master/tools/install.sh)"
bash -c "$(curl --fail --show-error --silent --location https://raw.githubusercontent.com/zdharma-continuum/zinit/HEAD/scripts/install.sh)"
```
#### Install powerlevel10k theme and set it as the default theme

```sh
git clone https://github.com/romkatv/powerlevel10k.git $ZSH_CUSTOM/themes/powerlevel10k
ZSH_THEME="powerlevel10k/powerlevel10k"
```
#### Install Meslo Nerd Font

Download from `https://github.com/ryanoasis/nerd-fonts/releases/download/v3.2.0/Meslo.zip`

#### Zoxide (a better cd) 

```sh
curl -sS https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | bash
```
#### Vim and Neovim setup

```sh
brew install neovim vim
git clone https://github.com/erfianugrah/kickstart.nvim.git "${XDG_CONFIG_HOME:-$HOME/.config}"/nvim
git checkout windows
```
#### Homebrew package manager setup and install additional packages

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
xargs brew install < brew_packages_list.txt
```
#### Selective tool installation

##### opentofu and Terraform

```sh
brew install opentofu
brew tap hashicorp/tap
brew install hashicorp/tap/terraform

```
##### Atuin

```sh
curl --proto '=https' --tlsv1.2 -LsSf https://setup.atuin.sh | sh
```

##### Rust
```sh
curl https://sh.rustup.rs -sSf | sh

```
##### Quarto
```sh
wget https://github.com/quarto-dev/quarto-cli/releases/download/v1.7.32/quarto-1.7.32-linux-amd64.deb
sudo dpkg -i quarto-1.7.32-linux-amd64.deb
```

##### tmux and tpm plugin manager setup

```sh
brew install tmux
git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
tmux source ~/.tmux.conf
`prefix` + I (capital i)

```
##### age

```sh
brew install age
```
##### sops, a secrets manager plugin

```sh
# Download the binary
curl -LO https://github.com/getsops/sops/releases/download/v3.10.2/sops-v3.10.2.linux.amd64

# Move the binary in to your PATH
mv sops-v3.10.2.linux.amd64 /usr/local/bin/sops

# Make the binary executable
chmod +x /usr/local/bin/sops
```

##### bitwarden-cli, a CLI for accessing the Bitwarden password manager

```sh
brew install bitwarden-cli
bw login
```

##### bw-serve setup (one-time, after `stow .`)

Secrets are managed via `bw serve`, a local REST API that runs as a systemd
user service on `127.0.0.1:8087`. The service file is stowed automatically
from `.config/systemd/user/bw-serve.service`.

```sh
# After stow . — tell systemd about the new service and enable it
systemctl --user daemon-reload
systemctl --user enable bw-serve.service
```

##### Daily usage

```sh
# Once after login/reboot — unlocks vault and starts the bw serve daemon
bw_serve_start

# In each shell/tmux pane where you need secrets — exports env vars
load_bw            # personal secrets
load_cf_work       # work secrets
load_wrangler_token

# Useful commands
bw_serve_status    # check if the API is running
bw_serve_stop      # stop the daemon and clear session
unset_bw_vars      # wipe exported env vars from current shell
```

`bw_serve_start` unlocks the vault once — after that, `load_bw` in any shell
is just a fast `curl` to localhost with no password prompt. The service
survives terminal/tmux restarts. After a reboot, run `bw_serve_start` again.

If you run `load_bw` without starting the service first, it will auto-start
and prompt you to unlock.

##### bun and deno

```sh
curl -fsSL https://bun.sh/install | bash
curl -fsSL https://deno.land/install.sh | sh
```

---

## [`functions.zsh`](functions.zsh)

All shell functions sourced into every zsh session. Grouped by category below.

### SOPS / Age encryption

Encrypt and decrypt files in-place using SOPS with Age keys. Requires
`SOPS_AGE_KEYS` to be set (use `load_sops_age_keys` or `load_bw`).

| Function | Description |
|---|---|
| `encrypt <file\|dir>` | Encrypt a file or all files in a directory with SOPS/Age |
| `decrypt <file\|dir>` | Decrypt a file or all files in a directory |
| `encrypt_all` | Encrypt every file in the current directory |
| `decrypt_all` | Decrypt every file in the current directory |
| `encrypt_k3s_secret <file>` | Encrypt a K8s Secret YAML (only `data`/`stringData` fields) |
| `decrypt_k3s_secret <file>` | Decrypt a K8s Secret YAML |
| `encrypt_tf` | Encrypt all Terraform/OpenTofu sensitive files in cwd (`secrets.tfvars`, `terraform.tfvars`, `blueprint-export.yaml`, `*.tfstate*`) |
| `decrypt_tf` | Decrypt the same set of files |

### Bitwarden Serve API

Local REST API (`bw serve`) running as a systemd user service. Functions use
an in-memory cache (5 min TTL) to avoid repeated HTTP calls.

| Function | Description |
|---|---|
| `bw_serve_start` | Unlock vault, sync, start the systemd service, wait for API |
| `bw_serve_stop` | Stop service, clear session file and cache |
| `bw_serve_status` | Check if API is reachable, show systemd status |
| `bw_serve_sync` | Sync vault from Bitwarden server, clear local cache |
| `clear_bw_cache` | Flush the in-memory key-value cache |

### Environment loaders

Load secrets from Bitwarden into env vars for the current shell. Each loader
defines a mapping of `"bw_item_name|ENV_VAR_NAME"` pairs.

| Function | What it loads |
|---|---|
| `load_bw` | Personal secrets (Cloudflare, AWS, Authentik, SOPS Age keys, etc.) |
| `load_cf_work` | Work Cloudflare/AWS credentials |
| `load_wrangler_token` | Cloudflare Wrangler API token |
| `load_sops_age_keys` | SOPS Age public + secret key into `SOPS_AGE_KEYS` |
| `unset_bw_vars` | Unset all env vars that could have been set by the loaders above |

### Terraform / OpenTofu

#### `tf_out` -- output accessor

Generic, project-agnostic accessor for `tofu output` / `terraform output`.
Auto-detects the IaC tool. Supports fuzzy name matching, nested key
extraction, clipboard copy, env export, and more.

```sh
# Browse & extract
tf_out                              # summary of all outputs
tf_out <name>                       # show single output with metadata
tf_out <name> <key>                 # extract a key from an object output
tf_out <name> <key.subkey>          # dot-path nested extraction
tf_out <name> <key> <subkey>        # multi-arg nested extraction

# Listing & filtering
tf_out --list                       # output names only
tf_out --sensitive                  # sensitivity & type matrix
tf_out --search <pattern>           # regex search output names
tf_out --type <type>                # filter by value type (string/object/array/number/boolean)
tf_out --count                      # count outputs by type and sensitivity

# Data formats
tf_out --json [name]                # full JSON (all or single output)
tf_out --raw <name> [key]           # raw value for piping (no labels/colors)
tf_out --table <name>               # render object as aligned key=value table
tf_out --keys <name>                # list keys of an object output

# Actions
tf_out --copy <name> [key]          # copy value to clipboard (wl-copy/xclip/pbcopy)
tf_out --env <name> [PREFIX]        # export object keys as PREFIX_KEY=value env vars
tf_out --diff <name>                # diff output vs last state backup
```

Fuzzy matching: `tf_out grafana` resolves to `oauth2_grafana` when
unambiguous. Ambiguous matches list candidates.

#### Other Terraform helpers

| Function | Description |
|---|---|
| `tf_debug_on` | Set `TF_LOG=debug` |
| `tf_debug_off` | Unset `TF_LOG` |
| `tf_debug_toggle` | Toggle debug logging on/off |
| `cf_permissions <tf\|tofu> <category>` | Query Cloudflare permission groups via `tofu console` (categories: `account`, `zone`, `user`, `r2`, `roles`, `all`) |

### Ansible

| Function | Description |
|---|---|
| `ansible_on` | Power on hosts via playbook |
| `ansible_off` | Shut down hosts via playbook |
| `ansible_update` | Run update playbook on all hosts |

### tmux

| Function | Description |
|---|---|
| `tx_switch [name]` | Create and switch to a new tmux session (default: `default`) |

### Navigation & shell utilities

| Function | Description |
|---|---|
| `yy` | Open yazi file manager; cd into its last directory on exit |
| `p10k_colours` | Print all 256 terminal colors (for Powerlevel10k theming) |
| `fix_file_limits` / `fixfiles` | Inspect and optionally raise file descriptor limits |
| `update_all` / `upall` | Update apt packages and Homebrew packages in one shot |
