# @erfianugrah/pi-loop

A sensor-gated, self-correcting loop driver for [pi](https://pi.dev).
Language-agnostic: it drives a fresh `pi -p` each iteration until the sensors
pass, then stops. Sensors run from cheap+computational (build / lint / test /
typecheck / structural / security) up to browser (DOM asserts + screenshots) and
inferential (LLM-as-judge on the diff, vision judge + baseline pixel-diff for
UI/UX). **The loop - not the model - decides "done"**, which is what makes it
hold up on sub-Opus models.

This directory is both a pi **skill** (`SKILL.md`) and an installable package
(`bin`: `loop`, `browser-assert`, `judge`, `pixel-diff`). Full concepts, manifest
schema, the governor, and honest limits live in [`SKILL.md`](./SKILL.md) - this
README is the 30-second start.

## Install

```bash
# it ships inside the pi-harness; to get the CLIs on PATH:
cd ~/.pi/agent/skills/self-correcting-loop && bun link   # provides `loop`, `browser-assert`, `judge`, `pixel-diff`
```

Bun >= 1.3. Zero runtime dependencies (Bun built-ins only).

## Quick start

From the target repo (the one the loop should work on):

```bash
loop init            # writes .pi/harness.json (detects go/node/rust/astro/python)
# edit .pi/harness.json: set "task", tune "sensors", pick the "models" ladder
loop run --dry       # run sensors once, no pi spawn
loop run             # drive the loop
```

Flags: `--model <id>`, `--max <n>`, `--freeze` (tolerate pre-existing failing
sensors), `--allow-dirty` (skip the clean-tree guard).

## What it does (governor)

- **Sensors are the gate** - each iteration runs the manifest's sensor commands;
  green exit codes are the only success signal.
- **Wall-clock budgets** - every sensor (`timeoutMs`, default 600s) and every
  agent iteration (`agentTimeoutMs`, default 1800s) is bounded. A process past
  its budget is killed via GNU `timeout` (process-GROUP kill, so grandchildren
  don't survive holding pipes/ports) and reported as a failure, never a hang.
- **Resource limits** - optional `limits` (`memoryMax`/`cpuQuota`/`tasksMax`)
  runs each sensor in a transient `systemd-run --user --scope` cgroup.
- **Model escalation ladder** - start on the cheapest model, climb a rung after
  N no-progress iterations.
- **git checkpoint + rollback** - a regressing/stalled iteration is reverted, so
  the loop never degrades the tree.
- **write-scope** - out-of-scope edits are reverted each turn (kills the
  test-weakening cheat).
- **ref-guard + index-guard** - agent-run `git commit`/`reset` is undone
  (HEAD restored), and the checkpoint index is re-imposed every iteration,
  so `reset --hard`, `stash`, and `update-index --skip-worktree` can't
  destroy or evade the checkpoint.
- **agent sandbox (bwrap)** - the agent runs jailed: read-only `/`, writable
  repo + /tmp, `~/.pi/agent` under an overlayfs copy-on-write (pi works, but
  extension/skill/auth edits land in a discarded tmpfs), secret dirs
  (~/.ssh, ~/.aws, ...) masked. `sandbox: "auto"|"require"|"off"` in the
  manifest.
- **standing rules + binding guide, hot-reloaded** - `rules` (verbatim prompt
  instructions) and `guide` (paths the agent must read first) are re-read from
  the manifest between iterations, so you can steer a running loop instead of
  killing it.
- **Self-owned run log + `loop report`** - every run tees to
  `.pi/harness-run.log` (no redirection needed; `--no-log` opts out), and
  `loop report` renders the failing trend, kept/rolled-back, escalations,
  timeouts, scope reverts, slowest sensors, and every never-passing sensor
  WITH its last output - so an expensive LLM sensor's rejection is a
  diagnosis in the report, not a name you have to re-run to understand.
- **process reaping** - a sensor or agent that backgrounds a server (`go run
  . serve &` then killing the wrapper, not the binary) used to leave it bound,
  so the NEXT run's feature sensors passed against a tree that implemented
  nothing. Both process groups are SIGKILLed after each completes. Neither
  GNU `timeout` (signals only on deadline) nor `systemd-run --scope` (does not
  reap on normal exit) covered this.
- **`after` sensor gating** - `"after": ["build", "test"]` skips an expensive
  sensor until the cheap ones are green. The judge measured 147s of a frontier
  model per iteration against under 30s for the other 22 sensors combined, and
  it was paying that on iterations where the build was broken. Skipped counts
  as failing, never as passing.
- **`loop report --prompt N`** - the exact text iteration N was handed,
  captured before the agent starts. The report shows what the loop observed;
  this shows what it said, which is where its own bugs turned out to live.
- **`loop verify-sensors`** - mutation-test the sensor set before trusting it:
  each sensor declares a `canary` that plants the fault it exists to catch, and
  the tool asserts the sensor's state FLIPS, then reverts. Catches the two
  failure classes the manifest could not: a guard that can never go red, and a
  feature sensor that can never go green. Presets ship canaries.
- **`--trial [N]`** - cap the run at N iterations and get a verdict about the
  HARNESS: sensors moved (re-run for real) vs `TRIAL STALLED` (the sensors are
  the bug, here's the checklist).
- **negative-knowledge history** - each iteration's touched files are recorded
  (pre-revert), and rolled-back attempts are injected into later prompts
  ("Previous approaches that were rolled back - do not repeat them"), so a
  fresh iteration can't re-attempt a proven dead end.
- **remediation hints** - a per-sensor `hint` is appended to the feedback on
  failure ("how to fix: ..."), so the model gets guidance, not just the error.
- **freeze mode** (`baseline: true` / `--freeze`) - tolerate sensors already
  failing at baseline; only NEW failures gate (adopt a legacy repo).
- **browser-assert** - a dependency-free headless-Chromium behaviour sensor for
  web targets (CDP over Bun's WebSocket; no puppeteer/playwright; self-bounding
  per-command timeout). Scripts ordered flows - `--wait`/`--click`/`--type`/
  `--press` (trusted Input events)/`--assert`/`--screenshot` (+`--viewport`/
  `--full-page`) - so it gates real interactions, produces a PNG the model can
  `read`, and doubles as a UI live-smoke tool against a deployed URL.
- **judge** - an *inferential* (LLM-as-judge) sensor, two modes: **code** feeds
  the git diff + spec to a second `pi -p` (green-but-wrong, misunderstood spec,
  self-weakened tests); **visual** (`--url`) screenshots a live dev server via
  browser-assert and has a vision model judge the rendered **UI/UX** (layout,
  overflow, unstyled/broken render) - the gate a DOM assert can't be. Both gate
  on `VERDICT: PASS/FAIL`, fail-closed; run LAST with a stronger `--model`.
- **pixel-diff** - a *computational* visual-regression sensor: diffs a capture
  against a committed approved-baseline PNG (YIQ perceptual, AA-tolerant; zero
  dep). The deterministic counterpart to the vision judge - use it to lock a
  stable page against exact pixel regressions; `--update-baseline` to reapprove.

Sensor types to reach for: build/typecheck/unit (fast gate), **structural /
architecture** (`golangci-lint` depguard, `dependency-cruiser`, `import-linter`,
ArchUnit - fitness functions), **security / drift** (`osv-scanner`, `gitleaks`),
**mutation testing** (gremlins/StrykerJS/PIT - grades test quality; expensive,
post-fast-sensor), **browser e2e** (`browser-assert`), and the **inferential
gate** (`judge` - correctness against the spec).

## Test

```bash
bun test    # 200: pure-helper + arg-parser unit; governor/dirty/freeze/subdir-scope/head-reset/index-guard/sandbox/timeout/canary integration; CDP; browser flow/screenshot/hardening; judge code + visual gate; pixel-diff decode/diff/baseline
```

See [`SKILL.md`](./SKILL.md) for the manifest reference, the harnessability
guidance, and the behaviour-harness limits.
