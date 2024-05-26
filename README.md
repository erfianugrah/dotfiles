 ### Setup
#### Install Pacman packages
```sh
sudo pacman -Q|cut -f 1 -d " "
pacman -S --needed git base-devel && git clone https://aur.archlinux.org/yay-bin.git && cd yay-bin && makepkg -si
```
```sh
xargs sudo pacman -S < pacman_packages.txt
```
#### Install Meslo Nerd Font

```sh
sudo pacman -S ttf-iosvekatern-nerd
```

#### Vim and Neovim setup

```sh
git clone https://github.com/erfianugrah/kickstart.nvim.git "${XDG_CONFIG_HOME:-$HOME/.config}"/nvim
```

#### Selective tool installation
##### tmux and tpm plugin manager setup

```sh
git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
```

##### sops, a secrets manager plugin

```sh
curl -LO https://github.com/getsops/sops/releases/download/v3.8.1/sops-v3.8.1.linux.amd64
mv sops-v3.8.1.linux.amd64 /usr/local/bin/sops
chmod +x /usr/local/bin/sops
age-keygen -o key.txt
```

##### bitwarden-cli, a CLI for accessing the Bitwarden password manager

```sh
npm -i -g bitwarden-cli
```
