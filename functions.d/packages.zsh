# ---------------------------------------------------------------------------
# Package management — multi-OS install/save/diff
# ---------------------------------------------------------------------------
# Platforms:
#   macOS       → brew (formulae + casks)
#   Arch Linux  → pacman (native) + paru (AUR)
#   Steam Deck  → nix (home-manager + flakes)
# ---------------------------------------------------------------------------

_DOTFILES_DIR="${0:A:h:h}"
_PKG_DIR="${_DOTFILES_DIR}/packages"

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

_is_steamdeck() {
  [[ -f /etc/steamos-release ]] || \
    [[ "$(cat /etc/hostname 2>/dev/null)" == "steamdeck" ]] || \
    [[ "${USER:-}" == "deck" && -d /home/deck ]]
}

_pkg_platform() {
  if [[ "$_SYS_OS" == "macos" ]]; then
    echo "brew"
  elif _is_steamdeck; then
    echo "nix"
  elif [[ "$_SYS_PKG" == "pacman" ]]; then
    echo "arch"
  else
    echo "unknown"
  fi
}

# ---------------------------------------------------------------------------
# install_packages — install from saved lists for current platform
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# install_packages — three-phase hierarchical install
# ---------------------------------------------------------------------------
#   Phase 1: System (pacman+paru / brew / nix) — installs runtimes
#   Phase 2: Ecosystems (npm, go, cargo, pip, deno) — needs runtimes from phase 1
#   Phase 3: Standalone tools (~/.local/bin) — binary downloads, go install, etc.
#
# Usage:
#   install_packages             # all phases
#   install_packages system      # phase 1 only
#   install_packages ecosystem   # phase 2 only
#   install_packages standalone  # phase 3 only
#   install_packages npm         # single ecosystem
#   install_packages go|cargo|pip|deno
# ---------------------------------------------------------------------------

install_packages() {
  local phase="${1:-all}"
  local platform
  platform=$(_pkg_platform)

  local BOLD=$'\033[1m' GREEN=$'\033[32m' YELLOW=$'\033[33m'
  local RED=$'\033[31m' DIM=$'\033[2m' RESET=$'\033[0m'

  _pkg_phase_header() { print "\n${BOLD}── $1 ──${RESET}\n"; }

  case "$phase" in
    all)
      print "${BOLD}Installing packages${RESET} ${DIM}(platform: ${platform})${RESET}"

      _pkg_phase_header "Phase 1: System packages"
      _pkg_install_system "$platform" || return 1

      _pkg_phase_header "Phase 2: Language ecosystems"
      _pkg_install_ecosystems

      _pkg_phase_header "Phase 3: Standalone tools"
      _pkg_install_standalone

      print "\n${GREEN}${BOLD}All phases complete${RESET}"
      ;;
    system)
      _pkg_phase_header "System packages (${platform})"
      _pkg_install_system "$platform"
      ;;
    ecosystem|ecosystems)
      _pkg_phase_header "Language ecosystems"
      _pkg_install_ecosystems
      ;;
    standalone)
      _pkg_phase_header "Standalone tools"
      _pkg_install_standalone
      ;;
    npm|go|cargo|pip|deno)
      _pkg_install_"$phase"
      ;;
    *)
      print "Usage: install_packages [all|system|ecosystem|standalone|npm|go|cargo|pip|deno]" >&2
      return 1
      ;;
  esac

  unfunction _pkg_phase_header 2>/dev/null
}

_pkg_install_system() {
  local platform="$1"
  case "$platform" in
    brew)  _pkg_install_brew ;;
    arch)  _pkg_install_arch ;;
    nix)   _pkg_install_nix ;;
    *)
      print "Unsupported platform: ${_SYS_OS} / ${_SYS_PKG}" >&2
      return 1
      ;;
  esac
}

_pkg_install_ecosystems() {
  _pkg_install_npm
  _pkg_install_go
  _pkg_install_cargo
  _pkg_install_pip
  _pkg_install_deno
}

_pkg_install_standalone() {
  local list="${_PKG_DIR}/standalone.txt"
  [[ -f "$list" ]] || return 0

  local -a entries=("${(@f)$(_pkg_read_list "$list")}")
  (( ${#entries[@]} )) || return 0

  local BOLD=$'\033[1m' GREEN=$'\033[32m' YELLOW=$'\033[33m'
  local DIM=$'\033[2m' RESET=$'\033[0m'

  print "Installing ${#entries[@]} standalone tools..."
  mkdir -p "$HOME/.local/bin"

  for entry in "${entries[@]}"; do
    local name="${entry%%=*}"
    local cmd="${entry#*=}"

    if command -v "$name" &>/dev/null; then
      print "  ${DIM}${name}: already installed${RESET}"
      continue
    fi

    print "  ${YELLOW}${name}${RESET}: ${DIM}${cmd}${RESET}"
    eval "$cmd" 2>&1 | sed 's/^/    /' || print "  WARN: failed ${name}" >&2
  done

  print "${GREEN}standalone install complete${RESET}"
}

_pkg_install_brew() {
  local list="${_PKG_DIR}/brew.txt"
  local cask_list="${_PKG_DIR}/brew-cask.txt"

  if [[ ! -f "$list" ]]; then
    print "Error: $list not found" >&2; return 1
  fi

  if ! command -v brew &>/dev/null; then
    print "Homebrew not installed. Install from https://brew.sh" >&2
    return 1
  fi

  print "Updating Homebrew..."
  brew update -q

  # Install ONE AT A TIME, not `brew install a b c`: the batch form resolves
  # every name up front and aborts on the first bad one (unknown/renamed
  # formula, or a link conflict mid-run), leaving the rest uninstalled. Per-item
  # contains the blast radius - skip installed, keep going past failures, and
  # flag them loudly at the end.
  local f
  local -a failed=()

  # Filter comments and blank lines
  local -a formulae=("${(@f)$(grep -v '^\s*#' "$list" | grep -v '^\s*$')}")
  print "Installing ${#formulae[@]} formulae (one at a time; failures flagged)..."
  for f in "${formulae[@]}"; do
    brew list --versions "$f" &>/dev/null && continue   # already installed
    brew install "$f" || { print -u2 "!! brew formula failed: $f"; failed+=("$f") }
  done

  if [[ -f "$cask_list" ]]; then
    local -a casks=("${(@f)$(grep -v '^\s*#' "$cask_list" | grep -v '^\s*$')}")
    if (( ${#casks[@]} )); then
      print "\nInstalling ${#casks[@]} casks (one at a time; failures flagged)..."
      for f in "${casks[@]}"; do
        brew list --cask --versions "$f" &>/dev/null && continue
        brew install --cask "$f" || { print -u2 "!! brew cask failed: $f"; failed+=("$f") }
      done
    fi
  fi

  if (( ${#failed[@]} )); then
    print -u2 "\n${RED:-}!! ${#failed[@]} brew item(s) FAILED: ${failed[*]}${RESET:-}"
    return 1
  fi
  print "\n${GREEN}brew install complete${RESET}"
}

_pkg_install_arch() {
  local repo_list="${_PKG_DIR}/arch-repo.txt"
  local aur_list="${_PKG_DIR}/arch-aur.txt"

  if [[ ! -f "$repo_list" ]]; then
    print "Error: $repo_list not found" >&2; return 1
  fi

  # Per-package (not one `pacman -S a b c` transaction): a single name that is
  # not in the repos makes pacman abort with "target not found" and install
  # nothing. --needed still skips already-installed packages. Flag failures.
  local pkg; local -a failed=()
  local -a repo_pkgs=("${(@f)$(grep -v '^\s*#' "$repo_list" | grep -v '^\s*$')}")
  print "Installing ${#repo_pkgs[@]} pacman packages (one at a time; failures flagged)..."
  for pkg in "${repo_pkgs[@]}"; do
    sudo pacman -S --needed --noconfirm "$pkg" || { print -u2 "!! pacman failed: $pkg"; failed+=("$pkg") }
  done

  if [[ -f "$aur_list" ]]; then
    local -a aur_pkgs=("${(@f)$(grep -v '^\s*#' "$aur_list" | grep -v '^\s*$')}")
    if (( ${#aur_pkgs[@]} )); then
      if command -v paru &>/dev/null; then
        print "\nInstalling ${#aur_pkgs[@]} AUR packages via paru (one at a time; failures flagged)..."
        for pkg in "${aur_pkgs[@]}"; do
          paru -S --needed --noconfirm "$pkg" || { print -u2 "!! paru failed: $pkg"; failed+=("$pkg") }
        done
      else
        print "Warning: paru not on PATH. Install with: sudo pacman -S paru-bin (or build from AUR). Skipping AUR packages." >&2
      fi
    fi
  fi

  if (( ${#failed[@]} )); then
    print -u2 "${RED:-}!! ${#failed[@]} arch package(s) FAILED: ${failed[*]}${RESET:-}"; return 1
  fi
  print "\n${GREEN}arch install complete${RESET}"
}

_pkg_install_nix() {
  local nix_dir="${_PKG_DIR}/nix"

  if [[ ! -f "${nix_dir}/flake.nix" ]]; then
    print "Error: ${nix_dir}/flake.nix not found" >&2; return 1
  fi

  if ! command -v nix &>/dev/null; then
    print "Nix not installed. Install from https://install.determinate.systems/nix" >&2
    return 1
  fi

  local hm_dir="$HOME/.config/home-manager"

  # Link or copy flake into home-manager config dir
  if [[ ! -d "$hm_dir" ]]; then
    mkdir -p "$hm_dir"
  fi

  # Copy flake files (symlinks break flake git detection)
  cp -f "${nix_dir}/flake.nix" "${hm_dir}/flake.nix"
  cp -f "${nix_dir}/home.nix" "${hm_dir}/home.nix"

  print "Applying home-manager config..."
  (
    cd "$hm_dir"
    # Ensure flake.lock exists / is tracked
    [[ -d .git ]] || git init -q
    git add -A
    if command -v home-manager &>/dev/null; then
      home-manager switch --flake ".#deck"
    else
      nix run home-manager/master -- switch --flake ".#deck"
    fi
  )

  print "\n${GREEN}nix install complete${RESET}"
}

# ---------------------------------------------------------------------------
# save_packages — snapshot current packages to lists
# ---------------------------------------------------------------------------

save_packages() {
  local phase="${1:-all}"
  local platform
  platform=$(_pkg_platform)

  local BOLD=$'\033[1m' GREEN=$'\033[32m' DIM=$'\033[2m' RESET=$'\033[0m'

  print "${BOLD}Saving package lists${RESET} ${DIM}(platform: ${platform})${RESET}\n"

  if [[ "$phase" == "all" || "$phase" == "system" ]]; then
    case "$platform" in
      brew)  _pkg_save_brew ;;
      arch)  _pkg_save_arch ;;
      nix)   print "Nix packages managed declaratively in ${_PKG_DIR}/nix/home.nix" ;;
      *)     print "Unsupported platform" >&2; return 1 ;;
    esac
  fi

  if [[ "$phase" == "all" || "$phase" == "ecosystem" || "$phase" == "ecosystems" ]]; then
    _pkg_save_npm
    _pkg_save_go
    _pkg_save_cargo
    _pkg_save_pip
    _pkg_save_deno
  fi

  print "\n${GREEN}${BOLD}Package lists saved${RESET}"
}

_pkg_save_brew() {
  local list="${_PKG_DIR}/brew.txt"
  local cask_list="${_PKG_DIR}/brew-cask.txt"

  {
    echo "# macOS Homebrew formulae"
    echo "# Generated by: save_packages ($(date -u +%Y-%m-%d))"
    echo "# Update with: save_packages"
    echo "# NOTE: Tapped formulae (e.g. hashicorp/tap/terraform) may save as short"
    echo "# names. Verify tapped packages after saving and use full tap paths."
    brew leaves | sort
  } > "$list"

  {
    echo "# macOS Homebrew casks (GUI apps)"
    echo "# Generated by: save_packages ($(date -u +%Y-%m-%d))"
    echo "# Update with: save_packages"
    brew list --cask | sort
  } > "$cask_list"

  print "${GREEN}Saved${RESET} $(grep -cv '^\s*#' "$list") formulae → $list"
  print "${GREEN}Saved${RESET} $(grep -cv '^\s*#' "$cask_list") casks → $cask_list"
}

_pkg_save_arch() {
  local repo_list="${_PKG_DIR}/arch-repo.txt"
  local aur_list="${_PKG_DIR}/arch-aur.txt"

  {
    echo "# Arch Linux native repo packages (pacman)"
    echo "# Generated by: save_packages ($(date -u +%Y-%m-%d))"
    echo "# Update with: save_packages"
    pacman -Qqen | sort
  } > "$repo_list"

  {
    echo "# Arch Linux AUR packages (paru)"
    echo "# Generated by: save_packages ($(date -u +%Y-%m-%d))"
    echo "# Update with: save_packages"
    # Strip -debug variants — they're auto-pulled alongside their parent package
    pacman -Qqem | grep -v '\-debug$' | sort
  } > "$aur_list"

  print "${GREEN}Saved${RESET} $(grep -cv '^\s*#' "$repo_list") repo pkgs → $repo_list"
  print "${GREEN}Saved${RESET} $(grep -cv '^\s*#' "$aur_list") AUR pkgs → $aur_list"
}

# ---------------------------------------------------------------------------
# Cross-platform ecosystem installers
# ---------------------------------------------------------------------------

_pkg_read_list() {
  # Read a package list file, stripping comments, blanks, and inline comments
  grep -v '^\s*#' "$1" | grep -v '^\s*$' | sed 's/\s*#.*//'
}

_pkg_install_npm() {
  local list="${_PKG_DIR}/npm-globals.txt"
  [[ -f "$list" ]] || return 0
  command -v npm &>/dev/null || return 0

  local -a pkgs=("${(@f)$(_pkg_read_list "$list")}")
  (( ${#pkgs[@]} )) || return 0

  # Never install npm globals into system dirs (/usr/lib/node_modules).
  # System npm packages (pnpm, yarn) are owned by pacman/brew. (bitwarden-cli
  # is npm-pinned to 2026.6.0 instead - see npm-globals.txt.)
  # User npm globals go to ~/.npm-global to avoid conflicts on pacman -Syu.
  local npm_prefix
  npm_prefix=$(npm config get prefix 2>/dev/null)
  if [[ "$npm_prefix" == /usr* ]]; then
    local user_prefix="$HOME/.npm-global"
    print "  Redirecting npm globals to ${user_prefix} (system prefix is ${npm_prefix})"
    mkdir -p "$user_prefix"
    npm config set prefix "$user_prefix"
    # Ensure it's in PATH for this session
    export PATH="${user_prefix}/bin:$PATH"
  fi

  # Per-package (not `npm i -g a b c`): one bad/unpublished package must not
  # abort the rest. Flag failures and return non-zero.
  print "\n${BOLD:-}Installing ${#pkgs[@]} npm globals (one at a time; failures flagged)...${RESET:-}"
  local pkg; local -a failed=()
  for pkg in "${pkgs[@]}"; do
    npm install -g "$pkg" || { print -u2 "!! npm global failed: $pkg"; failed+=("$pkg") }
  done
  if (( ${#failed[@]} )); then
    print -u2 "${RED:-}!! ${#failed[@]} npm global(s) FAILED: ${failed[*]}${RESET:-}"; return 1
  fi
}

_pkg_install_go() {
  local list="${_PKG_DIR}/go-tools.txt"
  [[ -f "$list" ]] || return 0
  command -v go &>/dev/null || return 0

  local -a tools=("${(@f)$(_pkg_read_list "$list")}")
  (( ${#tools[@]} )) || return 0

  print "\n${BOLD:-}Installing ${#tools[@]} go tools...${RESET:-}"
  local tool; local -a failed=()
  for tool in "${tools[@]}"; do
    print "  go install ${tool}@latest"
    go install "${tool}@latest" 2>&1 || { print -u2 "!! go tool failed: ${tool}"; failed+=("$tool") }
  done
  if (( ${#failed[@]} )); then
    print -u2 "${RED:-}!! ${#failed[@]} go tool(s) FAILED: ${failed[*]}${RESET:-}"; return 1
  fi
}

_pkg_install_cargo() {
  local list="${_PKG_DIR}/cargo-tools.txt"
  [[ -f "$list" ]] || return 0
  command -v cargo &>/dev/null || return 0

  local -a crates=("${(@f)$(_pkg_read_list "$list")}")
  (( ${#crates[@]} )) || return 0

  # Per-crate: a single crate that fails to compile must not abort the rest.
  print "\n${BOLD:-}Installing ${#crates[@]} cargo crates (one at a time; failures flagged)...${RESET:-}"
  local crate; local -a failed=()
  for crate in "${crates[@]}"; do
    cargo install "$crate" || { print -u2 "!! cargo crate failed: $crate"; failed+=("$crate") }
  done
  if (( ${#failed[@]} )); then
    print -u2 "${RED:-}!! ${#failed[@]} cargo crate(s) FAILED: ${failed[*]}${RESET:-}"; return 1
  fi
}

_pkg_install_pip() {
  local list="${_PKG_DIR}/pip-requirements.txt"
  [[ -f "$list" ]] || return 0
  command -v pip &>/dev/null || command -v pip3 &>/dev/null || return 0

  local pip_cmd="pip"
  command -v pip &>/dev/null || pip_cmd="pip3"
  local -a reqs=("${(@f)$(_pkg_read_list "$list")}")
  (( ${#reqs[@]} )) || return 0
  # --break-system-packages needed on Arch/Fedora (PEP 668) for --user installs.
  # Safe: --user puts packages in ~/.local/lib/python*/site-packages/, not system dirs.
  # Per-requirement (not `-r file`): pip aborts the whole file on the first bad
  # requirement, so one typo would install nothing. Install each; flag failures.
  print "\n${BOLD:-}Installing ${#reqs[@]} pip user packages (one at a time; failures flagged)...${RESET:-}"
  local req; local -a failed=()
  for req in "${reqs[@]}"; do
    $pip_cmd install --user --break-system-packages "$req" || { print -u2 "!! pip package failed: $req"; failed+=("$req") }
  done
  if (( ${#failed[@]} )); then
    print -u2 "${RED:-}!! ${#failed[@]} pip package(s) FAILED: ${failed[*]}${RESET:-}"; return 1
  fi
}

_pkg_install_deno() {
  local list="${_PKG_DIR}/deno-tools.txt"
  [[ -f "$list" ]] || return 0
  command -v deno &>/dev/null || return 0

  local -a entries=("${(@f)$(_pkg_read_list "$list")}")
  (( ${#entries[@]} )) || return 0

  print "\n${BOLD:-}Installing ${#entries[@]} deno tools...${RESET:-}"
  local entry name specifier; local -a failed=()
  for entry in "${entries[@]}"; do
    name="${entry%%=*}"
    specifier="${entry#*=}"
    print "  deno install ${name}"
    deno install -gArf --name "$name" "$specifier" 2>&1 || { print -u2 "!! deno tool failed: ${name}"; failed+=("$name") }
  done
  if (( ${#failed[@]} )); then
    print -u2 "${RED:-}!! ${#failed[@]} deno tool(s) FAILED: ${failed[*]}${RESET:-}"; return 1
  fi
}

# ---------------------------------------------------------------------------
# Cross-platform ecosystem savers
# ---------------------------------------------------------------------------

_pkg_save_npm() {
  local list="${_PKG_DIR}/npm-globals.txt"
  command -v npm &>/dev/null || return 0

  local GREEN=$'\033[32m' RESET=$'\033[0m'
  {
    echo "# npm global packages (cross-platform)"
    echo "# Generated by: save_packages ($(date -u +%Y-%m-%d))"
    echo "# Update with: save_packages"
    # Filter npm builtins and packages managed by system pkg manager (pacman/brew)
    npm list -g --depth=0 --json 2>/dev/null \
      | jq -r '.dependencies | keys[]' \
      | grep -vE '^(npm|node-gyp|nopt|semver|corepack|@bitwarden/cli|pnpm|yarn)$' \
      | sort
  } > "$list"
  print "${GREEN}Saved${RESET} $(grep -cv '^\s*#' "$list") npm globals → $list"
}

_pkg_save_go() {
  local list="${_PKG_DIR}/go-tools.txt"
  command -v go &>/dev/null || return 0
  [[ -d "$HOME/go/bin" ]] || return 0

  local GREEN=$'\033[32m' RESET=$'\033[0m'
  {
    echo "# Go tools (cross-platform, installed via go install)"
    echo "# Generated by: save_packages ($(date -u +%Y-%m-%d))"
    echo "# Update with: save_packages"
    local mod
    for bin in ~/go/bin/*; do
      [[ -f "$bin" ]] || continue
      mod=$(go version -m "$bin" 2>/dev/null | grep '^\s*path' | awk '{print $2}')
      [[ -n "$mod" ]] && echo "$mod"
    done | sort
  } > "$list"
  print "${GREEN}Saved${RESET} $(grep -cv '^\s*#' "$list") go tools → $list"
}

_pkg_save_cargo() {
  local list="${_PKG_DIR}/cargo-tools.txt"
  command -v cargo &>/dev/null || return 0

  local GREEN=$'\033[32m' RESET=$'\033[0m'
  {
    echo "# Cargo crates (cross-platform, installed via cargo install)"
    echo "# Generated by: save_packages ($(date -u +%Y-%m-%d))"
    echo "# Update with: save_packages"
    cargo install --list 2>/dev/null | grep -E '^[a-z]' | awk '{print $1}' | sort
  } > "$list"
  print "${GREEN}Saved${RESET} $(grep -cv '^\s*#' "$list") cargo crates → $list"
}

_pkg_save_pip() {
  local list="${_PKG_DIR}/pip-requirements.txt"
  local pip_cmd="pip"
  command -v pip &>/dev/null || pip_cmd="pip3"
  command -v $pip_cmd &>/dev/null || return 0

  local GREEN=$'\033[32m' RESET=$'\033[0m'
  {
    echo "# pip user packages (cross-platform)"
    echo "# Generated by: save_packages ($(date -u +%Y-%m-%d))"
    echo "# Update with: save_packages"
    $pip_cmd list --user --not-required --format=freeze 2>/dev/null \
      | cut -d= -f1 | sort
  } > "$list"
  print "${GREEN}Saved${RESET} $(grep -cv '^\s*#' "$list") pip packages → $list"
}

_pkg_save_deno() {
  local list="${_PKG_DIR}/deno-tools.txt"
  command -v deno &>/dev/null || return 0
  [[ -d "$HOME/.deno/bin" ]] || return 0

  # Read existing specifiers so we don't lose manually-set install URLs
  typeset -A existing_specifiers
  if [[ -f "$list" ]]; then
    while IFS= read -r line; do
      [[ "$line" == \#* || -z "$line" ]] && continue
      local k="${line%%=*}" v="${line#*=}"
      [[ -n "$v" ]] && existing_specifiers[$k]="$v"
    done < "$list"
  fi

  local GREEN=$'\033[32m' RESET=$'\033[0m'
  {
    echo "# Deno tools (cross-platform)"
    echo "# Generated by: save_packages ($(date -u +%Y-%m-%d))"
    echo "# Update with: save_packages"
    echo "# format: name=install_specifier"
    local name
    for bin in ~/.deno/bin/*; do
      [[ -f "$bin" && -x "$bin" ]] || continue
      name=$(basename "$bin")
      [[ "$name" == "deno" ]] && continue
      if [[ -n "${existing_specifiers[$name]}" ]]; then
        echo "${name}=${existing_specifiers[$name]}"
      else
        echo "# TODO: add install specifier for ${name}"
        echo "${name}="
      fi
    done
  } > "$list"
  print "${GREEN}Saved${RESET} deno tools → $list"
}

# ---------------------------------------------------------------------------
# diff_packages — show what's installed vs saved lists
# ---------------------------------------------------------------------------

diff_packages() {
  local platform
  platform=$(_pkg_platform)

  local BOLD=$'\033[1m' GREEN=$'\033[32m' RED=$'\033[31m'
  local YELLOW=$'\033[33m' DIM=$'\033[2m' RESET=$'\033[0m'

  # Track totals across all categories
  typeset -g _pkg_diff_total=0 _pkg_diff_drift=0

  print "${BOLD}Package diff${RESET} ${DIM}(platform: ${platform})${RESET}\n"

  case "$platform" in
    brew)
      _pkg_diff "brew leaves" "${_PKG_DIR}/brew.txt" "formulae"
      _pkg_diff "brew list --cask" "${_PKG_DIR}/brew-cask.txt" "casks"
      ;;
    arch)
      _pkg_diff "pacman -Qqen" "${_PKG_DIR}/arch-repo.txt" "repo"
      _pkg_diff "pacman -Qqem" "${_PKG_DIR}/arch-aur.txt" "AUR"
      ;;
    nix)
      print "  nix: ${DIM}managed declaratively — diff with git${RESET}"
      (( _pkg_diff_total++ ))
      ;;
    *)
      print "Unsupported platform" >&2; return 1 ;;
  esac

  # Cross-platform ecosystems
  print ""
  if command -v npm &>/dev/null && [[ -f "${_PKG_DIR}/npm-globals.txt" ]]; then
    _pkg_diff "npm list -g --depth=0 --json 2>/dev/null | jq -r '.dependencies | keys[]' | grep -vE '^(npm|node-gyp|nopt|semver|corepack|@bitwarden/cli|pnpm|yarn)$'" \
      "${_PKG_DIR}/npm-globals.txt" "npm"
  fi
  if command -v go &>/dev/null && [[ -d "$HOME/go/bin" ]] && [[ -f "${_PKG_DIR}/go-tools.txt" ]]; then
    _pkg_diff "_pkg_go_installed" "${_PKG_DIR}/go-tools.txt" "go"
  fi
  if command -v cargo &>/dev/null && [[ -f "${_PKG_DIR}/cargo-tools.txt" ]]; then
    _pkg_diff "cargo install --list 2>/dev/null | grep -E '^[a-z]' | awk '{print \$1}'" \
      "${_PKG_DIR}/cargo-tools.txt" "cargo"
  fi
  if command -v pip &>/dev/null && [[ -f "${_PKG_DIR}/pip-requirements.txt" ]]; then
    _pkg_diff "pip list --user --not-required --format=freeze 2>/dev/null | cut -d= -f1" \
      "${_PKG_DIR}/pip-requirements.txt" "pip"
  fi

  # Summary
  print ""
  if (( _pkg_diff_drift == 0 )); then
    print "${GREEN}${BOLD}All ${_pkg_diff_total} categories in sync. Zero drift.${RESET}"
  else
    print "${YELLOW}${BOLD}${_pkg_diff_drift}/${_pkg_diff_total} categories have drift. Run save_packages to update lists or install_packages to sync.${RESET}"
  fi

  unset _pkg_diff_total _pkg_diff_drift
}

# Helper: list installed go module paths for diff
_pkg_go_installed() {
  for bin in ~/go/bin/*; do
    [[ -f "$bin" ]] || continue
    go version -m "$bin" 2>/dev/null | grep '^\s*path' | awk '{print $2}'
  done | sort
}

_pkg_diff() {
  local cmd="$1" list_file="$2" label="$3"
  local GREEN=$'\033[32m' RED=$'\033[31m' DIM=$'\033[2m' RESET=$'\033[0m'

  (( _pkg_diff_total++ ))

  if [[ ! -f "$list_file" ]]; then
    print "  ${label}: ${DIM}no saved list${RESET}" >&2
    return
  fi

  local current_list saved_list
  current_list=$(eval "$cmd" | sort)
  saved_list=$(grep -v '^\s*#' "$list_file" | grep -v '^\s*$' | sort)

  local added removed
  added=$(comm -23 <(echo "$current_list") <(echo "$saved_list"))
  removed=$(comm -13 <(echo "$current_list") <(echo "$saved_list"))

  if [[ -z "$added" && -z "$removed" ]]; then
    print "  ${label}: ${DIM}in sync${RESET}"
    return
  fi

  (( _pkg_diff_drift++ ))

  if [[ -n "$added" ]]; then
    print "  ${label} ${GREEN}+installed (not in list):${RESET}"
    echo "$added" | while read -r pkg; do print "    ${GREEN}+ ${pkg}${RESET}"; done
  fi
  if [[ -n "$removed" ]]; then
    print "  ${label} ${RED}-missing (in list, not installed):${RESET}"
    echo "$removed" | while read -r pkg; do print "    ${RED}- ${pkg}${RESET}"; done
  fi
}
