#!/usr/bin/env bash
# Run the pi-extension test suites.
#
#   ./.pi/agent/tests/run.sh            # all suites
#   ./.pi/agent/tests/run.sh tool-guard # filter the unit suite by name
#
# Two suites run as SEPARATE bun processes:
#   1. unit        — pure-helper tests; the SDK is stubbed via preload.ts.
#   2. integration — full-lifecycle e2e; each file self-mocks the SDK and
#                    drives real extension execute()/hooks. It MUST run in its
#                    own process because its top-level mock.module() calls and
#                    the shared module cache would otherwise collide with the
#                    unit suite's preload.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/../../.."

# Unit suite (filter passes through as "$@").
bun test --preload "$HERE/preload.ts" "$HERE/extensions.test.ts" "$@"

# Integration suite (self-mocked; no preload). Always run in full.
bun test "$HERE/integration/"
