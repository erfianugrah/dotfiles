# Agent toolkit reference

Single-page reference for the binaries installed via `pacman_list.txt` /
`yay_list.txt`, the pi extensions that wrap them, and the workflows that
combine both for token-efficient agent work.

For higher-level config (settings, themes, prompts, env vars) see
[`README.md`](./README.md). For tool-routing rules and pi conventions see
[`AGENTS.md`](./AGENTS.md).

## Table of contents

- [Quick smoke test](#quick-smoke-test) — verify everything works after `/reload`
- [Token-efficiency conventions](#token-efficiency-conventions) — the patterns that save tokens
- [Binary toolkit](#binary-toolkit) — 33 tools, what each does, canonical invocation
- [pi extension wrappers](#pi-extension-wrappers) — 6 extensions that wrap the binaries
- [Background tasks pattern](#background-tasks-pattern) — parallel pi via tmux
- [Workflows](#workflows) — real flows that combine multiple tools
- [When to use each editing strategy](#when-to-use-each-editing-strategy)
- [Adding new pi extensions](#adding-new-pi-extensions) — pattern for future wrappers

## Quick smoke test

After installing the toolkit and `/reload`-ing pi:

```bash
# Binaries are on PATH
command -v osv-scanner gitleaks noseyparker semgrep typos vale hurl just mise direnv hyperfine watchexec atlas

# pi tools registered (in TUI: type `/` to see all)
# Try: osv_scan, secret_scan, hurl_test, go_test, bench, bg_task, bg_list, bg_status

# Run the unit test suite
~/dotfiles/.pi/agent/tests/run.sh
```

Expected: all binaries resolved, 86/86 tests pass.

## Token-efficiency conventions

When pi shells out to a binary, **always** request structured output and project only the fields needed. Defaults are usually prose-for-humans which is token-expensive.

| Tool | Token-bloated form | Token-efficient form |
|---|---|---|
| `osv-scanner` | `osv-scanner -r .` | `osv-scanner -r . --format=json \| jq '.results[].packages[].vulnerabilities[].id'` |
| `gitleaks` | `gitleaks detect` | `gitleaks detect --no-banner --report-format=json --report-path=/dev/stdout` |
| `go test` | `go test ./...` | `go test -json ./... \| jq -c 'select(.Action=="fail")'` |
| `kubectl` | `kubectl get pods` | `kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\n"}{end}'` |
| `gh pr list` | `gh pr list` | `gh pr list --json number,title,state --jq '.[] \| "#\(.number) \(.state) \(.title)"'` |
| `git status` | `git status` | `git status --porcelain=v2 --branch` |
| `git log` | `git log -20` | `git log --pretty=format:'%H%x09%an%x09%s' -20` |
| `git diff` | `git diff` | `git diff --stat --no-color HEAD~3` |
| `docker compose ps` | `docker compose ps` | `docker compose ps --format=json \| jq -c '.[] \| {service:.Service, state:.State}'` |
| `rg` | `rg pattern` | `rg --json pattern \| jq -c 'select(.type=="match") \| {path:.data.path.text, line:.data.line_number}'` |
| any verbose shell command | `cmd` | `cmd \| jc --<command-name>` (turns 100+ commands into structured JSON) |

The pi extensions in the next section bake these conventions in so the agent can't accidentally use the bloated form.

## Binary toolkit

All single-binary installs. Group by package source.

### Official Arch repos (`pacman -S`, 24 packages)

| Binary | One-line | Canonical use |
|---|---|---|
| `osv-scanner` | Vuln scanner across all package managers (Go/npm/Cargo/pip/etc) | `osv-scanner -r . --format=json` |
| `gitleaks` | Secret detection via regex rules | `gitleaks detect --no-banner --report-format=json --report-path=/dev/stdout` |
| `vale` | Prose / docs linter with style packs | `vale --output=JSON .` |
| `dbmate` | DB migrations (Postgres, MySQL, SQLite, ClickHouse) | `dbmate up` / `dbmate down` |
| `sqlfluff` | SQL linter + formatter | `sqlfluff lint --format=json` |
| `typos` | Source code typo finder | `typos --format=json` (config: `.typos.toml`) |
| `staticcheck` | Best-in-class Go linter (catches `errcheck`, `S1xxx`, more) | `staticcheck -f json ./...` |
| `git-cliff` | Conventional commits → CHANGELOG.md | `git cliff -o CHANGELOG.md` |
| `difftastic` | Syntax-aware diff | `git diff` after `git config diff.external difft` |
| `hurl` | Declarative HTTP test runner | `hurl --test --json file.hurl` |
| `oha` | HTTP load test with live TUI histogram | `oha -n 10000 -c 100 https://target` |
| `xh` | Modern HTTP client (httpie rewrite) | `xh GET https://api.example.com Authorization:Bearer\ XXX` |
| `hyperfine` | Statistical command benchmarking | `hyperfine --export-json /tmp/b.json 'cmd1' 'cmd2'` |
| `watchexec` | Generic file watcher → rerun command | `watchexec -e go,ts -- bun test` |
| `entr` | Smaller alternative to watchexec | `rg --files \| entr -r bun dev` |
| `just` | Cleaner Makefile alternative | Create `justfile` + `just <task>` |
| `mise` | Polyglot toolchain version manager | `mise.toml` per repo + `mise install` |
| `direnv` | Per-directory env vars | `.envrc` + `direnv allow` |
| `jc` | Convert command output to JSON (100+ commands) | `dig +short host \| jc --dig` |
| `kubeconform` | K8s manifest schema validation | `kubeconform -strict -summary -output=json manifests/` |
| `dive` | Explore Docker image layers (TUI) | `dive <image>` |
| `lazygit` | Git TUI | `lazygit` |
| `lazydocker` | Docker / compose TUI | `lazydocker` |
| `xh` | Modern curl replacement | `xh https://api.example.com` |

### AUR via paru (8 packages)

| Binary | One-line | Canonical use |
|---|---|---|
| `noseyparker` | Smarter secret scanner (entropy + provenance) | `noseyparker scan --datastore=/tmp/np . && noseyparker report --format=jsonl --datastore=/tmp/np` |
| `git-absorb` | Auto-create `--fixup` commits from working changes | `git absorb --and-rebase` |
| `comby` | Structural search/replace across languages | `comby '...' '...' -in-place -lang go` |
| `srgn` | Newer AST refactor tool (Rust) | `srgn --typed-language ts 'function $X' 'arrow $X'` |
| `kubescape` | K8s security posture scanner | `kubescape scan -f json` |
| `scc` | LOC + complexity counter (faster than tokei) | `scc -f json` |
| `semgrep` | Pattern-based static analysis with custom rules | `semgrep ci --json --no-rewrite-rule-ids` |
| `trufflehog` | Verified secret detection (700+ verifiers) | `trufflehog git file://. --json --no-update` |

### Via `go install`

| Binary | One-line | Canonical use |
|---|---|---|
| `atlas` | Declarative schema migrations for Postgres/MySQL/etc | `atlas schema diff --to file://schema.sql` |
| `govulncheck` | Go-specific reachable-vuln detection (call-graph aware) | `govulncheck -json ./...` |
| `vegeta` | HTTP load gen with JSON reports | `echo "GET https://target" \| vegeta attack -rate=10 -duration=30s \| vegeta report -type=json` |

## pi extension wrappers

The 6 extensions added on top of the binary toolkit. Each registers one or
more pi tools that wrap a binary with structured output + opinionated
defaults. See the file header in each `~/.pi/agent/extensions/<name>.ts`
for the full motivation.

### `osv-scan` — vulnerability scanning

```typescript
osv_scan({ path: "./", lockfile_only: false, include_dev: false })
```

Wraps `osv-scanner -r . --format=json` and flattens to one entry per
(package, vulnerability) with: `package`, `version`, `ecosystem`, `id`,
`aliases`, `severity`, `fixed`, `summary`. Covers Go modules, npm/pnpm/yarn,
Cargo, pip/poetry, Composer, Maven, NuGet, RubyGems in one call.

**When to use**: before deploys, after dep bumps, periodic audits.

### `secret-scan` — leaked secret detection

```typescript
secret_scan({ path: "./", backend: "gitleaks", scan_history: false })
secret_scan({ path: "./", backend: "noseyparker" })
```

Wraps either `gitleaks` (regex-based, fast) or `noseyparker` (entropy +
provenance, smarter). Both backends return findings with `rule`, `file`,
`line`, and a **truncated** secret prefix (first 12 chars + total
length) — the actual secret value never enters pi's context window.

**When to use**: pre-commit gate, PR review, periodic history scans
(`scan_history: true`).

### `hurl-test` — HTTP integration tests

```typescript
hurl_test({ file: "tests/api.hurl", variables: { base_url: "http://localhost:3000" } })
```

Runs a `.hurl` file with `--test --json`. On success returns a one-line
summary. On failure returns per-entry breakdown with the failing
assertion (kind + message + expected vs actual). Supports variable
substitution into `{{ var }}` placeholders.

**When to use**: API smoke tests in CI or interactively. Pairs well
with bonkled's composer stack.

### `go-test` — focused Go test triage

```typescript
go_test({ pattern: "./internal/...", run: "TestRoom_.*", race: true, timeout: "2m" })
```

Wraps `go test -json` and returns ONLY failures + summary. Each failure
includes the last 30 lines of output (with `=== RUN` / `=== PAUSE`
scaffold stripped). Supports `run` regex, `race`, `count`, `short`,
`timeout`, `cwd`.

**When to use**: every time you'd otherwise run `go test ./...` — same
information, fraction of the tokens.

### `bench` — statistical command benchmarking

```typescript
bench({ commands: ["./old --flag", "./new --flag"], warmup: 3, runs: 20 })
```

Wraps `hyperfine --export-json`. Returns per-command mean/stddev/min/max
plus the winner and speedup factor (slowest_mean / fastest_mean).
Defaults to `--shell=none` for accurate short-command measurement.

**When to use**: confirming a refactor is actually faster, A/B-ing two
implementations, comparing model invocations.

### `bg-tasks` — parallel pi sessions in detached tmux

Three tools + two slash commands. Detailed in
[Background tasks pattern](#background-tasks-pattern) below.

## Background tasks pattern

`bg_task` is the amux-style "kick off a long task and check on it later"
mechanism, minus amux's Claude-Code lock-in. State lives in flat JSON
files under `~/.pi/agent/bg-tasks/`. Each task runs in its own tmux
session named `pi-bg-<slug>-<unix-ts>`.

### Lifecycle

```typescript
// Spawn — returns within ~100ms with the session handle
bg_task({
  prompt: "refactor bonkled's auth.go into per-route guards, then run go test",
  minimal: false,     // keeps full extension set (default)
  cwd: "/home/erfi/bonkled"
})
// → { name: "pi-bg-refactor-bonkled-auth-1748056290", started_at: ... }

// List all running + recently-completed (24h window)
bg_list({ only_running: true })
// → status / elapsed / name / prompt-preview, one line per task

// Drill into one
bg_status({ name: "pi-bg-refactor-bonkled-auth-1748056290", lines: 100 })
// → full state + last 100 lines of tmux pane output
```

### Slash commands (human-friendly)

```
/bg-list                     # same data as bg_list, terser format
/bg-kill <session-name>      # terminate a running task (with confirm)
```

### When to use `bg_task` vs `task` vs sync

| Pattern | Use this | Why |
|---|---|---|
| Read-only deep dive into another part of the codebase, context isolation matters | `task subagent_type=explore` | Spawns `pi -p --no-extensions --no-skills` + `-e docs.ts`. Cheap, fast, parent waits for result. |
| Big multi-step task expected to take >5 min, parent wants to keep working | `bg_task` | Spawns detached tmux, parent moves on, check later via `bg_list`. |
| Small task that needs result inline | regular pi tool calls | No subprocess overhead. |
| Same task across many repos / variants | `bg_task` x N (one per repo) + `bg_list` to check | Real parallel agent fleet. Each gets its own session, won't step on each other. |

### Architecture

The wrapper script `bg-tasks.ts` runs inside each tmux session does:

1. `cd $cwd && pi -p "$prompt" $flags > /tmp/out 2>&1; RC=$?`
2. Print the captured output to the pane
3. Update the state JSON via `jq` (or `python3` fallback) with `exit_code`, `output_bytes`, `completed_at`
4. `sleep 30` so a fast post-completion `bg_status` can still see the pane

No daemon, no DB, no port. Just files + tmux. The state files are GC'd 24h
after `completed_at`. Truly orphaned tmux sessions (tmux session exists but
state file is gone) won't be listed — that's fine, you can `tmux ls` to
find them.

## Workflows

Concrete flows that mix multiple tools.

### Pre-commit / pre-push gate

Run these before `git commit`. Configure via `.pre-commit-config.yaml`
or just a `make check` target:

```bash
typos                                  # 0 tolerance
gitleaks detect --no-banner --no-git   # leaks in working tree
osv-scanner -r . --format=json | jq -r '.results[].packages[].vulnerabilities[].id' | head
go test -json ./... | jq -c 'select(.Action=="fail")'   # tests still green
golangci-lint run --out-format=json --timeout=2m
```

Or from inside pi:

```
secret_scan path=./
osv_scan
go_test pattern="./..."
```

### Pre-deploy verification

Heavier audit. Includes history scan + reachable-vuln narrowing:

```bash
noseyparker scan --datastore=/tmp/np . && noseyparker report --format=jsonl --datastore=/tmp/np
govulncheck -json ./...
trufflehog git file://. --json --no-update --since-commit HEAD~50
kubeconform -strict -summary -output=json k8s/
kubescape scan -f json
```

From pi:
```
secret_scan backend=noseyparker scan_history=true
osv_scan include_dev=false
```

### Long refactor (multi-file, multi-hour)

```typescript
// 1. Kick off the refactor in background
bg_task({
  prompt: "Refactor all bonkled compose stacks to use static IPs per infra-stack skill. Validate each with kubeconform.",
  cwd: "/home/erfi"
})

// 2. Keep working in parent pi on other things

// 3. Check progress every few mins
bg_list({ only_running: true })

// 4. When done, drill in for the summary
bg_status({ name: "pi-bg-refactor-all-bonkled-1748...", lines: 200 })

// 5. Validate the changes
osv_scan({ path: "./" })       // dep-pin safety check
secret_scan({ path: "./" })    // no creds leaked into compose
```

### Benchmark a refactor

```typescript
// 1. Baseline
bench({ commands: ["./oldbin -input=large.json"], warmup: 3, runs: 20 })

// 2. Implement changes (with git-absorb to keep commits clean)
//    edit files...
//    `git absorb --and-rebase`  in another terminal

// 3. Compare
bench({ commands: ["./oldbin -input=large.json", "./newbin -input=large.json"], runs: 30 })
// → returns winner + speedup factor
```

### API contract testing

```typescript
// One-time setup: write tests/composer.hurl with assertions
// (composer skill has a template you can adapt)

hurl_test({
  file: "tests/composer.hurl",
  variables: { base_url: "https://composer.erfi.io", api_key: "${COMPOSER_API_KEY}" }
})
```

### Periodic security audit (background)

Run weekly via cron or just kick off before bed:

```typescript
bg_task({
  prompt: `Run secret_scan and osv_scan across all my active repos: bonkled, dotfiles, composer, servarr-compose, ergo, keycloak-compose. For each, output a one-paragraph summary. Skip clean repos.`,
  minimal: false
})
// Next morning: bg_list, bg_status to read the summary
```

## When to use each editing strategy

| Case | Tool |
|---|---|
| Single file, surgical change | pi `edit` |
| Single file >1000 lines or >100KB | `sd 'pattern' 'replace' file` |
| Same pattern across 5+ files (text-only) | `sd 'pattern' 'replace' file1 file2 ...` or `find ... -exec sd ...` |
| AST-precise rewrite (avoid strings/comments) | `ast-grep --pattern 'foo($X)' --rewrite 'bar($X)' --update-all -l ts` |
| Structural (find function bodies, class members, etc) | `comby 'function $name($params) { $body }' 'arrow $params: $body'` |
| Newer Rust alternative to ast-grep | `srgn --typed-language ts <find> <replace>` |
| Multi-file atomic add/update/delete | pi `apply_patch` (two-phase commit; auto-protected from .env / lockfile / .git via tool-guard) |
| Append to file | `cat <<'EOF' >> file` |
| Insert/delete by line range | `sed -i` with line addressing |
| Whole-file regen | pi `write` |

## Adding new pi extensions

The 6 wrappers added in this session all follow the same shape. Use one
of them as a template for a new extension.

### Template

1. Pure helper that does the work: `export function parseXxx(raw: string): YyyResult` — testable in isolation, no I/O.
2. `spawn`-based runner: `async function runBinary(...)` — handles timeout, missing binary, exit codes.
3. `defineTool({ name, label, parameters: Type.Object({...}), execute })` — registers the LLM-visible tool.
4. `export default function (pi) { pi.registerTool(tool) }`.
5. Symlink into `~/.pi/agent/extensions/`.
6. Add `parseXxx` import + test cases to `~/.pi/agent/tests/extensions.test.ts`.

### Pattern checklist

- [ ] Single file, ~80-200 lines.
- [ ] Wraps a binary that's already installed (or returns a clear "binary not on PATH" error pointing at the install command).
- [ ] Output is structured (JSON) AND projected to only the fields pi needs.
- [ ] Timeout on the subprocess (`setTimeout` + `proc.kill("SIGKILL")`).
- [ ] Cap on output size (truncate with a hint at the bottom).
- [ ] Returns `isError: true` on failure with a single-line reason.
- [ ] Pure parser function is exported for unit testing.
- [ ] At least 3 unit tests covering: happy path, empty input, malformed input.
- [ ] Symlinked into `~/.pi/agent/extensions/` (loader watches that dir).
- [ ] README extensions table updated.

### What NOT to wrap as a pi extension

- TUIs (lazygit / lazydocker / k9s / harlequin / dive) — pi can't interact with curses.
- Tools that already have a good native JSON mode and short output (rg, jq, fd — pi can use directly via `bash`).
- One-shot installers / package managers (pacman, paru) — wrap in a slash command instead.

## See also

- [`README.md`](./README.md) — Pi setup, extension list, env vars, themes, skills
- [`AGENTS.md`](./AGENTS.md) — Tool-routing rules, docs.erfi.io conventions, bash discipline
- [`APPEND_SYSTEM.md`](./APPEND_SYSTEM.md) — Commit / safety / Unicode-output rules
- [`tests/run.sh`](./tests/run.sh) — Unit test runner
- Pi docs: `/opt/pi-coding-agent/docs/` — extensions.md, tui.md, settings.md, sessions.md
- Extension examples: `/opt/pi-coding-agent/examples/extensions/`
