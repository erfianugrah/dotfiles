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

OS="$(detect_os)"
echo ">> detected OS: $OS (dotfiles: $DOTFILES)"

case "$OS" in
  nixos)
    if [ "$LINKS_ONLY" = 0 ]; then
      echo ">> installing packages via home-manager (flake: packages/nix#$(whoami))"
      run nix --extra-experimental-features "nix-command flakes" \
        run home-manager/master -- switch --flake "$DOTFILES/packages/nix#$(whoami)" \
        || echo "!! home-manager failed (missing '$(whoami)' config in flake?) - continuing with stow links"
    fi
    do_stow
    ;;
  steamos)
    if [ "$LINKS_ONLY" = 0 ]; then
      echo ">> installing packages via home-manager (flake: packages/nix#deck)"
      run nix --extra-experimental-features "nix-command flakes" \
        run home-manager/master -- switch --flake "$DOTFILES/packages/nix#deck"
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

echo ">> done."
