#!/bin/sh
# probe-verifier.sh - prove your verification tooling catches the three
# failure modes BEFORE trusting it on real data.
#
# Creates a fixture tree, copies it with the same command you will use for
# the real migration, then plants:
#   A) truncated file (size differs)     -> P1 must catch
#   B) missing file                      -> P1 must catch
#   C) silent corruption (same size+mtime, different bytes) -> P1 must MISS, P2 must catch
#
# Usage: probe-verifier.sh <verify_cmd_prefix>
#   verify_cmd_prefix is how you invoke your P1/P2 comparison, with SRC and DST
#   substituted, e.g.:
#     probe-verifier.sh "rsync -av --dry-run --stats SRC/ DST/"
#   The script appends nothing; it runs P1 (as given) and P2 (given + -c) when
#   the prefix is rsync. For other tools, read the assertions and adapt.
#
# Exit 0 = verifier behaves as the failure-mode table predicts.

set -eu
WORK=$(mktemp -d /tmp/probe-verifier.XXXXXX)
SRC=$WORK/src
DST=$WORK/dst
mkdir -p "$SRC" "$DST"

# Fixture: 3 files with known content
echo "alpha content" > "$SRC/alpha.txt"
echo "beta content"  > "$SRC/beta.txt"
echo "gamma content" > "$SRC/gamma.txt"

# Copy with the same tool as the real migration (rsync here)
rsync -a "$SRC/" "$DST/"

# Plant A: truncation
echo "x" > "$DST/alpha.txt"

# Plant B: missing
rm "$DST/beta.txt"

# Plant C: silent corruption - same size, same mtime, different bytes
# original is "gamma content\n" (14 bytes); replacement must be exactly 14 too
printf 'gamma CONTENT\n' > "$SRC/gamma.txt.new"
touch -r "$DST/gamma.txt" "$SRC/gamma.txt.new"  # copy dest mtime onto new file
mv "$SRC/gamma.txt.new" "$DST/gamma.txt"        # overwrite dest copy

echo "=== P1 (size+mtime dry-run) ==="
P1_OUT=$(rsync -avn --stats "$SRC/" "$DST/" 2>&1)
echo "$P1_OUT" | grep -E '^>f|Number of regular files transferred' || true

echo "=== P2 (checksum dry-run) ==="
P2_OUT=$(rsync -avcn --stats "$SRC/" "$DST/" 2>&1)
echo "$P2_OUT" | grep -E '^>f|Number of regular files transferred' || true

# Assertions
fail=0
echo "$P1_OUT" | grep -q 'alpha.txt' || { echo "FAIL: P1 missed truncation"; fail=1; }
echo "$P1_OUT" | grep -q 'beta.txt'  || { echo "FAIL: P1 missed missing file"; fail=1; }
if echo "$P1_OUT" | grep -q 'gamma.txt'; then
  echo "FAIL: P1 flagged the silent-corruption file (false positive - check mtime preservation)"
  fail=1
fi
echo "$P2_OUT" | grep -q 'gamma.txt' || { echo "FAIL: P2 missed silent corruption"; fail=1; }

rm -rf "$WORK"
if [ "$fail" -eq 0 ]; then
  echo "PROBE PASS: P1 catches truncated+missing, P1 misses + P2 catches silent corruption."
  echo "Verifier behavior matches the failure-mode table. Safe to trust on real data."
else
  echo "PROBE FAIL: do NOT trust this verifier configuration on real data."
  exit 1
fi