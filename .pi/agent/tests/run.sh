#!/usr/bin/env bash
# Run the pi-extension unit tests with the SDK stub preload.
#
#   ./.pi/agent/tests/run.sh            # all tests
#   ./.pi/agent/tests/run.sh tool-guard # filter
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/../../.."
exec bun test --preload "$HERE/preload.ts" "$HERE/" "$@"
