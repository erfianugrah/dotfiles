---
description: Detect toolchain → run the right tests for the current diff
argument-hint: "[focus pattern]"
---

Run the appropriate tests for the changes in the working tree. Focused, not blanket.

Optional focus from user: $ARGUMENTS

## Step 1 — detect toolchain

Look at the repo root (and the nearest containing dir for each touched file in monorepos):

| Marker | Toolchain | Default command |
|---|---|---|
| `Cargo.toml` | Rust | `cargo test` (workspace) / `cargo test -p <pkg>` (sub-crate) |
| `go.mod` | Go | `go test ./...` (scope to changed packages: `go test ./pkg/foo/...`) |
| `package.json` + `bun.lock` | Bun | `bun test` |
| `package.json` + `pnpm-lock.yaml` | pnpm | `pnpm test` (read `scripts.test`) |
| `package.json` + `package-lock.json` | npm | `npm test` |
| `package.json` + `yarn.lock` | yarn | `yarn test` |
| `pyproject.toml` (`[tool.pytest.ini_options]`) | pytest | `pytest` |
| `pyproject.toml` (`[tool.poetry]`) | poetry+pytest | `poetry run pytest` |
| `pyproject.toml` (`[project]` only, no test config) | inspect — may be `python -m unittest` |
| `requirements.txt` + `tests/` | pytest probably | `pytest` |
| `Gemfile` | Ruby | `bundle exec rspec` or `rake test` (check) |
| `mix.exs` | Elixir | `mix test` |
| `Makefile` with `test:` target | make | `make test` |
| `justfile` with `test` recipe | just | `just test` |

If multiple markers: prefer the more specific. If `vitest.config.ts` exists → `vitest run`. If `jest.config.*` → `jest`. Project's `package.json scripts.test` is the source of truth — read it before assuming.

## Step 2 — find the relevant tests

Get the changed files: `git diff --name-only HEAD` (uncommitted) + `git diff --name-only origin/main...HEAD` (branch).

For each changed source file, map to its test file:

- **Rust** — same crate, `#[cfg(test)]` blocks or `tests/` dir → use `cargo test <mod_path>::` or `cargo test --test <integration_name>`
- **Go** — `foo.go` → `foo_test.go` in same dir → `go test -run TestFoo ./path/to/pkg`
- **TS/JS** — `foo.ts` → `foo.test.ts` / `foo.spec.ts` (sibling or under `__tests__/`) → `vitest run path/foo.test.ts` or `jest path/foo.test.ts`
- **Python** — `foo.py` → `test_foo.py` (sibling or `tests/`) → `pytest tests/test_foo.py` or `pytest -k test_foo`

If no test file exists for a changed source:
- **Flag it** — "src/x.py changed but no test_x.py" — don't silently skip
- If the change is in a test file itself, run it directly

## Step 3 — narrow to the diff

Where the framework supports it, scope tests to the touched code:

- pytest: `-k "<pattern>"` or pass specific test files
- vitest: pass file paths or `--testNamePattern`
- jest: same as vitest
- cargo test: `cargo test <substring>` filters by test name
- go test: `-run` regex

If user supplied `$ARGUMENTS`, pass it as the filter pattern.

If running the whole suite takes >30s and only a few files changed, prefer the targeted approach. If the full suite is <30s, just run everything — it's simpler and catches accidental cross-file breakage.

## Step 4 — run + classify

Stream output. After completion, group:

```
PASS:   <N tests>
FAIL:   <N tests>
SKIP:   <N tests, if any>
ERROR:  <N — setup/teardown failures>
```

For each FAIL, extract:
- Test name
- File:line of the assertion failure
- The actual vs expected (or stack trace summary)

Don't dump full stack traces unless asked. Surface the first line of failure + file:line.

## Step 5 — report

Format:

```
Detected: <toolchain> via <marker>
Command:  <exact command run>
Scope:    <X test files / Y test cases>
Duration: <seconds>

Result: PASS | FAIL (N failures)

[for each failure:]
✗ <test name>
  <file>:<line>
  <one-line summary of actual vs expected>
```

If everything passes: state plainly "all <N> tests pass". No theatrical celebration.

## Failure response

When tests fail:
- Show the failures, but don't auto-fix. The user runs `/test` to **know**, not always to fix.
- If the user follow-up asks to fix: invoke the `systematic-debugging` skill first — don't guess at fixes.

## Edge cases

- **No test runner detected** — explicitly say so. Suggest installing one or point at the docs server (e.g. `docs.erfi.io` has vitest/jest/pytest/cargo docs).
- **Test runner fails to even start** (missing deps, broken config) — fix the runner before chasing the diff. `bun install` / `cargo build` / `pip install -e .` first.
- **CI uses a different command than local** — if `.github/workflows/*.yml` runs `make ci-test` and there's no local `make test`, use the CI command. Match what CI runs, not what's in `package.json` if they differ.
