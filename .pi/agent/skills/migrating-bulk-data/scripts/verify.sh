#!/bin/sh
# verify.sh - two-pass verification with structured verdict lines.
# P1: size+mtime (fast). P2: -c full content (slow). Both must be CLEAN.
# Fix-forward: runs WITHOUT --dry-run, so differences are repaired in place;
# a non-zero transferred count means re-run until 0.
#
# Usage: verify.sh <src_host> <dst_root> <share_map_file> [--p1-only|--p2-only]
#   share_map_file: same format as stage.sh
#
# Verdict lines (grep for 'VERDICT'):
#   VERDICT <label> P1 PASS transferred=0
#   VERDICT <label> P2 FAIL transferred=3   <- files were repaired; re-run

set -eu
SRC_HOST=$1
DST_ROOT=$2
MAP=$3
MODE=${4:-both}
LOG_DIR=${LOG_DIR:-/root/verify-logs}
mkdir -p "$LOG_DIR"

SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"

run_pass() {
  pass=$1 flags=$2
  while read -r src_path dst_sub label; do
    [ -z "$src_path" ] && continue
    case "$src_path" in \#*) continue;; esac
    log="$LOG_DIR/$label.$pass.log"
    rsync -av --partial $flags --stats \
      -e "ssh $SSH_OPTS" \
      "root@$SRC_HOST:$src_path" "$DST_ROOT/$dst_sub/" > "$log" 2>&1 || true
    count=$(grep 'Number of regular files transferred' "$log" | awk '{print $NF}')
    count=${count:-unknown}
    if [ "$count" = "0" ]; then
      echo "VERDICT $label $pass PASS transferred=0"
    else
      echo "VERDICT $label $pass FAIL transferred=$count (repaired; re-run)"
    fi
  done < "$MAP"
}

case "$MODE" in
  --p1-only) run_pass P1 "" ;;
  --p2-only) run_pass P2 "-c" ;;
  *)         run_pass P1 ""; run_pass P2 "-c" ;;
esac