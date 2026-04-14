#!/usr/bin/env zsh
# Arch Linux full install test — runs in Docker
# Usage: zsh tests/test-arch.zsh

DOTFILES="${DOTFILES:-$HOME/dotfiles}"
source "${0:A:h}/harness.zsh"

print "═══════════════════════════════════════════"
print " ARCH LINUX TEST"
print "═══════════════════════════════════════════"

# ── Module loading ─────────────────────────────
_t_section "Module loading"
source "$DOTFILES/functions.d/system.zsh"
source "$DOTFILES/functions.d/crypto.zsh"
source "$DOTFILES/functions.d/bitwarden.zsh"
source "$DOTFILES/functions.d/terraform.zsh" 2>/dev/null
source "$DOTFILES/functions.d/misc.zsh"
source "$DOTFILES/functions.d/packages.zsh"
_t_pass "all modules sourced"

# ── Platform detection ─────────────────────────
_t_section "Platform detection"
_t_eq "$_SYS_OS" "linux" "_SYS_OS"
_t_eq "$_SYS_PKG" "pacman" "_SYS_PKG"
_t_eq "$(_pkg_platform)" "arch" "platform"
_is_steamdeck && _t_fail "steamdeck=false" || _t_pass "not steamdeck"

# ── Key functions ──────────────────────────────
_t_section "Functions defined"
for fn in encrypt decrypt encrypt_all decrypt_all encrypt_tf decrypt_tf \
  encrypt_k3s_secret decrypt_k3s_secret _sops_age_public_key _sops_age_private_key \
  bw_serve_start bw_serve_stop bw_serve_status load_bw unset_bw_vars \
  tf_out update_all fix_file_limits install_packages save_packages diff_packages \
  _pkg_install_system _pkg_install_ecosystems _pkg_install_standalone; do
  _t_fn "$fn"
done

# ── Security checks ───────────────────────────
_t_section "Security"
count=$(grep -c "export SOPS_AGE_KEY" "$DOTFILES/functions.d/crypto.zsh")
_t_eq "$count" "0" "S1: no SOPS_AGE_KEY export"
count=$(grep -c "^[[:space:]]*trap " "$DOTFILES/functions.d/terraform.zsh")
_t_eq "$count" "0" "S5: no signal trap"
_t_grep "IdentitiesOnly yes" "$DOTFILES/.ssh/config" "S4: SSH IdentitiesOnly"
_t_grep "^Host \*" "$DOTFILES/.ssh/config" "S4: SSH Host * block"

# ── Crypto key extraction (mock) ──────────────
_t_section "Crypto"
export SOPS_AGE_KEYS="# public key: age1qmj3c2wl5txqp87ln0krc52cf3h0yxdj7nvlr8q9chvkxy5gvmpsd7gxrk
AGE-SECRET-KEY-1QFNEQCLKFASG3HVQRQW5PER2ZQTFWNGM8AXR4CP0PZ7PLQE04RQMA5XY5"
pub=$(_sops_age_public_key)
priv=$(_sops_age_private_key)
_t_prefix "$pub" "age1" "pubkey starts with age1"
_t_prefix "$priv" "AGE-SECRET-KEY-" "privkey starts with AGE-SECRET-KEY-"
_t_eq "${SOPS_AGE_KEY:-}" "" "SOPS_AGE_KEY not leaked"

# ── Phase 1: System install ───────────────────
_t_section "Phase 1: install_packages system"
install_packages system 2>&1

_t_section "Verify system binaries"
for cmd in git bat eza fd fzf jq zoxide btop nvim vim tmux \
           kubectl k9s sops age go lua npm pnpm wget curl rsync ffmpeg; do
  bin="$cmd"
  case "$cmd" in
    ripgrep) bin=rg ;; neovim) bin=nvim ;;
  esac
  _t_cmd "$bin"
done

# ── Phase 2: Ecosystem install ────────────────
_t_section "Phase 2: install_packages ecosystem"

# npm
install_packages npm 2>&1
for cmd in wrangler vercel claude; do
  _t_cmd "$cmd" || true
done

# go
install_packages go 2>&1
for cmd in caddy xcaddy k6 goimports gosec govulncheck; do
  _t_cmd "$cmd" || true
done

# pip
install_packages pip 2>&1
pip list --user 2>/dev/null | grep -qi boto3 && _t_pass "pip: boto3" || _t_fail "pip: boto3"
pip list --user 2>/dev/null | grep -qi pandas && _t_pass "pip: pandas" || _t_fail "pip: pandas"

# cargo (slow — compile from source)
install_packages cargo 2>&1
command -v sqruff &>/dev/null && _t_pass "cargo: sqruff" || _t_skip "cargo: sqruff (slow compile)"

# ── Config values ─────────────────────────────
_t_section "Config"
_t_eq "${ANSIBLE_PLAYBOOK_DIR##*/}" "my-playbooks" "ANSIBLE_PLAYBOOK_DIR"
_t_eq "$BW_SERVE_PORT" "8087" "BW_SERVE_PORT"
_t_eq "$_TF_CACHE_TTL" "300" "_TF_CACHE_TTL"
paru_line=$(grep -n "command -v paru" "$DOTFILES/functions.d/system.zsh" | head -1 | cut -d: -f1)
yay_line=$(grep -n "command -v yay" "$DOTFILES/functions.d/system.zsh" | head -1 | cut -d: -f1)
(( paru_line < yay_line )) && _t_pass "paru before yay ($paru_line<$yay_line)" || _t_fail "paru after yay"

# ── Subcommand dispatch ───────────────────────
_t_section "Dispatch"
install_packages bogus 2>&1 | grep -q Usage && _t_pass "invalid→usage" || _t_fail "invalid→usage"

# ── Gitconfig ─────────────────────────────────
_t_section "Gitconfig"
for key in pull.rebase rerere.enabled fetch.prune; do
  val=$(git config --file "$DOTFILES/.gitconfig" "$key")
  _t_eq "$val" "true" "$key"
done

_t_summary
