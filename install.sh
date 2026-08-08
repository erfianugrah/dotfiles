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

echo ">> done."
