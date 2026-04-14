#!/usr/bin/env zsh
# Steam Deck (SteamOS) test — runs in Docker with nix
# Tests: detection, nix home-manager path, package install

DOTFILES="${DOTFILES:-$HOME/dotfiles}"
source "${0:A:h}/harness.zsh"

print "═══════════════════════════════════════════"
print " STEAM DECK (SteamOS) TEST"
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
_t_section "Platform detection"
_t_eq "$_SYS_OS" "linux" "_SYS_OS"
_is_steamdeck && _t_pass "detected as steamdeck" || _t_fail "not detected as steamdeck"
_t_eq "$(_pkg_platform)" "nix" "platform=nix"

# ── Key functions ──────────────────────────────
_t_section "Functions defined"
for fn in install_packages save_packages diff_packages \
  _pkg_install_nix encrypt decrypt update_all; do
  _t_fn "$fn"
done

# ── Nix install ────────────────────────────────
_t_section "Phase 1: install_packages system (nix)"
install_packages system 2>&1

_t_section "Verify nix packages"
for cmd in git bat fzf jq rg zoxide nvim vim tmux wget; do
  _t_cmd "$cmd" || true
done

# ── Crypto ─────────────────────────────────────
_t_section "Crypto"
export SOPS_AGE_KEYS="# public key: age1qmj3c2wl5txqp87ln0krc52cf3h0yxdj7nvlr8q9chvkxy5gvmpsd7gxrk
AGE-SECRET-KEY-1QFNEQCLKFASG3HVQRQW5PER2ZQTFWNGM8AXR4CP0PZ7PLQE04RQMA5XY5"
pub=$(_sops_age_public_key)
priv=$(_sops_age_private_key)
_t_prefix "$pub" "age1" "pubkey extraction"
_t_prefix "$priv" "AGE-SECRET-KEY-" "privkey extraction"
_t_eq "${SOPS_AGE_KEY:-}" "" "no key leak"

# ── Session dir fallback ──────────────────────
_t_section "Session dir fallback"
echo "_BW_SESSION_DIR=$_BW_SESSION_DIR"
# In minimal container, XDG_RUNTIME_DIR may not be set
if [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then
  _t_prefix "$_BW_SESSION_DIR" "$XDG_RUNTIME_DIR" "uses XDG_RUNTIME_DIR"
elif [[ -n "${TMPDIR:-}" ]]; then
  _t_eq "$_BW_SESSION_DIR" "$TMPDIR" "uses TMPDIR"
else
  _t_eq "$_BW_SESSION_DIR" "/tmp" "falls to /tmp (expected in container)"
fi

# ── SSH config ─────────────────────────────────
_t_section "SSH config"
_t_grep "IdentitiesOnly yes" "$DOTFILES/.ssh/config" "IdentitiesOnly"
_t_grep "^Host \*" "$DOTFILES/.ssh/config" "Host * block"

_t_summary
