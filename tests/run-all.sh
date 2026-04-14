#!/usr/bin/env bash
# Run all Docker-based tests. Usage: ./tests/run-all.sh [arch|steamos|macos]
set -euo pipefail

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

PLATFORMS="${@:-arch steamos macos}"
PASS=0 FAIL=0

for platform in $PLATFORMS; do
  echo ""
  echo "════════════════════════════════════════════════"
  echo " Building: $platform"
  echo "════════════════════════════════════════════════"

  docker build -t "dotfiles-test-${platform}" -f "tests/Dockerfile.${platform}" . 2>&1 \
    | tail -3

  echo ""
  echo "════════════════════════════════════════════════"
  echo " Running: $platform"
  echo "════════════════════════════════════════════════"

  if docker run --rm "dotfiles-test-${platform}" 2>&1; then
    echo "  >> $platform: PASSED"
    (( PASS++ ))
  else
    echo "  >> $platform: FAILED (exit $?)"
    (( FAIL++ ))
  fi
done

echo ""
echo "════════════════════════════════════════════════"
echo " MATRIX: $PASS passed, $FAIL failed (of $(echo $PLATFORMS | wc -w))"
echo "════════════════════════════════════════════════"
(( FAIL == 0 ))
