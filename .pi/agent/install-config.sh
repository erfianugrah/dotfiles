#!/usr/bin/env bash
# install-config.sh - place pi USER-CONFIG files that pi packages can't carry.
#
# pi packages ship RESOURCES (extensions / skills / prompts / themes) but NOT
# user config. On a machine set up via `pi install git:github.com/erfianugrah/dotfiles`
# (i.e. no GNU stow), run this once to link the config files into ~/.pi/agent/.
#
# On a stow-managed machine you do NOT need this - stow already links them.
#
#   Usage:  bash install-config.sh            # symlink (default)
#           COPY=1 bash install-config.sh     # copy instead of symlink
#           PI_AGENT_DIR=/custom bash install-config.sh
#
# Idempotent. A pre-existing non-symlink file is backed up to <file>.bak.<ts>.
# NEVER touches auth.json / sessions / memories (per-machine runtime state).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${PI_AGENT_DIR:-$HOME/.pi/agent}"
FILES=(settings.json models.json keybindings.json APPEND_SYSTEM.md)

mkdir -p "$DEST"
echo "pi config: $SRC -> $DEST"

for f in "${FILES[@]}"; do
	src="$SRC/$f"
	dst="$DEST/$f"
	if [[ ! -e "$src" ]]; then
		echo "  skip $f (not in package)"
		continue
	fi
	if [[ -e "$dst" && ! -L "$dst" ]]; then
		bak="$dst.bak.$(date +%s)"
		cp "$dst" "$bak"
		echo "  backed up existing $f -> $(basename "$bak")"
	fi
	if [[ "${COPY:-0}" == "1" ]]; then
		cp "$src" "$dst"
		echo "  copied  $f"
	else
		ln -sfn "$src" "$dst"
		echo "  linked  $f"
	fi
done

echo
echo "done. Review $DEST/settings.json - merge machine-specific keys"
echo "(defaultProvider/model, enabledModels) and log in with: pi (then /login)."
