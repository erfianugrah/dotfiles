#!/usr/bin/env zsh
# Shared test harness — source this from each platform test
# Usage: source harness.zsh

typeset -gi _T_PASS=0 _T_FAIL=0 _T_SKIP=0

_t_pass() { (( _T_PASS++ )); print "  [PASS] $1"; }
_t_fail() { (( _T_FAIL++ )); print "  [FAIL] $1"; }
_t_skip() { (( _T_SKIP++ )); print "  [SKIP] $1"; }

# Assert command exists
_t_cmd() {
  command -v "$1" &>/dev/null && _t_pass "$1" || _t_fail "$1 not found"
}

# Assert string equals
_t_eq() {
  [[ "$1" == "$2" ]] && _t_pass "$3" || _t_fail "$3 (got: $1, want: $2)"
}

# Assert string starts with
_t_prefix() {
  [[ "$1" == "$2"* ]] && _t_pass "$3" || _t_fail "$3 (got: $1, want prefix: $2)"
}

# Assert file contains pattern
_t_grep() {
  grep -q "$1" "$2" 2>/dev/null && _t_pass "$3" || _t_fail "$3"
}

# Assert function exists
_t_fn() {
  whence "$1" &>/dev/null && _t_pass "fn: $1" || _t_fail "fn: $1 missing"
}

# Section header
_t_section() { print "\n── $1 ──"; }

# Final summary — returns 0 if all pass, 1 if any fail
_t_summary() {
  print "\n══════════════════════════════════════"
  if (( _T_FAIL == 0 )); then
    print " ALL PASSED: ${_T_PASS} pass, ${_T_SKIP} skip"
  else
    print " FAILURES: ${_T_PASS} pass, ${_T_FAIL} fail, ${_T_SKIP} skip"
  fi
  print "══════════════════════════════════════"
  return $(( _T_FAIL > 0 ))
}
