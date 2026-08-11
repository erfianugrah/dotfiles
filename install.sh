#!/usr/bin/env bash
# install.sh - OS-detecting dotfiles bootstrap.
#
# Detects the host OS and installs the dotfiles the way that OS wants:
#   nixos    -> home-manager (packages via packages/nix flake) + stow links
#   steamos  -> home-manager (#deck config) + stow links
#   arch     -> pacman/paru package lists + stow links
#   macos    -> brew bundle + stow links
#   other    -> stow links only (universal fallback)
#
# Idempotent. Flags:
#   --links-only   skip package installation, just (re)link dotfiles
#   --dry-run      print what would happen, do nothing
#
# Dotfile LINKS are stow everywhere for now (one mental model, proven on
# NixOS 2026-07-20). A future home.file mode (generation-managed links) can
# slot into the nixos branch without changing the other paths.

set -euo pipefail

DOTFILES="${DOTFILES_DIR:-$HOME/dotfiles}"
LINKS_ONLY=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --links-only) LINKS_ONLY=1 ;;
    --dry-run)    DRY_RUN=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

run() { if [ "$DRY_RUN" = 1 ]; then echo "+ $*"; else "$@"; fi; }

detect_os() {
  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${ID:-}" in
      nixos)                          echo nixos;   return ;;
      steamos)                        echo steamos; return ;;
      arch|cachyos|endeavouros|manjaro) echo arch;  return ;;
      debian|ubuntu|pop)              echo debian;  return ;;
    esac
  fi
  case "$(uname -s)" in
    Darwin) echo macos; return ;;
  esac
  echo unknown
}

do_stow() {
  if ! command -v stow >/dev/null 2>&1; then
    echo "stow not found - install it first (pacman -S stow / brew install stow / nix profile install nixpkgs#stow)" >&2
    exit 1
  fi
  echo ">> linking dotfiles via stow"
  (cd ~ && run stow -d "$DOTFILES" -t "$HOME" -v .)
}

# Tools in bin/ that must be on PATH. ~/bin itself is a folded stow link but
# NOT on PATH on all machines - link the select tools into ~/.local/bin which
# is. Idempotent (ln -sf). stow-drift is a Go binary: build it if go is
# available and the binary is missing, else skip with a note.
do_local_bin() {
  echo ">> linking PATH tools into ~/.local/bin"
  run mkdir -p "$HOME/.local/bin"
  local tools=(mdclip)
  if [ ! -x "$DOTFILES/bin/stow-drift" ]; then
    if command -v go >/dev/null 2>&1; then
      echo ">> building stow-drift (go found, binary missing)"
      (cd "$DOTFILES/bin" && run go build -ldflags="-s -w" -o stow-drift .)
    else
      echo "!! no go toolchain - skipping stow-drift build (install go, rerun)" >&2
    fi
  fi
  [ -x "$DOTFILES/bin/stow-drift" ] && tools+=(stow-drift)
  local t
  for t in "${tools[@]}"; do
    run ln -sf "$DOTFILES/bin/$t" "$HOME/.local/bin/$t"
  done
}

# Claude Code dual-harness wiring. stow already links .claude/ (skills, hooks,
# mcp scripts, CLAUDE.md) into ~/.claude, but two CC integration points live in
# files stow must NOT own because they are live CC state:
#   1. MCP servers  -> registered in ~/.claude.json via `claude mcp add`.
#   2. hooks        -> merged into ~/.claude/settings.json (.claude/settings.json
#                      is stow-ignored; see .stow-local-ignore).
# Both steps are idempotent and no-op cleanly when claude/bun/jq are absent.
do_claude() {
  local ccdir="$DOTFILES/.claude"
  [ -d "$ccdir" ] || return 0
  echo ">> wiring Claude Code (MCP + hooks)"

  # 1. MCP toolkit server: install its deps in the repo checkout, register once.
  if command -v claude >/dev/null 2>&1 && command -v bun >/dev/null 2>&1; then
    if [ -f "$ccdir/mcp/package.json" ]; then
      (cd "$ccdir/mcp" && run bun install --silent)
    fi
    if claude mcp list 2>/dev/null | grep -q 'erfi-toolkit'; then
      echo ">> MCP erfi-toolkit already registered"
    else
      run claude mcp add --scope user erfi-toolkit -- bun "$ccdir/mcp/toolkit.ts"
    fi
  else
    echo "!! claude or bun missing - skipping MCP registration"
  fi

  # 2. Hooks: deep-merge .claude/settings.json's hooks into ~/.claude/settings.json,
  #    concatenating per-event arrays and de-duping so re-runs are idempotent.
  local src="$ccdir/settings.json" dst="$HOME/.claude/settings.json"
  if [ -f "$src" ]; then
    if command -v jq >/dev/null 2>&1; then
      run mkdir -p "$HOME/.claude"
      if [ "$DRY_RUN" = 1 ]; then
        echo "+ jq-merge $src hooks -> $dst"
      else
        [ -f "$dst" ] || echo '{}' > "$dst"
        local tmp; tmp="$(mktemp)"
        jq -s '
          .[0] as $dst | .[1] as $src |
          $dst * { hooks:
            ( ($dst.hooks // {}) as $dh | ($src.hooks // {}) as $sh |
              reduce ($sh | keys[]) as $k ($dh;
                .[$k] = (((.[$k] // []) + $sh[$k]) | unique_by(tojson))) )
          }' "$dst" "$src" > "$tmp" && mv "$tmp" "$dst"
        echo ">> merged CC hooks into $dst"
      fi
    else
      echo "!! jq not found - skipping CC hooks merge (install jq, rerun)"
    fi
  fi
}

OS="$(detect_os)"
echo ">> detected OS: $OS (dotfiles: $DOTFILES)"

case "$OS" in
  nixos)
    if [ "$LINKS_ONLY" = 0 ]; then
      echo ">> installing packages via home-manager (flake: packages/nix#$(whoami))"
      # NIX_CONFIG env (not CLI flags) so home-manager's own child nix calls
      # inherit experimental-features too (CLI flags don't propagate).
      run env NIX_CONFIG="experimental-features = nix-command flakes" \
        nix run home-manager/master -- switch --flake "$DOTFILES/packages/nix#$(whoami)" \
        || echo "!! home-manager failed (missing '$(whoami)' config in flake?) - continuing with stow links"
    fi
    do_stow
    ;;
  steamos)
    if [ "$LINKS_ONLY" = 0 ]; then
      echo ">> installing packages via home-manager (flake: packages/nix#deck)"
      run env NIX_CONFIG="experimental-features = nix-command flakes" \
        nix run home-manager/master -- switch --flake "$DOTFILES/packages/nix#deck"
    fi
    do_stow
    ;;
  arch)
    if [ "$LINKS_ONLY" = 0 ]; then
      echo ">> installing repo packages via pacman"
      run sudo pacman -S --needed - < "$DOTFILES/packages/arch-repo.txt"
      if command -v paru >/dev/null 2>&1; then
        echo ">> installing AUR packages via paru"
        run paru -S --needed - < "$DOTFILES/packages/arch-aur.txt"
      fi
    fi
    do_stow
    ;;
  macos)
    if [ "$LINKS_ONLY" = 0 ]; then
      echo ">> installing packages via brew bundle"
      run brew bundle --file="$DOTFILES/packages/brew.txt"
    fi
    do_stow
    ;;
  *)
    echo ">> no package manager mapping for '$OS' - stow links only"
    do_stow
    ;;
esac

do_local_bin
do_claude

echo ">> done."
