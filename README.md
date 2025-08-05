 ### Setup
#### Install zsh with brew or apt or bash

```sh
brew install zsh
sudo apt-get install zsh
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

#### Useful plugins

```sh
git clone https://github.com/zsh-users/zsh-completions ${ZSH_CUSTOM:-${ZSH:-~/.oh-my-zsh}/custom}/plugins/zsh-completions
git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting
git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
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
brew install opentofu terraform
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
```

##### [functions.zsh](functions.zsh)
Make sure to run before running `tmux` so that the env variables can be set and persisted across from shell
