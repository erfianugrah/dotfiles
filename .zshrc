export GPG_TTY=$(tty)
typeset -g POWERLEVEL9K_INSTANT_PROMPT=quiet

# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

export PATH=$HOME/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:$HOME/.local/bin:$HOME/.bun/bin:/usr/local/go/bin:$PATH

# WSL-specific paths
if [[ -d /mnt/c ]]; then
    export PATH=$PATH:/usr/lib/wsl/lib:/mnt/c/Program\ Files/Git/mingw64/bin
fi

# ---------------------------------------------------------------------------
# Zinit plugin manager
# ---------------------------------------------------------------------------
ZINIT_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}/zinit/zinit.git"

if [ ! -d "$ZINIT_HOME" ]; then
   mkdir -p "$(dirname "$ZINIT_HOME")"
   git clone https://github.com/zdharma-continuum/zinit.git "$ZINIT_HOME"
fi

source "${ZINIT_HOME}/zinit.zsh"

# Theme
zinit ice depth=1; zinit light romkatv/powerlevel10k
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

# Plugins
zinit light Aloxaf/fzf-tab
zinit light zsh-users/zsh-completions
zinit light zsh-users/zsh-autosuggestions
zinit light zsh-users/zsh-history-substring-search
zinit light zdharma-continuum/fast-syntax-highlighting
zinit light atuinsh/atuin

# OMZ snippets (loaded individually via zinit, no oh-my-zsh.sh needed)
zinit snippet OMZP::git
zinit snippet OMZP::git-auto-fetch
zinit snippet OMZP::git-prompt
(( $+commands[brew] )) && zinit snippet OMZP::brew
zinit snippet OMZP::ansible
zinit snippet OMZP::sudo
zinit snippet OMZP::vscode
zinit snippet OMZP::github
zinit snippet OMZP::kubectl
zinit snippet OMZP::kubectx
zinit snippet OMZP::command-not-found
zinit snippet OMZP::terraform
zinit snippet OMZP::opentofu
zinit snippet OMZP::tmux
zinit snippet OMZP::npm
zinit snippet OMZP::python
zinit snippet OMZP::gh
[[ -f /etc/debian_version ]] && zinit snippet OMZP::debian
zinit snippet OMZP::rust
zinit snippet OMZP::colored-man-pages

autoload -Uz compinit && compinit
zinit cdreplay -q

# ---------------------------------------------------------------------------
# Shell options
# ---------------------------------------------------------------------------
ZSH_TMUX_DEFAULT_SESSION_NAME="${HOST:-default}"
ZSH_AUTOSUGGEST_STRATEGY=(history completion)
POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD=true

bindkey '^p' history-search-backward
bindkey '^n' history-search-forward
bindkey '^[w' kill-region
bindkey '^[[A' history-substring-search-up
bindkey '^[[B' history-substring-search-down

# History
HISTSIZE=10000000
HISTFILE=~/.zsh_history
SAVEHIST=$HISTSIZE
HISTDUP=erase
setopt appendhistory
setopt sharehistory
setopt hist_ignore_space
setopt hist_ignore_all_dups
setopt hist_save_no_dups
setopt hist_ignore_dups
setopt hist_find_no_dups

# Completion styling
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'
zstyle ':completion:*' list-colors "${(s.:.)LS_COLORS}"
zstyle ':completion:*' menu no
zstyle ':fzf-tab:*' fzf-flags --ansi
zstyle ':fzf-tab:*' fzf-bindings 'ctrl-y:accept'
zstyle ':fzf-tab:complete:cd:*' fzf-preview 'ls $realpath'
zstyle ':fzf-tab:complete:z:*' fzf-preview 'ls $realpath'

# ---------------------------------------------------------------------------
# Aliases
# ---------------------------------------------------------------------------
alias k=kubectl
alias t=tofu
alias tf=terraform
alias w=wrangler
alias cft=cf-terraforming
alias p=python3
alias v=nvim
alias ls=eza
alias cat=bat
alias bw='NODE_OPTIONS="--no-deprecation" bw'
alias c=cargo
alias zja="zj a --index"
alias zjac="zj a -c"
alias zjda="zj da"
alias s=sentry-cli
alias sb=supabase
alias pgpasteriser='(export $(grep -v "^#" ~/pastebin/.env | xargs) && pgcli $PASTERISER_DB_URL)'

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
export DOCKER_BUILDKIT=1
export STARSHIP_CONFIG=$HOME/starship.toml
export STARSHIP_CACHE=$HOME/.starship/cache
export LANG=C.UTF-8
export LC_ALL=C.UTF-8

source ~/dotfiles/functions.zsh
source ~/dotfiles/wezterm.sh

# Editor (first available)
if command -v nvim &> /dev/null; then
  export EDITOR='nvim'
elif command -v vim &> /dev/null; then
  export EDITOR='vim'
elif command -v nano &> /dev/null; then
  export EDITOR='nano'
elif command -v code &> /dev/null; then
  export EDITOR='code --wait'
fi

eval "$(fzf --zsh)"
eval "$(zoxide init zsh)"

# Tool completions / env
[ -s "$HOME/.bun/_bun" ] && source "$HOME/.bun/_bun"
[[ -f "$HOME/.atuin/bin/env" ]] && . "$HOME/.atuin/bin/env"
eval "$(atuin init zsh --disable-up-arrow)"
[[ -f "$HOME/.deno/env" ]] && . "$HOME/.deno/env"

# pnpm
export PNPM_HOME="$HOME/.local/share/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac

[ -s "$HOME/.config/envman/load.sh" ] && source "$HOME/.config/envman/load.sh"

# opencode
export PATH=$HOME/.opencode/bin:$PATH
export OPENCODE_DISABLE_PRUNE=true
