### Setup
#### Install zsh with brew or apt or bash

## Note
Before running `stow .` on the dotfiles, make sure all binaries are installed first

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

##### [functions.zsh](functions.zsh)
Contains SOPS/Age encryption helpers, Bitwarden API accessors, Cloudflare
credential retrieval, and system utilities. See the bw-serve section above
for secrets management usage.
