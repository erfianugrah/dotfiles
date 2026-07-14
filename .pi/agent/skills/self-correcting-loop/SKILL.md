---
name: self-correcting-loop
description: "Run an unattended, sensor-gated agent loop that drives a fresh pi -p each iteration until deterministic checks (build/lint/test/typecheck) pass, then stops. Use when the user wants to 'set an agent in a loop', run a task autonomously, self-correct without supervision, or make a weaker model (Sonnet/GLM/DeepSeek) reliably good on a scoped coding task. The model never decides 'done' - the sensors do. Language-agnostic - sensors are just command strings declared in a per-project .pi/harness.json (go/node/rust/astro/python presets included). Pairs with scaffold-new-project (which builds the target) and software-architecture (tight contracts = better sensors)."
---

# Self-correcting loop

A deterministic **outer harness** around `pi -p`. It exists to answer one
question: *how do you let an agent run unattended - and be good even on a
sub-Opus model - without it declaring victory on broken code?*

The answer (from Birgitta Bockeler's "Harness engineering"[^harness], the
article that seeded this): **externalize the feedback control.** The loop, not
the model, decides completion. The model only ever sees the failing sensor
output as its next prompt.

[^harness]: <https://martinfowler.com/articles/harness-engineering.html>
    (Thoughtworks cross-post: <https://www.thoughtworks.com/en-us/insights/blog/generative-ai/harness-engineering-agent-feedback-exploring-ai-coding-sensors>).

## The mechanism

```
checkpoint = git index (best known good)
repeat until every sensor exits 0, OR maxIterations spent:
    pi -p  <task + previous iteration's failing sensor output + loop notes>
    revert any edits outside writeScope
    run sensors (build / vet / test / tsc / clippy / astro check ...)
    all pass?       -> STOP, success                 (deterministic gate)
    fewer failures? -> checkpoint (keep), continue
    stalled/worse?  -> ROLL BACK to checkpoint; on repeated stalls, escalate
                       to the next model on the ladder
    append a per-iteration record to .pi/harness-report.json
```

The governor around the bare loop (all deterministic, no extra model calls):

- **git checkpoint + regression rollback** - the git index is the best-known-
  good state. An iteration that increases the failing-sensor count (or makes no
  progress) is reverted, so the loop can never degrade the tree.
- **write-scope enforcement** - `writeScope` globs fence what the agent may
  touch; out-of-scope edits are reverted each iteration. This structurally
  kills the test-weakening cheat (keep tests outside the scope) and replaces
  hand-written "integrity" guard sensors.
- **model escalation ladder** - start on the cheapest model; climb a rung after
  `stallPatience` consecutive no-progress iterations. Strength on demand.
- **run report** - `.pi/harness-report.json` records model, failing-count
  trend, kept/rolled-back, escalations, scope violations per iteration.

Two properties make this work on weak models:

1. **Fresh context per iteration.** Each `pi -p` is a new session. State lives
   in the *filesystem* (the model's prior edits) plus the *injected sensor
   feedback* - never in a bloating conversation that drifts. A weak model with
   a small, sharp prompt beats a strong model with a polluted 200-turn context.
2. **The sensor is the judge.** `go test` exit code is not negotiable. The
   model cannot hallucinate green. `buildPrompt` also injects anti-cheat
   guardrails ("do not delete/skip/weaken tests to force them green") because
   gaming the sensor is the #1 weak-model failure mode.

## Files

| File | Role |
|---|---|
| `harness.ts` | Pure core: manifest schema/validation, prompt + feedback builders, stack detection, glob/scope, decide/ladder logic. Unit-tested (30 cases). |
| `loop.ts` | CLI driver (Bun): spawns `pi -p`, runs sensors, git checkpoint/rollback, scope guard, escalation, report. |
| `presets/*.json` | Starter manifests per stack (go/node/rust/astro/python). |
| `harness.test.ts` | Unit tests for the pure helpers. |
| `loop.integration.test.ts` | End-to-end governor test with a scripted fake agent (rollback / stall+escalate / scope-revert / pass) - no real model needed. |
| `browser-assert.ts` | Dependency-free headless-Chromium sensor (CDP over Bun's WebSocket - no puppeteer/playwright). Ordered flow steps (wait/click/type/press/assert/screenshot) + viewport/full-page. The behaviour-harness layer for web targets; also a UI live-smoke tool. |
| `browser-assert.integration.test.ts` | Drives real Chromium against a fixture page (skips if no browser). |

## Usage

This skill is also the `@erfianugrah/pi-loop` package. Get the `loop` and
`browser-assert` commands on PATH once:

```bash
cd ~/.pi/agent/skills/self-correcting-loop && bun link   # provides `loop`, `browser-assert`
```

Then, from the **target project root** (the repo the loop should work on):

```bash
# 1. write .pi/harness.json (auto-detects stack from go.mod/package.json/...)
loop init                   # or: init go | node | rust | astro | python

# 2. edit .pi/harness.json: set "task", tune "sensors", pick "models"

# 3. see what the sensors say right now, without spawning pi
loop run --dry

# 4. run the loop
loop run
loop run --model claude-sonnet-5 --max 15    # weak-model test
loop run --allow-dirty                        # skip the clean-tree guard
```

Without `bun link`, invoke directly: `bun ~/.pi/agent/skills/self-correcting-loop/loop.ts run`.

The loop refuses a **dirty working tree** by default - its `git add -A`
checkpoint / `git checkout`+`clean` rollback would otherwise fold your
uncommitted work into its snapshots. Commit/stash first, or pass
`--allow-dirty`. (`--dry` is exempt: it runs no git ops.)

`run` exit codes: `0` all sensors green, `1` still red after budget, `2`
manifest/usage error.

## The manifest (`.pi/harness.json`)

```json
{
  "task": "Add a WeChat OAuth provider module; loop until conformance passes.",
  "maxIterations": 12,
  "models": ["claude-sonnet-5", "claude-opus-4-8"],
  "stallPatience": 3,
  "tools": ["read", "edit", "write", "bash"],
  "writeScope": ["providers/wechat/**"],
  "sensors": [
    { "name": "build", "cmd": "go build ./..." },
    { "name": "vet",   "cmd": "go vet ./..." },
    { "name": "test",  "cmd": "go test ./..." }
  ]
}
```

- `task` - the feed-forward instruction. Keep it scoped; one module/feature.
- `sensors` - the feedback controls. Each `cmd` runs under `bash -lc`; exit 0 =
  pass. Order them cheap-to-expensive (build before test) - all must pass. Each
  sensor may carry an optional `hint` string, appended to the feedback when it
  fails ("how to fix: ...") - author it for the *class* of failure, so the model
  gets remediation guidance, not just the error.
- `models` - the escalation ladder, cheapest first (`""` = pi default). Legacy
  `model` (string|null) is still accepted and normalized to a one-rung ladder.
  CLI `--model` overrides to a single rung.
- `stallPatience` - consecutive no-progress iterations before climbing a rung.
- `baseline` (or CLI `--freeze`) - freeze mode: sensors already failing at the
  baseline run are tolerated as pre-existing debt; only NEW failures gate. Lets
  the loop adopt a legacy repo without a green-the-world sprint first (ArchUnit
  `freeze`).
- `writeScope` - globs the agent may write (`*` within a segment, `**` across).
  Globs are **cwd-relative** (the dir you launch the loop from), so running in
  a repo subdir with `writeScope: ["bin/migrate.sh"]` matches correctly even
  though git reports repo-root-relative paths internally.
  Empty = unrestricted. Requires the target to be a git repo.

> The governor (checkpoint/rollback/scope/escalation) needs a **git repo** with
> a committed baseline. Without git it degrades to feed-forward-only and warns.

## Making the target harnessable (this is where the leverage is)

The loop is only as good as its sensors. A weak model succeeds when the
sensors are **specific and deterministic**. Raise sensor quality by:

- **Tight contracts.** A small interface/trait + a **conformance test suite**
  any implementation must pass turns "is this code good?" (inferential, hard)
  into "does `go test ./conformance/...` pass?" (computational, trivial). This
  is why plugin/provider systems loop so well - the module boundary *is* the
  sensor.
- **A golden reference** the task can say "copy providers/mock and adapt".
  Weak models are far better at "make it like that" than "invent from spec".
- **Recorded fixtures** (VCR-style cassettes) for anything that hits a network,
  so real request/response shapes are validated offline, deterministically.
- **Structural / architecture sensors** turn a boundary you *hope* holds into
  one the build enforces - a fitness function (Böckeler; ArchUnit). They are
  fast and deterministic, so run them alongside the fast sensors. Per stack:
  Go `golangci-lint run` with a `depguard` rule (module-boundary example in
  `~/authkit/.golangci.yml`), TS `dependency-cruiser`, Python `import-linter`,
  JVM ArchUnit. Pair with a `hint` naming the rule that was crossed. This is
  the cure for the "same agent wrote both sides of the contract" drift.
- **Test-quality sensors (mutation testing)** grade whether the tests actually
  *catch* bugs, not just whether they pass - the concrete answer to "can I
  trust agent-written tests?". Run as an EXPENSIVE, post-fast-sensor gate (it
  re-runs the suite per mutant): Go `gremlins unleash --threshold-efficacy N
  ./pkg` (bump `--timeout-coefficient` so per-mutant recompiles fit, or every
  mutant times out), TS StrykerJS, JVM PIT. Real payoff: on authkit this
  immediately surfaced an untested default-TTL branch in the loop-built bridge
  (93% -> 100% efficacy after one added case).

## Behaviour harness for web targets

Build/typecheck/unit sensors do not prove a page actually renders and works.
The browser layer closes that gap, and comes in two flavours:

- **Computational (the gate): `browser-assert.ts`.** Launches system Chromium
  headless over CDP and runs ORDERED steps: `--wait <sel>`, `--click <sel>`,
  `--type <sel> <text>`, `--press <key>` (trusted CDP Input events),
  `--assert <jsExpr>`, `--screenshot <path>` (+ `--viewport WxH`, `--full-page`).
  So it scripts a real flow (sign-in, form, wizard), not just a static-render
  check. Exits 0/1. Deterministic and self-bounding (per-command CDP timeout +
  reject-on-socket-close, so a wedged browser fails instead of hanging the
  loop). Also doubles as a **UI live-smoke** tool: point `<url>` at a deployed
  environment. Wrap dev-server start/stop in the sensor cmd:

  ```json
  { "name": "e2e",
    "cmd": "bunx --bun astro build && (bunx serve dist -l 4321 & SP=$!; sleep 1; bun ~/.pi/agent/skills/self-correcting-loop/browser-assert.ts http://localhost:4321 --wait '#app' --assert 'document.title.length>0' --assert '!document.querySelector(\".error\")'; RC=$?; kill $SP; exit $RC)" }
  ```

  Put e2e AFTER the fast sensors (build/typecheck/unit) - it is the expensive,
  slower-and-flakier tier, so it only runs once the cheap gates are green.

- **Inferential (for debugging, not the gate): a screenshot the model reads.**
  `browser-assert ... --screenshot /tmp/x.png` captures the post-interaction
  page; the agent then `read`s the PNG to reason about layout/visual issues the
  DOM can't express. This is a probabilistic aid - never let a screenshot decide
  "done".

Visual-regression (diff the `--screenshot` PNG against a baseline) and a11y
(`axe`) are further sensors you can layer on; they need their own baselines/
tooling. `--type`/`--click` use trusted CDP Input events, but for complex flows
(multi-tab, downloads, network mocking) a target's own Playwright suite is still
the right tool - `browser-assert` is the zero-dep gate.

## Limits (be honest about these)

- **Behaviour harness gap.** Green sensors prove the code passes *the checks*,
  not that it does *the right thing*. If the model wrote the tests too, that's
  a closed loop. Mitigate with conformance suites + fixtures you control, and
  mutation testing where it matters.
- **Correctness needs specification.** The loop cannot fix a vague `task`. A
  misunderstood instruction converges on green-but-wrong. Scope tightly.
- **Not for unfenced blast radius.** Great for greenfield modules and
  test-fenced changes; not for "loop on the payments service unattended".

## Testing this skill

```bash
cd ~/.pi/agent/skills/self-correcting-loop && bun test harness.test.ts
```
