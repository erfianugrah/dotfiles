# ---------------------------------------------------------------------------
# System maintenance — OS-aware (Linux distros + macOS)
# ---------------------------------------------------------------------------

# Detect the current OS and package manager once at source time.
# Sets _SYS_OS (linux|macos) and _SYS_PKG (apt|dnf|pacman|zypper|brew|unknown).
_sys_detect() {
  _SYS_OS="unknown"
  _SYS_PKG="unknown"

  case "$(uname -s)" in
    Linux)
      _SYS_OS="linux"
      if command -v apt &>/dev/null; then
        _SYS_PKG="apt"
      elif command -v dnf &>/dev/null; then
        _SYS_PKG="dnf"
      elif command -v pacman &>/dev/null; then
        _SYS_PKG="pacman"
      elif command -v zypper &>/dev/null; then
        _SYS_PKG="zypper"
      fi
      ;;
    Darwin)
      _SYS_OS="macos"
      _SYS_PKG="brew"  # macOS primarily uses Homebrew
      ;;
  esac
}
_sys_detect

# ---------------------------------------------------------------------------
# fix_file_limits — diagnose and optionally increase file descriptor limits
# ---------------------------------------------------------------------------
# Linux: uses /proc, /etc/security/limits.conf (or systemd if applicable)
# macOS: uses sysctl and launchctl

fix_file_limits() {
  local YELLOW=$'\033[1;33m'
  local GREEN=$'\033[1;32m'
  local RED=$'\033[1;31m'
  local DIM=$'\033[2m'
  local RESET=$'\033[0m'

  # --- Current limits ---
  print "${YELLOW}Current file descriptor limits:${RESET}"
  print "  Soft limit: $(ulimit -Sn)"
  print "  Hard limit: $(ulimit -Hn)"

  # --- Open file count ---
  print "\n${YELLOW}Current open files for your user:${RESET}"
  if command -v lsof &>/dev/null; then
    print "  $(lsof -u "$USER" 2>/dev/null | wc -l) entries"
  else
    print "  ${DIM}lsof not available${RESET}"
  fi

  # --- System-wide stats (OS-specific) ---
  if [[ "$_SYS_OS" == "linux" ]]; then
    print "\n${YELLOW}System-wide file descriptor usage:${RESET}"
    if [[ -f /proc/sys/fs/file-nr ]]; then
      print "  Open: $(cut -f1 /proc/sys/fs/file-nr)"
      print "  Max:  $(cat /proc/sys/fs/file-max)"
    fi
  elif [[ "$_SYS_OS" == "macos" ]]; then
    print "\n${YELLOW}System-wide file descriptor limits:${RESET}"
    print "  kern.maxfiles:        $(sysctl -n kern.maxfiles 2>/dev/null)"
    print "  kern.maxfilesperproc: $(sysctl -n kern.maxfilesperproc 2>/dev/null)"
  fi

  # --- Offer permanent increase ---
  print "\n${YELLOW}Increase file descriptor limits permanently? (y/N)${RESET}"
  read "response?> "

  if [[ "$response" =~ ^[Yy]$ ]]; then
    local target=65536

    if [[ "$_SYS_OS" == "linux" ]]; then
      # limits.conf approach (works on most distros with PAM)
      if [[ -f /etc/security/limits.conf ]]; then
        sudo cp /etc/security/limits.conf /etc/security/limits.conf.backup
        local -a limit_lines=(
          "* soft nofile $target"
          "* hard nofile $target"
          "root soft nofile $target"
          "root hard nofile $target"
        )
        for line in "${limit_lines[@]}"; do
          if ! grep -qxF "$line" /etc/security/limits.conf 2>/dev/null; then
            print "$line" | sudo tee -a /etc/security/limits.conf >/dev/null
          fi
        done
        print "${GREEN}Updated /etc/security/limits.conf${RESET}"
      fi

      # Also set sysctl for system-wide max if writable
      if [[ -w /proc/sys/fs/file-max ]] || command -v sysctl &>/dev/null; then
        local sysctl_line="fs.file-max = $target"
        local sysctl_conf="/etc/sysctl.d/99-file-limits.conf"
        if [[ ! -f "$sysctl_conf" ]] || ! grep -qxF "$sysctl_line" "$sysctl_conf" 2>/dev/null; then
          echo "$sysctl_line" | sudo tee "$sysctl_conf" >/dev/null
          sudo sysctl -p "$sysctl_conf" >/dev/null 2>&1
          print "${GREEN}Updated sysctl (fs.file-max = $target)${RESET}"
        fi
      fi

    elif [[ "$_SYS_OS" == "macos" ]]; then
      # macOS: use launchctl limit and a LaunchDaemon for persistence
      sudo launchctl limit maxfiles "$target" "$target" 2>/dev/null

      local plist="/Library/LaunchDaemons/limit.maxfiles.plist"
      if [[ ! -f "$plist" ]]; then
        sudo tee "$plist" >/dev/null <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>limit.maxfiles</string>
    <key>ProgramArguments</key>
    <array>
      <string>launchctl</string>
      <string>limit</string>
      <string>maxfiles</string>
      <string>${target}</string>
      <string>${target}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>ServiceIPC</key>
    <false/>
  </dict>
</plist>
PLIST
        sudo chown root:wheel "$plist"
        sudo chmod 644 "$plist"
        sudo launchctl load -w "$plist" 2>/dev/null
        print "${GREEN}Created LaunchDaemon for persistent maxfiles${RESET}"
      else
        print "${DIM}LaunchDaemon already exists at $plist${RESET}"
      fi
    fi

    print "${YELLOW}Log out and back in for permanent changes to take effect.${RESET}"
  fi

  # --- Offer temporary session increase ---
  print "\n${YELLOW}Increase limits for current session? (y/N)${RESET}"
  read "response?> "

  if [[ "$response" =~ ^[Yy]$ ]]; then
    ulimit -n 65536 2>/dev/null && \
      print "${GREEN}Session limit set to 65536${RESET}" || \
      print "${RED}Failed — hard limit too low (try the permanent option first)${RESET}"
  fi

  print "\n${YELLOW}Verify with:${RESET}"
  print "  ulimit -Sn   ${DIM}# soft limit${RESET}"
  print "  ulimit -Hn   ${DIM}# hard limit${RESET}"
}

alias fixfiles='fix_file_limits'

# ---------------------------------------------------------------------------
# update_all — update system packages across all detected package managers
# ---------------------------------------------------------------------------
# Runs each available manager in order: system pkg manager, then Homebrew,
# then Flatpak/Snap if present. Non-fatal warnings don't abort.

update_all() {
  local BOLD=$'\033[1m'
  local GREEN=$'\033[32m'
  local RED=$'\033[31m'
  local YELLOW=$'\033[33m'
  local DIM=$'\033[2m'
  local RESET=$'\033[0m'

  local errors=0

  _update_header() { print "\n${BOLD}$1${RESET}\n${DIM}$(printf '%.0s─' {1..40})${RESET}"; }
  _update_ok()     { print "  ${GREEN}done${RESET} $1"; }
  _update_warn()   { print "  ${YELLOW}warn${RESET} $1"; }
  _update_fail()   { print "  ${RED}fail${RESET} $1"; (( errors++ )); }

  print "${BOLD}System update${RESET} ${DIM}($(uname -s), pkg: ${_SYS_PKG})${RESET}"

  # --- apt (Debian/Ubuntu) ---
  if command -v apt &>/dev/null; then
    _update_header "apt"
    sudo apt update -qq         && _update_ok "update"   || _update_fail "update"
    sudo apt upgrade -y -qq     && _update_ok "upgrade"  || _update_fail "upgrade"
    sudo apt autoremove -y -qq  && _update_ok "autoremove" || _update_warn "autoremove"
    sudo apt autoclean -qq      && _update_ok "autoclean"  || _update_warn "autoclean"
  fi

  # --- dnf (Fedora/RHEL) ---
  if command -v dnf &>/dev/null; then
    _update_header "dnf"
    sudo dnf check-update -q 2>/dev/null; local rc=$?
    # dnf check-update returns 100 if updates are available, 0 if none, 1 on error
    if (( rc == 1 )); then
      _update_fail "check-update"
    else
      sudo dnf upgrade -y -q    && _update_ok "upgrade"    || _update_fail "upgrade"
      sudo dnf autoremove -y -q && _update_ok "autoremove" || _update_warn "autoremove"
    fi
  fi

  # --- pacman (Arch/Manjaro) ---
  if command -v pacman &>/dev/null; then
    _update_header "pacman"
    sudo pacman -Syu --noconfirm && _update_ok "sync + upgrade" || _update_fail "sync + upgrade"
    # Clean package cache (keep last 2 versions)
    if command -v paccache &>/dev/null; then
      sudo paccache -r -k2 && _update_ok "cache cleanup" || _update_warn "cache cleanup"
    fi
    # If yay/paru is available, update AUR too
    if command -v yay &>/dev/null; then
      _update_header "yay (AUR)"
      yay -Sua --noconfirm && _update_ok "AUR upgrade" || _update_warn "AUR upgrade"
    elif command -v paru &>/dev/null; then
      _update_header "paru (AUR)"
      paru -Sua --noconfirm && _update_ok "AUR upgrade" || _update_warn "AUR upgrade"
    fi
  fi

  # --- zypper (openSUSE) ---
  if command -v zypper &>/dev/null; then
    _update_header "zypper"
    sudo zypper refresh -q      && _update_ok "refresh"  || _update_fail "refresh"
    sudo zypper update -y -q    && _update_ok "update"   || _update_fail "update"
  fi

  # --- Homebrew (macOS or Linuxbrew) ---
  if command -v brew &>/dev/null; then
    _update_header "brew"
    brew update -q              && _update_ok "update"    || _update_fail "update"
    brew upgrade -q             && _update_ok "upgrade"   || _update_fail "upgrade"
    brew cleanup -q             && _update_ok "cleanup"   || _update_warn "cleanup"
    brew doctor 2>/dev/null     && _update_ok "doctor"    || _update_warn "doctor reported issues"
  fi

  # --- Flatpak ---
  if command -v flatpak &>/dev/null; then
    _update_header "flatpak"
    flatpak update -y --noninteractive && _update_ok "update" || _update_warn "update"
    flatpak uninstall --unused -y 2>/dev/null && _update_ok "cleanup unused" || true
  fi

  # --- Snap ---
  if command -v snap &>/dev/null; then
    _update_header "snap"
    sudo snap refresh && _update_ok "refresh" || _update_warn "refresh"
  fi

  # --- Summary ---
  print "\n${DIM}$(printf '%.0s─' {1..40})${RESET}"
  if (( errors == 0 )); then
    print "${GREEN}${BOLD}All updates completed successfully${RESET}"
  else
    print "${YELLOW}${BOLD}Completed with $errors error(s)${RESET}"
  fi

  unfunction _update_header _update_ok _update_warn _update_fail 2>/dev/null
}

alias upall='update_all'
