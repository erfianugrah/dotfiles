### Setup
#### Install zsh with brew or apt or bash

```
brew install zsh
sudo apt-get install zsh
sh -c "$(curl -fsSL https://raw.github.com/robbyrussell/oh-my-zsh/master/tools/install.sh)"
```

#### powerlevel10k theme

```
git clone https://github.com/romkatv/powerlevel10k.git $ZSH_CUSTOM/themes/powerlevel10k
```

#### Set theme

```
ZSH_THEME="powerlevel10k/powerlevel10k"
```

#### Useful plugins

```
git clone https://github.com/marlonrichert/zsh-autocomplete.git
git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting
git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
curl -sS https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | bash
```

### Other tools

#### vim/nvim

```
brew install neovim vim
git clone https://github.com/erfianugrah/kickstart.nvim.git "${XDG_CONFIG_HOME:-$HOME/.config}"/nvim
```

#### brew

```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

#### opentofu and terraform

```
brew install opentofu terraform
```

#### tmux

```
brew install tmux
git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
```

#### age

```
brew install age
```

#### sops

```
curl -LO https://github.com/getsops/sops/releases/download/v3.8.1/sops-v3.8.1.linux.amd64
mv sops-v3.8.1.linux.amd64 /usr/local/bin/sops
chmod +x /usr/local/bin/sops
age-keygen -o key.txt
```

#### bitwarden-cli

```
brew install bitwarden-cli
```
