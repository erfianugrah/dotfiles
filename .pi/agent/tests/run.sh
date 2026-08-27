#!/usr/bin/env bash
# Run the pi-extension test suites.
#
#   ./.pi/agent/tests/run.sh            # all suites
#   ./.pi/agent/tests/run.sh tool-guard # filter the unit suite by name
#
# The filter matches FILENAMES first (run.sh skill-first -> just that file);
# if no filename matches it falls back to bun's -t test-name regex, so
# `run.sh splitSegments` still selects individual tests. Before 2026-08-27 the
# argument was appended as a bare bun arg, which bun read as another test PATH
# - it matched nothing and was silently ignored, so every "filtered" run
# actually ran the whole suite.
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

# Unit suite: EVERY *.test.ts at this level, globbed rather than hand-listed.
#
# It used to be an explicit list, which rotted twice and silently:
#   - one entry was "/trigger-compact.test.ts" (absolute path, missing $HERE),
#     and bun IGNORES a nonexistent test path instead of failing, so those 6
#     tests had not run for as long as the typo existed;
#   - three suites (continue-after-error, runaway-turn-guard, skill-first)
#     were never added, so adding a test file did not mean running it.
# Globbing removes the class of bug: a new *.test.ts here runs automatically.
#
# Excluded by construction:
#   preload.ts        - not a test (it IS the stub)
#   integration/      - separate process below (self-mocks the SDK; its
#                       top-level mock.module() calls collide with preload)
#   manifest.test.ts  - separate process below (pure fs/glob, no preload)
#
mapfile -t UNIT_FILES < <(
  find "$HERE" -maxdepth 1 -name '*.test.ts' ! -name 'manifest.test.ts' | sort
)
if [ ${#UNIT_FILES[@]} -eq 0 ]; then
  echo "run.sh: no unit test files found in $HERE" >&2
  exit 1
fi

FILTER="${1:-}"
if [ -n "$FILTER" ]; then
  # Filename match wins (the common case: run.sh skill-first).
  mapfile -t MATCHED < <(printf '%s\n' "${UNIT_FILES[@]}" | grep -- "$FILTER" || true)
  if [ ${#MATCHED[@]} -gt 0 ]; then
    bun test --preload "$HERE/preload.ts" "${MATCHED[@]}"
  else
    # No file matched - treat it as a test-name regex across all unit files.
    bun test --preload "$HERE/preload.ts" "${UNIT_FILES[@]}" -t "$FILTER"
  fi
  exit $?
fi

bun test --preload "$HERE/preload.ts" "${UNIT_FILES[@]}"

# Integration suite (self-mocked; no preload). Always run in full.
bun test "$HERE/integration/"

# Harness self-sensor: assert the pi-package manifest ships every resource.
# No preload (pure fs/glob). Runs in full.
bun test "$HERE/manifest.test.ts"
