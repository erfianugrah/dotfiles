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
- [Clipboard & paste](#clipboard--paste) — `/y` for surgical code-block copy that bypasses terminal wrap
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

### `bg-tasks` — parallel pi sessions + arbitrary bash in detached tmux

Four tools + two slash commands. Detailed in
[Background tasks pattern](#background-tasks-pattern) below.

### `yank` — clipboard copy that survives terminal wrap

Not a binary wrapper — a slash-command extension. Detailed in
[Clipboard & paste](#clipboard--paste) below.

## Background tasks pattern

Two spawn tools (`bg_task` for pi sessions, `bg_bash` for arbitrary shell
commands) + two query tools (`bg_list`, `bg_status`). All share the same
state-file format under `~/.pi/agent/bg-tasks/`. Each task runs in its
own tmux session named `pi-bg-<slug>-<unix-ts>`.

This is the amux-style "kick off a long task and check on it later"
mechanism, minus amux's Claude-Code lock-in.

### bg_task — spawn another pi session

```typescript
bg_task({
  prompt: "refactor bonkled's auth.go into per-route guards, then run go test",
  minimal: false,     // keeps full extension set (default)
  cwd: "/home/erfi/bonkled"
})
// → { name: "pi-bg-refactor-bonkled-auth-1748056290", started_at: ... }
```

### bg_bash — spawn an arbitrary bash command

Use this for anything that would otherwise hit pi's `bash` tool timeout
(~30s) or that you simply want to run detached:

- Polling loops (waiting for TLS cert, deploy completion, etc.)
- Long builds, migrations, downloads
- Long-running test suites
- Multi-step shell scripts you'd otherwise have to interleave with the agent

```typescript
// Example: poll flyctl until a cert is ready (replaces a synchronous
// bash loop that would time out pi's bash tool):
bg_bash({
  command: `
    for i in $(seq 1 20); do
      status=$(flyctl certs check ntfy.erfi.io 2>&1 | grep -E "Status\\s+=" | awk -F= '{print $2}' | xargs)
      echo "attempt $i: status = $status"
      [ "$status" = "Ready" ] && break
      sleep 10
    done
    echo "=== HTTPS check ==="
    curl -sS https://ntfy.erfi.io/v1/health
  `,
  name: "flyctl-cert-wait",
  cwd: "/home/erfi/servarr-compose/ntfy-fly"
})
// → returns immediately; check progress with bg_status when convenient
```

### Query: bg_list + bg_status

```typescript
// List all running + recently-completed (24h window)
bg_list({ only_running: true })
// → status / kind (π=pi, $=bash) / elapsed / name / prompt-preview

// Drill into one task
bg_status({ name: "pi-bg-flyctl-cert-wait-1748056290", lines: 100 })
// → full state + last 100 lines of tmux pane output
```

### Slash commands (human-friendly)

```
/bg-list                     # same data as bg_list, terser format
/bg-kill <session-name>      # terminate a running task (with confirm)
```

### When to use `bg_task` vs `bg_bash` vs `task` vs sync

| Pattern | Use this | Why |
|---|---|---|
| Read-only deep dive into another part of the codebase, context isolation matters | `task subagent_type=explore` | Spawns `pi -p --no-extensions --no-skills` + `-e docs.ts`. Cheap, fast, parent waits for result. |
| Big multi-step task expected to take >5 min that benefits from another LLM brain | `bg_task` | Spawns detached `pi -p`, parent moves on, check later via `bg_list`. |
| Long bash work — polling, build, migration, download, slow test suite | `bg_bash` | Spawns detached `bash <tempfile>`, no LLM involved. Pi keeps working. |
| Small task that needs result inline | regular pi tool calls | No subprocess overhead. |
| Same task across many repos / variants | `bg_task` x N or `bg_bash` x N (one per repo) + `bg_list` to check | Real parallel agent fleet. Each gets its own session, won't step on each other. |

### Architecture

The wrapper script runs inside each tmux session and does:

1. `cd $cwd && <inner-command> > /tmp/out 2>&1; RC=$?`
   - For `bg_task`: inner-command is `pi -p "$prompt" "${PI_FLAGS[@]}"`. The prompt is
     base64-encoded into an env var and decoded to a tempfile at runtime so backticks,
     `$(...)`, and other shell metacharacters in the prompt can't trigger injection.
   - For `bg_bash`: inner-command is `bash <tempfile-containing-user-command>`. The
     command is also base64-passed for the same safety reason.
2. Print the captured output to the pane.
3. Update the state JSON via `jq` (or `python3` fallback) with `exit_code`, `output_bytes`, `completed_at`.
4. `sleep 30` so a fast post-completion `bg_status` can still see the pane.

No daemon, no DB, no port. Just files + tmux. The state files are GC'd 24h
after `completed_at`. Truly orphaned tmux sessions (tmux session exists but
state file is gone) won't be listed — that's fine, you can `tmux ls` to
find them.

## Clipboard & paste

### The problem

When pi renders a long single-line command, the TUI wraps it visually to
fit the terminal width. Selecting-and-dragging from the terminal grabs
those **visual** wrap breaks as **real** newlines. Pasting the result into
a shell drops mid-string newlines and breaks the command.

Concrete failure modes seen in the wild:

1. **PowerShell unclosed quote** — a 396-byte `Set-Content ... -Value
   'rclone mount ...'` one-liner gets broken across 3 PowerShell lines
   on paste. The `'` never closes → PS drops into the `>>` continuation
   prompt and the user has to Ctrl+C out.

2. **PowerShell empty pipe stage** — a 3-line `Get-WinEvent ... |\n
   Where-Object ... |\n Format-List` pipeline pasted into pwsh raises
   `At line:2 char:118 ... An empty pipe element is not allowed.`. PS
   evaluates pasted lines as they arrive; after the second `|` the next
   stage hasn't been delivered yet, so PS sees a complete-looking
   "cmd | empty" and errors before line 3 lands.

Both happen even when the LLM wrote a perfectly valid command — the
corruption is purely between **what's on screen** and **what hits the
clipboard**.

### `/y` — surgical code-block copy

`/y` (alias `/yank`) reads the code block directly from pi's session
entries (the structured pre-render form via
`ctx.sessionManager.getEntries()`), so terminal wrap is never involved.
The clipboard receives exactly the bytes the LLM wrote.

```
/y              copy block 1 from last assistant message
/y 2            copy block 2
/y -1           copy the LAST block (negative = from-end indexing)
/y -2           copy second-to-last
/y ?            list all blocks with language + size + preview
/y ^            same as `/y back 1` — previous assistant message
/y ^^           two messages back; ^^^ = three back; etc.
/y 2^           block 2 from one message back
/y ?^           list blocks in the previous message
```

Legacy verbose syntax still works for muscle-memory backward compat:
`/y back 2`, `/y list`, `/y list back 1`.

### `!` flag — flatten shell line-continuations

For multi-line pipelines that fail the PS-paste race, append `!` to
collapse line-continuations into a single line:

```
/y !            copy block 1, flattened
/y 2!           copy block 2, flattened
/y -1!          copy last block, flattened
/y 2^!          block 2 from prev message, flattened
/y 2!^          same — `!` and `^` are commutative
```

Recognised continuation patterns (replaced with a single space):

| Source | Continuation | Becomes |
|---|---|---|
| bash / zsh | `\<newline><indent>` | ` ` |
| PowerShell | `` ` <newline><indent>`` | ` ` |
| Any shell pipe chain | `\|<newline><indent>` | ` \| ` |

The detector `isFlattenable(body)` only marks blocks as flat-candidates
when **every non-last line ends with a continuation marker** AND there
are no internal blank lines. Multi-line scripts (`for/do/done`,
`if/then/fi`, function definitions) stay untouched even with `!`, and
the toast warns `⚠ not flattenable (no continuation markers)` to make
the no-op explicit.

### Discoverability hint

When you yank a multi-line block **without** `!`, the toast appends a
hint so you don't have to remember the flag exists:

```
yanked #1/1 [powershell] — 229B  (multi-line; /y 1! to flatten)
```

When you do use `!`, the toast confirms how much was collapsed:

```
yanked #1/1 [powershell] — 221B · flattened 3→1 line
```

The `←1` arrow appears when the block came from a past assistant message
via `^` carets:

```
yanked #2/3 [bash] — 30B ←2
                          ↑
                          2 messages back
```

### Clipboard transport (probed in order)

The extension auto-detects the right clipboard backend for your
platform:

| Order | Detector | Tool | Where it works |
|---|---|---|---|
| 1 | `/proc/version` contains `microsoft` | `clip.exe` | WSL1 / WSL2 |
| 2 | `process.platform === "darwin"` | `pbcopy` | macOS |
| 3 | `$WAYLAND_DISPLAY` set | `wl-copy` | Wayland (Sway, Hyprland, GNOME, KDE Plasma 6) |
| 4 | `$DISPLAY` set | `xclip -selection clipboard` | X11 |
| 5 | `$DISPLAY` set | `xsel --clipboard --input` | X11 fallback |
| 6 | `termux-clipboard-set` on PATH | (same) | Termux on Android |
| 7 | always | OSC 52 escape | Kitty, WezTerm, Ghostty, iTerm2, foot, alacritty (configured); tmux passthrough wrapped automatically |

The toast reports which transport was used: `yanked ... via clip.exe`.

### `/y` vs built-in `/copy`

Pi ships a built-in `/copy` that copies the **entire last assistant
message** (prose + all code blocks + markdown formatting) to the
clipboard. That's useful for sharing a whole answer.

`/y` is for surgical extraction of **one** code block at a time so you
can paste it directly into a shell / editor without trimming
surrounding prose by hand.

Use `/copy` for sharing; use `/y` for executing.

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
