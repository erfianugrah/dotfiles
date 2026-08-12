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

# claude native-binary sanity. An npm-global claude can lose its
# platform-native optional dependency (postinstall skipped via
# --ignore-scripts / --omit=optional, or the auto-updater re-dropping the stub
# binary); the symptom is "claude native binary not installed" at startup.
# Same failure and same repair on macos/nixos/steamos/arch - the only variance
# is where npm's global root lives and whether it's user-writable, so resolve
# via `npm root -g` and branch on writability.
claude_native_ok() {
  local out
  out="$(DISABLE_AUTOUPDATER=1 claude --version 2>&1)"
  # Match the error TEXT, not the exit code: some broken-stub versions print
  # "native binary not installed" and still exit 0, so an exit-code check
  # waves them through and the repair never fires (seen on macOS).
  ! printf '%s' "$out" | grep -q 'native binary not installed'
}

claude_repair_native() {
  if ! command -v npm >/dev/null 2>&1; then
    echo "!! npm not found - reinstall claude manually" >&2
    return 1
  fi
  local pkg; pkg="$(npm root -g)/@anthropic-ai/claude-code"
  if [ ! -f "$pkg/install.cjs" ]; then
    echo "!! $pkg/install.cjs not found - claude is not an npm-global install (nix/brew?) - repair via its package manager" >&2
    _claude_native_installer_hint
    return 1
  fi
  echo ">> claude native binary missing - running package postinstall ($pkg/install.cjs)"
  if [ -w "$pkg" ]; then
    run node "$pkg/install.cjs"
  elif [[ "$pkg" != /nix/* ]] && command -v sudo >/dev/null 2>&1; then
    # Root-owned system prefix (arch /usr/lib, some brew layouts). sudo needs
    # an absolute node - nvm/fnm node isn't on sudo's PATH.
    run sudo "$(command -v node)" "$pkg/install.cjs"
  else
    echo "!! $pkg is not writable - run: node $pkg/install.cjs" >&2
    return 1
  fi
  claude_native_ok || {
    echo "!! repair ran but claude still reports the error (platform optional dep likely missing from the npm install)" >&2
    _claude_native_installer_hint
  }
}

_claude_native_installer_hint() {
  # The npm package keeps self-clobbering via its autoupdater; the native
  # installer (~/.local/bin/claude, background auto-update) is the durable fix.
  echo "!! durable fix - migrate to the native installer:" >&2
  echo "!!   npm uninstall -g @anthropic-ai/claude-code && curl -fsSL https://claude.ai/install.sh | bash" >&2
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

  # 0. Repair a broken npm-global claude before anything invokes it.
  if command -v claude >/dev/null 2>&1 && ! claude_native_ok; then
    claude_repair_native || echo "!! claude repair failed - continuing anyway" >&2
  fi

  # 1. MCP toolkit server: install its deps in the repo checkout, register once
  #    at USER scope. The probe reads ~/.claude.json directly (user scope lives
  #    there): `claude mcp list` from a repo cwd also shows PROJECT-scope
  #    entries from .mcp.json, so a bare grep false-matches the pending-approval
  #    project entry and skips the real registration (observed 2026-08-12).
  #    A registered-but-stale path (e.g. an old worktree) is re-registered.
  #    DISABLE_AUTOUPDATER=1: invoking the npm-global claude otherwise triggers
  #    a self-update that re-drops the stub binary and breaks the NEXT call.
  if command -v claude >/dev/null 2>&1 && command -v bun >/dev/null 2>&1; then
    if [ -f "$ccdir/mcp/package.json" ]; then
      (cd "$ccdir/mcp" && run bun install --silent)
    fi
    local mcpcfg="$HOME/.claude.json" want="$ccdir/mcp/toolkit.ts" current=""
    if command -v jq >/dev/null 2>&1 && [ -f "$mcpcfg" ]; then
      current="$(jq -r '.mcpServers["erfi-toolkit"].args[-1] // empty' "$mcpcfg" 2>/dev/null)"
    fi
    if [ "$current" = "$want" ]; then
      echo ">> MCP erfi-toolkit already registered (user scope, path OK)"
    else
      if [ -n "$current" ]; then
        echo ">> MCP erfi-toolkit points at $current - re-registering"
        run env DISABLE_AUTOUPDATER=1 claude mcp remove erfi-toolkit -s user || true
      fi
      run env DISABLE_AUTOUPDATER=1 claude mcp add --scope user erfi-toolkit -- bun "$want" \
        || echo "!! claude mcp add failed - register manually: claude mcp add --scope user erfi-toolkit -- bun $want" >&2
    fi
  else
    echo "!! claude or bun missing - skipping MCP registration"
  fi

  # 2. Hooks: deep-merge .claude/settings.json's hooks into ~/.claude/settings.json,
  #    concatenating per-event arrays and de-duping so re-runs are idempotent.
  #    Dedup preserves FIRST-seen order (unique_by would sort the array and
  #    silently reshuffle the user's pre-existing hooks - CC runs same-matcher
  #    hooks in array order). Write-back preserves the destination's perms by
  #    overwriting in place (cat > keeps inode+mode); mktemp lands in the dest
  #    dir so the new-file path is a same-fs atomic rename.
  local src="$ccdir/settings.json" dst="$HOME/.claude/settings.json"
  if [ -f "$src" ]; then
    if command -v jq >/dev/null 2>&1; then
      run mkdir -p "$HOME/.claude"
      if [ "$DRY_RUN" = 1 ]; then
        echo "+ jq-merge $src hooks -> $dst"
      else
        [ -f "$dst" ] || echo '{}' > "$dst"
        local tmp; tmp="$(mktemp "$HOME/.claude/.settings.XXXXXX")"
        if jq -s '
          def uniqseq: reduce .[] as $x ([]; if any(.[]; . == $x) then . else . + [$x] end);
          .[0] as $dst | .[1] as $src |
          $dst * { hooks:
            ( ($dst.hooks // {}) as $dh | ($src.hooks // {}) as $sh |
              reduce ($sh | keys[]) as $k ($dh;
                .[$k] = (((.[$k] // []) + $sh[$k]) | uniqseq)) )
          }' "$dst" "$src" > "$tmp"; then
          if [ -s "$dst" ]; then cat "$tmp" > "$dst"; rm -f "$tmp"; else mv "$tmp" "$dst"; fi
          echo ">> merged CC hooks into $dst"
        else
          rm -f "$tmp"
          echo "!! CC hooks merge failed (malformed JSON in $dst?) - skipping; fix it and rerun" >&2
        fi
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
      echo ">> installing packages via brew"
      # brew.txt is a plain `brew leaves` list, NOT Brewfile DSL: brew bundle
      # instance_evals the file as Ruby and the parse dies on versioned
      # formulae ('python@3.13' - '@' is a Ruby syntax error), and even plain
      # names raise NoMethodError (only mas/vscode/go/... extensions are
      # tolerated bare). Filter comments + brew install directly, same as
      # functions.d/packages.zsh _pkg_install_brew. Unquoted expansion is
      # intentional word-splitting; names contain no spaces/globs.
      # shellcheck disable=SC2046
      run brew install $(grep -v '^[[:space:]]*#' "$DOTFILES/packages/brew.txt" | grep -v '^[[:space:]]*$')
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
