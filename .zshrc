export GPG_TTY=$(tty)
typeset -g POWERLEVEL9K_INSTANT_PROMPT=quiet

# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

typeset -ga _missing_tools=()

export PATH=$HOME/.npm-global/bin:$HOME/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:$HOME/.local/bin:$HOME/.bun/bin:/usr/local/go/bin:$PATH
# Language servers Mason installs for nvim (terraform-ls, astro-ls, lua-language-server,
# markdown-oxide, docker-langserver, sql-language-server, ...). Appended, not prepended:
# bun/cargo/go copies of the same servers keep winning, Mason only fills the gaps. Both
# pi (extensions/lsp) and Claude Code (LSP plugins) resolve servers from PATH.
export PATH=$PATH:$HOME/.local/share/nvim/mason/bin

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

# ---------------------------------------------------------------------------
# Oh-My-Zsh (tmux plugin loaded via OMZ, everything else via zinit snippets)
# OMZ snippets via zinit (tmux plugin needs extra conf files created on clone)
# ---------------------------------------------------------------------------
zinit ice atclone'
  print "set -g default-terminal tmux-256color\nsource-file ~/.tmux.conf" > tmux.extra.conf
  print "set -g default-terminal tmux-256color" > tmux.only.conf
' atpull'%atclone' nocompile
zinit snippet OMZP::tmux
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
zinit snippet OMZP::npm
zinit snippet OMZP::python
zinit snippet OMZP::gh
[[ -f /etc/debian_version ]] && zinit snippet OMZP::debian
zinit snippet OMZP::rust
zinit snippet OMZP::colored-man-pages
zinit snippet OMZ::lib/async_prompt.zsh
zinit snippet OMZ::lib/bzr.zsh
zinit snippet OMZ::lib/cli.zsh
zinit snippet OMZ::lib/clipboard.zsh
zinit snippet OMZ::lib/compfix.zsh
zinit snippet OMZ::lib/completion.zsh
zinit snippet OMZ::lib/correction.zsh
zinit snippet OMZ::lib/diagnostics.zsh
zinit snippet OMZ::lib/directories.zsh
zinit snippet OMZ::lib/functions.zsh
zinit snippet OMZ::lib/git.zsh
zinit snippet OMZ::lib/grep.zsh
zinit snippet OMZ::lib/history.zsh
zinit snippet OMZ::lib/key-bindings.zsh
zinit snippet OMZ::lib/misc.zsh
zinit snippet OMZ::lib/nvm.zsh
zinit snippet OMZ::lib/prompt_info_functions.zsh
zinit snippet OMZ::lib/spectrum.zsh
zinit snippet OMZ::lib/termsupport.zsh
zinit snippet OMZ::lib/theme-and-appearance.zsh
zinit snippet OMZ::lib/vcs_info.zsh

# Cache the completion dump: compinit re-scans every fpath dir (~500ms/shell)
# even when the dump is consistent; -C skips the scan (~10ms). Re-verify once
# a day so newly installed completions get picked up; the touch resets the 24h
# clock (compinit only rewrites the dump when the file count changes, so mtime
# alone can't be trusted to freshen).
# Anonymous fn scopes extendedglob (off at this point in the rc) for (#q...).
autoload -Uz compinit
() {
  setopt localoptions extendedglob
  if [[ -n ~/.zcompdump(#qN.mh+24) ]]; then
    compinit && touch ~/.zcompdump
  else
    compinit -C
  fi
}
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

# Navigation: bare directory name cds into it (covers `..`)
setopt autocd
alias ...='cd ../..'
alias ....='cd ../../..'

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
if (( $+commands[eza] )); then alias ls=eza; else _missing_tools+=("eza"); fi
if (( $+commands[bat] )); then alias cat=bat; else _missing_tools+=("bat"); fi
alias bw='NODE_OPTIONS="--no-deprecation" bw'
alias c=cargo
alias zja="zj a --index"
alias zjac="zj a -c"
alias zjda="zj da"
alias s=sentry-cli
alias sb=supabase
alias pgpasteriser='(set -a; source ~/pastebin/.env; set +a; pgcli "$PASTERISER_DB_URL")'
alias navidrome="cliamp --provider navidrome"

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
export DOCKER_BUILDKIT=1
export LANG=C.UTF-8
export LC_ALL=C.UTF-8

source ~/dotfiles/functions.zsh
source ~/dotfiles/wezterm.sh

# ---------------------------------------------------------------------------
# Bitwarden secrets at shell start
# ---------------------------------------------------------------------------
# First interactive shell after login unlocks the vault (ONE master-password
# prompt per boot). bw_serve_start also seeds the gpg-agent cache, so GPG
# signing never needs its own prompt either. Later shells just re-export the
# env vars from the already-running daemon - silent unless something failed.
# If the first-shell unlock is declined, later shells stay quiet until the
# attempt flag lapses (1h); run bw_serve_start / load_bw manually whenever.
# Fast path first: _bw_env_cache_load sources a tmpfs snapshot stamped with
# the live bw session, costing ~1ms. Only on a miss (first shell after boot,
# after bw_serve_start / bw_set invalidated it, or once the TTL lapses) do we
# pay the full load. Order matters - _bw_serve_ok is itself a ~0.5s curl, so
# it must sit behind the cache check, not in front of it.
if [[ -o interactive ]] && (( $+functions[load_bw] )); then
  if ! _bw_env_cache_load; then
    if _bw_serve_ok; then
      local _bw_out
      _bw_out=$(load_bw 2>&1)
      if (( $? != 0 )) || [[ "$_bw_out" == *FAILED* || "$_bw_out" == *stale* ]]; then
        print -u2 -- "$_bw_out"
      fi
      unset _bw_out
    else
      # Defer the auto-attempt to first precmd. The attempt can land in
      # bw_serve_start -> `bw unlock`, an interactive master-password read.
      # Inside the p10k instant-prompt window that read is invisible (no
      # echo, typed keystrokes get buffered/eaten) and the shell looks hung
      # - 2026-08-13, new tmux window after a fresh boot. At first precmd
      # the instant prompt is torn down and the prompt renders normally.
      _bw_deferred_auto_unlock() {
        add-zsh-hook -d precmd _bw_deferred_auto_unlock
        # Another shell may have unlocked while this one was starting.
        _bw_serve_ok && return 0
        # One auto-attempt per flag-file lifetime. The flag stores an epoch
        # and lapses after an hour: macOS has no XDG_RUNTIME_DIR and its
        # per-user TMPDIR survives logout (only reboot clears it), so a bare
        # ! -e check means one declined/failed unlock mutes every later shell
        # until REBOOT - and if the un-supervised nohup serve daemon dies, no
        # shell ever retries. Epoch-in-file: no GNU/BSD stat fork needed.
        local _bw_flag="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/bw-load-attempted" _bw_last=0
        [[ -f "$_bw_flag" ]] && read -r _bw_last < "$_bw_flag"
        [[ "$_bw_last" == <-> ]] || _bw_last=0
        if (( $(date +%s) - _bw_last > 3600 )); then
          print -r -- "$(date +%s)" >| "$_bw_flag"
          load_bw
        fi
      }
      autoload -Uz add-zsh-hook
      add-zsh-hook precmd _bw_deferred_auto_unlock
    fi
  fi
fi

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

# Force emacs keymap — zsh auto-switches to vi mode when EDITOR contains vi/nvim
bindkey -e

if (( $+commands[fzf] )); then eval "$(fzf --zsh)"; else _missing_tools+=("fzf"); fi
if (( $+commands[zoxide] )); then eval "$(zoxide init zsh)"; else _missing_tools+=("zoxide"); fi

# Tool completions / env
[[ -s "$HOME/.bun/_bun" ]] && source "$HOME/.bun/_bun"
[[ -f "$HOME/.atuin/bin/env" ]] && source "$HOME/.atuin/bin/env"
if (( $+commands[atuin] )); then eval "$(atuin init zsh --disable-up-arrow)"; else _missing_tools+=("atuin"); fi
[[ -f "$HOME/.deno/env" ]] && source "$HOME/.deno/env"

# pnpm
export PNPM_HOME="$HOME/.local/share/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac

[[ -s "$HOME/.config/envman/load.sh" ]] && source "$HOME/.config/envman/load.sh"

# opencode
export PATH=$HOME/.opencode/bin:$PATH
export OPENCODE_DISABLE_PRUNE=true
export OPENCODE_DISABLE_CHANNEL_DB=true
export OPENCODE_ENABLE_EXA=1
# Warn about missing tools (once, non-blocking)
if (( ${#_missing_tools} )); then
  print -P "%F{yellow}[dotfiles]%f missing tools: ${(j:, :)_missing_tools} — install for full shell experience"
fi
unset _missing_tools

# bun completions
[ -s "/home/erfi/.bun/_bun" ] && source "/home/erfi/.bun/_bun"
