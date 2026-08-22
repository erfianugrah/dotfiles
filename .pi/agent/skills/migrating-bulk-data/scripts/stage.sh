#!/bin/sh
# stage.sh - parallel rsync pull of shares from a source host to a local dest.
# Pull direction: run on the SURVIVING machine so jobs survive source shutdown.
#
# Usage: stage.sh <src_host> <dst_root> <share_map_file>
#   share_map_file lines: <src_path> <dst_subdir> <label>
#   e.g.:  /mnt/user/photos/ photos photos
#
# NEVER use --ignore-existing for the primary copy of irreplaceable data.
# Re-runs are safe and resume; rsync's default quick-check handles that.

set -eu
SRC_HOST=$1
DST_ROOT=$2
MAP=$3
LOG_DIR=${LOG_DIR:-/root/stage-logs}
mkdir -p "$LOG_DIR"

SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"

while read -r src_path dst_sub label; do
  [ -z "$src_path" ] && continue
  case "$src_path" in \#*) continue;; esac
  (
    echo "=== $label START $(date -Is) ==="
    rsync -a --partial --timeout=300 --contimeout=60 \
      -e "ssh $SSH_OPTS" \
      "root@$SRC_HOST:$src_path" "$DST_ROOT/$dst_sub/" \
      && echo "=== $label DONE $(date -Is) ===" \
      || echo "=== $label FAILED rc=$? $(date -Is) ==="
  ) > "$LOG_DIR/$label.log" 2>&1 &
done < "$MAP"

wait
echo "=== ALL SHARES COMPLETE $(date -Is) ==="
grep -h '=== .* \(DONE\|FAILED\)' "$LOG_DIR"/*.log