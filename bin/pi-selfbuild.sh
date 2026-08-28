#!/usr/bin/env bash
# pi-selfbuild.sh - daily check for new pi commits on main; rebuild + swap if changed.
#
# Layout:
#   ~/pi-src                        git checkout of earendil-works/pi
#   ~/.local/share/pi-builds/pi-<sha>/   extracted release tree per build
#   ~/.pi/agent/bin/pi              symlink -> active build's pi binary
#
# ~/.pi/agent/bin is first on PATH (precedes /usr/sbin where the installer-
# managed release lives), so the self-built binary wins without sudo.
# Safe to re-run: no-op when main HEAD == currently-linked build.

set -euo pipefail

SRC="$HOME/pi-src"
BUILDS="$HOME/.local/share/pi-builds"
LINK="$HOME/.pi/agent/bin/pi"
KEEP=3
LOG_TAG="pi-selfbuild"

log() { echo "[$LOG_TAG] $*"; }

cd "$SRC"
git fetch --quiet origin main
HEAD_SHA="$(git rev-parse --short origin/main)"
CURRENT_SHA=""
if [[ -L "$LINK" ]]; then
  CURRENT_TARGET="$(readlink -f "$LINK")"
  # ~/.local/share/pi-builds/pi-<sha>/pi/pi -> extract <sha>
  CURRENT_SHA="$(basename "$(dirname "$(dirname "$CURRENT_TARGET")")" | sed 's/^pi-//')"
fi

if [[ "$HEAD_SHA" == "$CURRENT_SHA" ]]; then
  log "up to date at $HEAD_SHA; nothing to do"
  exit 0
fi

log "main moved: ${CURRENT_SHA:-none} -> $HEAD_SHA; building"
git checkout --quiet --detach origin/main
git submodule update --init --recursive --quiet || true

npm ci --no-audit --no-fund >/dev/null
./scripts/build-binaries.sh --skip-install --platform linux-x64 --out "$BUILDS/out"

DEST="$BUILDS/pi-$HEAD_SHA"
rm -rf "$DEST"
mkdir -p "$DEST"
tar -xzf "$BUILDS/out/pi-linux-x64.tar.gz" -C "$DEST"
rm -rf "$BUILDS/out"

# Smoke test before swapping the link
"$DEST/pi/pi" --version >/dev/null
log "smoke ok: $("$DEST/pi/pi" --version)"

ln -sfn "$DEST/pi/pi" "$LINK"
log "linked $LINK -> $DEST/pi/pi"

# Prune old builds (keep newest KEEP)
ls -1dt "$BUILDS"/pi-* | tail -n +$((KEEP + 1)) | while read -r old; do
  log "pruning $old"
  rm -rf "$old"
done

log "done: now running $HEAD_SHA (restart pi to pick it up)"
