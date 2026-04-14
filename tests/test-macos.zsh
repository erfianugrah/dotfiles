#!/usr/bin/env zsh
# macOS simulation test — runs in Docker (Ubuntu + Linuxbrew)
# Can't run real macOS in Docker. Tests:
# - brew platform detection when brew is available
# - brew install path / function dispatch
# - All non-platform-specific logic (crypto, config, etc.)

DOTFILES="${DOTFILES:-$HOME/dotfiles}"
source "${0:A:h}/harness.zsh"

print "═══════════════════════════════════════════"
print " macOS SIMULATION TEST (Linuxbrew)"
print "═══════════════════════════════════════════"

# ── Module loading ─────────────────────────────
_t_section "Module loading"
source "$DOTFILES/functions.d/system.zsh"
source "$DOTFILES/functions.d/crypto.zsh"
source "$DOTFILES/functions.d/bitwarden.zsh"
source "$DOTFILES/functions.d/misc.zsh"
source "$DOTFILES/functions.d/packages.zsh"
_t_pass "all modules sourced"

# ── Platform detection ─────────────────────────
# Override _SYS_OS to simulate macOS (can't change uname in container)
_t_section "Platform detection (simulated)"
_SYS_OS="macos"
_SYS_PKG="brew"
_t_eq "$(_pkg_platform)" "brew" "platform=brew when _SYS_OS=macos"

# Reset
_sys_detect

# ── Functions ──────────────────────────────────
_t_section "Functions defined"
for fn in _pkg_install_brew _pkg_save_brew install_packages save_packages diff_packages \
  encrypt decrypt _sops_age_public_key _sops_age_private_key; do
  _t_fn "$fn"
done

# ── Brew install dispatch ─────────────────────
_t_section "Brew install path"
# Test that _pkg_install_brew reads the correct list file
_t_grep "hashicorp/tap/terraform" "$DOTFILES/packages/brew.txt" "terraform uses tap path"
_t_grep "kubernetes-cli" "$DOTFILES/packages/brew.txt" "kubectl→kubernetes-cli"
_t_grep "gh$" "$DOTFILES/packages/brew.txt" "github-cli→gh"
_t_grep "ykman" "$DOTFILES/packages/brew.txt" "yubikey-manager→ykman"
_t_grep "vercel-cli" "$DOTFILES/packages/brew.txt" "vercel→vercel-cli"

# ── Brew cask list ────────────────────────────
_t_section "Brew cask list"
_t_grep "google-chrome" "$DOTFILES/packages/brew-cask.txt" "google-chrome cask"
_t_grep "cloudflare-warp" "$DOTFILES/packages/brew-cask.txt" "cloudflare-warp cask"

# ── Install with brew (actual, if available) ──
_t_section "Brew install (if available)"
if command -v brew &>/dev/null; then
  # Smoke test: install a few packages to verify the mechanism works
  # Full install (107 formulae) would take 10+ min — not practical in CI
  brew install bat fzf jq 2>&1 | tail -3
  _t_cmd "bat"
  _t_cmd "fzf"
  _t_cmd "jq"
else
  _t_skip "brew not available — skipping install test"
fi

# ── Crypto ─────────────────────────────────────
_t_section "Crypto"
export SOPS_AGE_KEYS="# public key: age1qmj3c2wl5txqp87ln0krc52cf3h0yxdj7nvlr8q9chvkxy5gvmpsd7gxrk
AGE-SECRET-KEY-1QFNEQCLKFASG3HVQRQW5PER2ZQTFWNGM8AXR4CP0PZ7PLQE04RQMA5XY5"
pub=$(_sops_age_public_key)
priv=$(_sops_age_private_key)
_t_prefix "$pub" "age1" "pubkey extraction"
_t_prefix "$priv" "AGE-SECRET-KEY-" "privkey extraction"
_t_eq "${SOPS_AGE_KEY:-}" "" "no key leak"

# ── Config ─────────────────────────────────────
_t_section "Config"
_t_grep "rebase = true" "$DOTFILES/.gitconfig" "gitconfig: pull.rebase"
_t_grep "IdentitiesOnly yes" "$DOTFILES/.ssh/config" "SSH: IdentitiesOnly"
_t_grep "USERPROFILE" "$DOTFILES/.wezterm.lua" "wezterm: USERPROFILE fallback"
_t_grep "set -a; source" "$DOTFILES/.zshrc" "pgpasteriser: set -a pattern"
_t_grep ".npm-global" "$DOTFILES/.zshrc" "PATH: .npm-global"

_t_summary
