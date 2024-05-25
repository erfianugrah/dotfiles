 ### Setup
#### Install zsh with brew or apt or bash

```markdown
sh -c "$(curl -fsSL https://raw.github.com/robbyrussell/oh-my-zsh/master/tools/install.sh)"
```
#### Install powerlevel10k theme and set it as the default theme

```markdown
git clone https://github.com/romkatv/powerlevel10k.git $ZSH_CUSTOM/themes/powerlevel10k
ZSH_THEME="powerlevel10k/powerlevel10k"
```
#### Install Meslo Nerd Font

Download from `https://github.com/ryanoasis/nerd-fonts/releases/download/v3.2.0/Meslo.zip`

#### Useful plugins

```markdown
git clone https://github.com/zsh-users/zsh-completions ${ZSH_CUSTOM:-${ZSH:-~/.oh-my-zsh}/custom}/plugins/zsh-completions
git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting
git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
curl -sS https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | bash
```
#### Vim and Neovim setup

```markdown
brew install neovim vim
git clone https://github.com/erfianugrah/kickstart.nvim.git "${XDG_CONFIG_HOME:-$HOME/.config}"/nvim
```
#### Homebrew package manager setup and install additional packages

```markdown
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
xargs brew install < brew_packages_list.txt
```
#### Selective tool installation

##### opentofu and Terraform

```markdown
brew install opentofu terraform
```
##### tmux and tpm plugin manager setup

```markdown
brew install tmux
git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
```
##### age

```markdown
brew install age
```
##### sops, a secrets manager plugin

```markdown
curl -LO https://github.com/getsops/sops/releases/download/v3.8.1/sops-v3.8.1.linux.amd64
mv sops-v3.8.1.linux.amd64 /usr/local/bin/sops
chmod +x /usr/local/bin/sops
age-keygen -o key.txt
```
##### bitwarden-cli, a CLI for accessing the Bitwarden password manager

```markdown
brew install bitwarden-cli
```
