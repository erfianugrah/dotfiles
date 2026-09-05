---
name: self-correcting-loop
description: "Use when the user wants to set an agent in an unattended loop or run a task autonomously until objective sensors pass - build/lint/test/typecheck gates, mutation testing, security scans, headless-browser DOM asserts, LLM-as-judge, pixel-diff, prose linting. Fires on 'set an agent in a loop', 'run a loop', 'self-correcting', 'harness.json', 'UI/UX gate against a dev server', 'make a weaker model reliable'. NOT for per-task subagents inside one session (subagent-driven-development)."
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

The second source is the published write-up of the Bun Zig-to-Rust
rewrite[^bun] - the largest public run of this pattern (1,448 files,
6,778 commits, 11 days, ~64 concurrent agents, 0 tests skipped or deleted).
Everything below marked *(Bun)* is imported from that post's hard-won
mechanics rather than invented here.

[^bun]: <https://bun.com/blog/bun-in-rust>

## The governor in one screen

The loop is a deterministic outer harness around a fresh `pi -p` per
iteration: run the sensors, feed the failing output back as the next prompt,
stop only when every sensor exits 0. Around that bare loop (all deterministic,
no extra model calls):

- **git checkpoint + regression rollback** - the index is the best-known-good state; an iteration that regresses or stalls is reverted
- **writeScope fence** - out-of-scope edits reverted each iteration (kills the test-weakening cheat)
- **ref-guard + index-guard** - agent-run `git commit`/`git reset`/`git stash`/`skip-worktree` cannot move or destroy the checkpoint
- **wall-clock budgets** - every sensor and every agent iteration is bounded; a process past its budget is process-group-killed and reported, never hung
- **process reaping + PID namespace** - nothing a sensor or agent backgrounds survives it
- **resource limits** - optional `systemd-run --scope` cgroup per sensor
- **model escalation ladder** - cheapest rung first, climb after `stallPatience` no-progress iterations
- **bwrap sandbox** - read-only `/`, writable repo + /tmp, `~/.pi/agent` on a discarded overlay, secret dirs masked
- **negative-knowledge history** - rolled-back attempts are injected into later prompts so a fresh iteration cannot repeat a proven dead end
- **hot-reloaded `rules` and `guide`** - steer a running loop by editing the manifest
- **standing anti-cheat guardrails** in every prompt, plus `after` gating so expensive sensors wait for the cheap ones
- **run report + run log + cross-repo journal** - `.pi/harness-report.json`, `.pi/harness-run.log`, `~/.local/share/loop/runs.jsonl`

Each mechanism, the failure it exists for, and what the A/Bs measured:
docs/governor.md (read when a run did something you did not expect, or before
changing loop.ts).

## Files

| File | Role |
|---|---|
| `harness.ts` | Pure core: manifest schema/validation, prompt + feedback + attempt-history builders, stack detection, glob/scope, decide/ladder logic, run classification. Unit-tested. |
| `loop.ts` | CLI driver (Bun): spawns `pi -p`, runs sensors, git checkpoint/rollback, scope guard, ref/index guards, sandbox, escalation, report, journal. |
| `presets/*.json` | Starter manifests per stack (go/node/rust/astro/python/docs), each sensor with a canary. |
| `package.json` | `@erfianugrah/pi-loop`: `bin` entries for the five CLIs, `bun test`. |
| `README.md` | 30-second start for the package; this SKILL.md is canonical. |
| `docs/governor.md` | The mechanism and every governor guard, with the failure each exists for. |
| `docs/models.md` | Model ladder notes: gateway rungs, OpenRouter fallback, local rung rules, judge-only-red endgame. |
| `docs/sensors.md` | `browser-assert`, `judge` (code + visual), `pixel-diff`, `prose-lint` reference. |
| `docs/lessons.md` | Harnessability lessons: sensor shapes, verify-sensors, journal, reading a run, vacuous sensors, operator traps. |
| `harness.test.ts` | Unit tests for the pure helpers. |
| `loop.integration.test.ts` | End-to-end governor test with a scripted fake agent (rollback / stall+escalate / scope-revert / pass) - no real model needed. |
| `loop-timeout.integration.test.ts` | Wall-clock budgets: hung sensor killed + rendered as a HANG, per-sensor override, fast sensor untouched, hung agent reaped, `--trial` stall verdict. Each case would hang forever without the deadline. |
| `loop-verify.integration.test.ts` | `verify-sensors` end-to-end: catches a real `grep -v` inverted-negation sensor as STUCK, proves a feature sensor's flip, confirms an un-canaried sensor is never executed, tree restored after every canary, `--only` / `--strict` / broken-canary / non-git paths. |
| `loop-premise.integration.test.ts` | `kind: "premise"` end-to-end: a false premise refuses the run (exit 2) and says fix the SPEC, a premise that holds is reported and then dropped from the gating set, a false premise outranks an ordinary failing guard, and `verify-sensors` skips premises rather than filing them as uncanaried. |
| `loop-steering.integration.test.ts` | `guide`/`rules` reach the real prompt, a rule appended DURING iteration 1 is in force for iteration 2, and a half-saved manifest is ignored rather than fatal. |
| `loop-logpath.integration.test.ts` | Redirecting the run log INTO the repo is eaten by the scope guard: 3-arm A/B (outside repo / inside repo / no writeScope) plus the pre-checkpoint warning. |
| `loop-runlog.integration.test.ts` | The loop owns its trace: `.pi/harness-run.log` with no redirection, appends across runs, `--no-log`, loop artifacts are not dirt / not scope violations / not changed-files / never staged / not deleted by a rollback's `git clean`, a failing sensor's output survives into the report, and `loop report` renders + fails cleanly. |
| `loop-reap.integration.test.ts` | A sensor or agent that backgrounds a process leaves nothing alive: the leak that made four feature sensors pass against an unimplemented tree. Also pins that reaping happens AFTER the output drain, so the diagnosis survives. |
| `loop-dirty.integration.test.ts` | Dirty-tree guard: aborts (exit 2) without `--allow-dirty`, proceeds with it, `--dry` is exempt. |
| `loop-freeze.integration.test.ts` | Freeze mode: a baseline failure is red without `--freeze`, tolerated with it; only NEW failures gate. |
| `loop-head-reset.integration.test.ts` | Ref-guard: an agent-run `git commit` is undone (HEAD back to the checkpoint, checkpoint tree re-read) and the scope fence still fires on the committed files. |
| `loop-index-guard.integration.test.ts` | Index-guard: `update-index --skip-worktree` evasion neutralized, `reset --hard` cannot destroy the staged checkpoint, `stash` is detected and surfaced. Each case proven to fail with the guard disabled. |
| `loop-sandbox.integration.test.ts` | bwrap jail: escape attempts fail when sandboxed, the same escape succeeds with `sandbox: "off"` (discrimination), `"require"` without bwrap aborts (exit 2) before any iteration. |
| `loop-subdir-scope.integration.test.ts` | writeScope matching when the loop runs in a SUBDIR of the repo: an in-scope edit is not mis-flagged (repo-root vs cwd-relative paths). |
| `loop-journal.integration.test.ts` | Run journal: one JSON line per completed run in `$LOOP_JOURNAL`, `already-green` early exit with zero iterations, failure-mode tags, `loop history` table and `--json`. |
| `browser-assert.ts` | Dependency-free headless-Chromium sensor (CDP over Bun's WebSocket - no puppeteer/playwright). Ordered flow steps (wait/click/type/press/assert/screenshot) + viewport/full-page. The behaviour-harness layer for web targets; also a UI live-smoke tool. |
| `browser-assert.parse.test.ts` | Arg parser: url first, defaults, step ORDER preserved across kinds, `--type` arity, viewport/full-page/timeout, bad-input rejection. |
| `browser-assert.cdp.test.ts` | The CDP client never hangs the sensor: timeout on a wedged browser, reject on a dropped socket, reject after close. |
| `browser-assert.integration.test.ts` | Drives real Chromium against a fixture page (skips if no browser). |
| `judge.ts` | Inferential (LLM-as-judge) sensor with two modes: CODE (feeds the git diff + spec to a second `pi -p`) and VISUAL (screenshots a live URL via browser-assert and has a vision model assess the rendered UI/UX). Both gate on `VERDICT: PASS/FAIL`. Fail-closed by default. |
| `judge.parse.test.ts` | Arg + verdict parsing (including markdown-decorated verdicts). |
| `judge.integration.test.ts` | End-to-end with a scripted fake judge via `$LOOP_JUDGE_CMD`: code gate, visual gate, adversarial N, empty-diff short-circuit. |
| `pixel-diff.ts` | Computational visual-regression sensor: diffs a capture against a committed approved-baseline PNG (YIQ perceptual threshold, AA-tolerant). Zero-dep - PNG decode/encode via `node:zlib`. |
| `pixel-diff.parse.test.ts` | Decode/encode round-trip, YIQ delta, diff logic, arg parsing. |
| `pixel-diff.integration.test.ts` | Baseline lifecycle (missing baseline written + FAIL, `--update-baseline`), tolerance, `--url` capture. |
| `prose-lint.ts` | Computational prose sensor: markdown-aware segmentation, a slop score over discriminating lexical categories, and structural gates a rewrite cannot satisfy by cheating. Zero-dep. |
| `prose-lint.parse.test.ts` | Segmentation, sentence splitting, each detector, threshold evaluation. |
| `prose-lint.integration.test.ts` | Exit codes, `--before HEAD` fact retention against a real git repo, ratchet lifecycle, config merge. |

## Usage

This skill is also the `@erfianugrah/pi-loop` package (Bun >= 1.3, zero
runtime dependencies). Get the five bins on PATH once:

```bash
cd ~/.pi/agent/skills/self-correcting-loop && bun link   # provides `loop`, `browser-assert`, `judge`, `pixel-diff`, `prose-lint`
```

Each bin prints its usage when run with no or bad arguments (`loop` alone
lists `run|init|verify-sensors|report|history`); there is no `--help` flag.
Without `bun link`: `bun ~/.pi/agent/skills/self-correcting-loop/loop.ts run`.

Then, from the **target project root** (the repo the loop should work on):

```bash
# 1. write .pi/harness.json (auto-detects stack from go.mod/package.json/...)
loop init                   # or: init go | node | rust | astro | python

# 2. edit .pi/harness.json: set "task", tune "sensors", pick "models"

# 3. see what the sensors say right now, without spawning pi
loop run --dry

# 4. de-risk the harness before spending the budget (see below)
loop run --trial            # or --trial 3

# 5. run the loop
loop run
loop run --model claude-sonnet-5 --max 15    # weak-model test

# 6. afterwards: outcomes across repos over time
loop history              # cross-repo journal: result, failure modes, per-model perf
loop history --json | jq .
loop run --allow-dirty                        # skip the clean-tree guard
```

### `--trial`: prove the harness converges before paying for it *(Bun)*

The Bun rewrite ported **3 files** through the full implementer/reviewer/fixer
pipeline before turning it loose on all 1,448. `--trial [N]` (default 2) is
that step: cap the run at N iterations and print a verdict about the HARNESS
rather than the code.

- every sensor moved but not all green -> "the harness converges, re-run
  without `--trial`" (exit 1)
- **some sensor never passed** -> `trial-partial` (exit 1), naming them and
  routing to `loop verify-sensors --only <name>`
- nothing moved at all -> `TRIAL STALLED` (exit 1, `result: "trial-stalled"`)
  with the diagnostic checklist: over-specified sensor, sensor asserting
  something the task never asked for, task too vague or too large, agent
  timing out.

The middle case exists because the original aggregate-count verdict was
*measured wrong* on the most realistic fault. Calibration, 3 arms, full run
as ground truth:

| sensors | trial (N=2) | full run | old verdict |
|---|---|---|---|
| only-unsatisfiable | stalled | fail | correct |
| satisfiable + one unsatisfiable | moved 2 -> 1 | **fail** | **"converges, re-run"** |
| fully satisfiable | pass | pass | correct |

A mostly-good sensor set with one unsatisfiable sensor shows progress on the
others, so the aggregate count drops and the old verdict said "converging" -
after which the full run burned every iteration and failed. Per-sensor
movement is the signal the count hides. It is evidence, not proof: a sensor
that genuinely needs three iterations looks identical at N=2, which is why the
message says "check these first" rather than declaring the harness broken.

A failing set that does not move is almost never "needs more iterations" - it
is a harness bug. A real run burned five iterations and ~30 minutes before the
sensors were diagnosed as the problem (docs/lessons.md, "Feature sensors must
be red at baseline"); a trial would have said so in one.

### Steering a run without killing it *(Bun)*

`rules` and `guide` are re-read from the manifest **between iterations**. When
you are watching a run and see the agent do something dumb, append a rule to
`.pi/harness.json` and save - the next iteration obeys it. Fix the process
that generates the code, not the code. An invalid/half-saved manifest is
ignored (last good values are kept), so editing mid-run cannot crash the loop.

Env hooks (mainly for tests): `LOOP_PI_CMD` (agent command, default `pi` -
integration tests substitute a scripted fake), `LOOP_SANDBOX` (override the
manifest's `sandbox` mode), `LOOP_BWRAP` (path to a specific bwrap binary).

The loop refuses a **dirty working tree** by default; commit/stash first, or
pass `--allow-dirty`. (`--dry` is exempt: it runs no git ops.) With
`--allow-dirty` your uncommitted work is safe: the first checkpoint
(`git add -A`) snapshots it into the index and every revert/rollback restores
from that checkpoint index, never from HEAD - so pre-existing uncommitted
changes round-trip intact, and only files the agent actually touched since
the last checkpoint are scope-checked or rolled back.

Operator traps around dirty trees, killed runs and baseline-green feature
sensors: docs/lessons.md ("Operator traps", "Feature sensors must be red at
baseline") - read before the first run on a repo you care about.

`run` exit codes: `0` all sensors green, `1` still red after budget, `2` manifest/usage error, `3` all green, pending human review

## The manifest (`.pi/harness.json`)

```json
{
  "task": "Add a WeChat OAuth provider module; loop until conformance passes.",
  "maxIterations": 12,
  "models": ["claude-sonnet-5", "claude-opus-4-8"],
  "stallPatience": 3,
  "tools": ["read", "edit", "write", "bash"],
  "writeScope": ["providers/wechat/**"],
  "timeoutMs": 600000,
  "agentTimeoutMs": 1800000,
  "limits": { "memoryMax": "8G", "cpuQuota": "400%", "tasksMax": 4096 },
  "humanGate": false,
  "guide": ["docs/provider-contract.md"],
  "rules": ["never add a dependency; the stdlib covers this"],
  "sensors": [
    { "name": "build", "cmd": "go build ./..." },
    { "name": "vet",   "cmd": "go vet ./..." },
    { "name": "test",  "cmd": "go test ./...", "timeoutMs": 1200000 },
    { "name": "test-count-floor",
      "cmd": "test $(go test ./... -list '.*' | grep -c '^Test') -ge 42",
      "hint": "tests were removed or stopped being collected - restore them" },
    { "name": "feature-wechat-provider", "expect": "fail",
      "cmd": "go test ./providers/wechat -run TestWeChat -count=1",
      "hint": "the provider must round-trip an auth code; see the module spec" },
    { "name": "judge", "after": ["build", "test"],
      "cmd": "judge --base HEAD --spec '...' --model anthropic/claude-opus-5" }
  ]
}
```

- `task` - the feed-forward instruction. Keep it scoped; one module/feature.
- `expect` - `"fail"` marks a FEATURE sensor that must be red on the unchanged
  tree; the run is refused if it is green (docs/lessons.md, "Feature sensors
  must be red at baseline"). Omit it for guards.
- `humanGate` - optional boolean (default false). If true, a converged run
  prints PENDING HUMAN REVIEW and exits `3` instead of `0`, so CI can route
  green-but-high-blast-radius work through a human gate. The baseline-green
  early exit is unaffected.
- `after` - names of sensors that must PASS in the same pass before this one
  runs. Cost control for expensive gates: on a real run the judge cost 147s of
  a frontier model per iteration while the other 22 sensors together took under
  30s, and it paid that even when `build` was red - where an inferential
  reviewer has nothing useful to say about code that does not compile. A
  skipped sensor is NOT a passing one: it counts as failing, so the run can
  never be declared done on a pass where it did not execute, and it is recorded
  as `skipped` so `never passed: judge` cannot quietly mean `never ran`. Its
  feedback to the model is one line, not a stale command and hint dressed up as
  a failure. Dependencies must be declared earlier in the list, which makes
  cycles impossible without a graph walk.
- `kind` - `"premise"` marks a claim about the CURRENT tree that the spec rests
  on. It must be green at baseline; red refuses the run because the spec is
  wrong, not the tree. Baseline-only: it never gates an iteration, never reaches
  the model, and is skipped by `verify-sensors`. Cannot carry `expect` or
  `canary`. See docs/lessons.md, "Count the spec's universals".
- `sensors` - the feedback controls. Each `cmd` runs under `bash -lc`; exit 0 =
  pass. Order them cheap-to-expensive (build before test) - all must pass. Each
  sensor may carry an optional `hint` string, appended to the feedback when it
  fails ("how to fix: ...") - author it for the *class* of failure, so the model
  gets remediation guidance, not just the error.
- `models` - the escalation ladder, cheapest first (`""` = pi default). Legacy
  `model` (string|null) is still accepted and normalized to a one-rung ladder.
  CLI `--model` overrides to a single rung.
  Rung recommendations - gateway-hosted open-weight rungs, the OpenRouter
  fallback ladder, the $0 local llama-server rung and its working-window
  rules, and the judge-only-red endgame policy - are in docs/models.md (read
  when picking a ladder or when a gateway drains mid-run).
- `stallPatience` - consecutive no-progress iterations before climbing a rung.
- `timeoutMs` / `agentTimeoutMs` - wall-clock budgets in ms (defaults 600000 /
  1800000). A sensor may override with its own `timeoutMs`; give the slow tier
  (e2e, mutation testing) a bigger one rather than raising the global default.
  A timed-out sensor is rendered to the model as a HANG with a distinct hint
  ("look for a command that never exits") - diagnosing a hang as a logic bug is
  a guaranteed wasted iteration.
- `limits` - `{ memoryMax, cpuQuota, tasksMax }`, applied to each sensor via
  `systemd-run --user --scope`. Values pass through verbatim as systemd
  properties. Skipped with a warning when `systemd-run` is absent.
- `rules` - standing instructions appended verbatim to every prompt.
  **Hot-reloaded between iterations** - this is the mid-run steering lever.
- `canary` (per sensor) - a command planting the fault the sensor catches;
  drives `loop verify-sensors`. Absent = that sensor is reported unverified.
  Sensor-authoring trap: mind PIPELINE exit codes -
  `cmd | rg -c x | awk '{exit ($1 >= 3 ? 0 : 1)}'` passes vacuously when the
  input is empty (awk exits 0 on no lines), so the sensor was green at
  baseline and the run would have been refused. Prefer
  `test $(rg -c pat file || echo 0) -ge 3` - explicit zero, explicit compare.
  `loop run --dry` prints baseline states; check every `expect: fail` sensor
  is actually red before launching.
- `guide` - paths to binding convention documents, injected into every prompt
  as "read these first". Also hot-reloaded. Write the guide BEFORE the loop
  runs, and review it as carefully as code - every iteration is judged against
  it.
- `baseline` (or CLI `--freeze`) - freeze mode: sensors already failing at the
  baseline run are tolerated as pre-existing debt; only NEW failures gate. Lets
  the loop adopt a legacy repo without a green-the-world sprint first (ArchUnit
  `freeze`).
- `writeScope` - globs the agent may write (`*` within a segment, `**` across).
  Globs are **cwd-relative** (the dir you launch the loop from), so running in
  a repo subdir with `writeScope: ["bin/migrate.sh"]` matches correctly even
  though git reports repo-root-relative paths internally.
  Empty = unrestricted. Requires the target to be a git repo.

  The fence also shapes the architecture the agent can produce: fencing off
  the natural home for shared code makes the agent invent a worse one.
  Worked example in docs/lessons.md ("The fence shapes the architecture").
- `sandbox` - `"auto"` (default: jail the agent with bwrap when available,
  warn + run bare otherwise), `"require"` (abort without bwrap), `"off"`.
  `LOOP_SANDBOX` env overrides; `LOOP_BWRAP` points at a specific bwrap
  binary. Jail semantics: docs/governor.md.

> The governor (checkpoint/rollback/scope/escalation) needs a **git repo** with
> a committed baseline. Without git it degrades to feed-forward-only and warns.

## Sensor tools

`browser-assert` (DOM flows + screenshots), `judge` (LLM-as-judge on the diff,
or a vision judge on a live URL), `pixel-diff` (approved-baseline PNG diff) and
`prose-lint` (slop score + structural gates for docs) are documented in
docs/sensors.md - read when wiring a web target, an inferential gate or a
writing gate into a manifest. Rule of thumb: everything mechanical is an
`--assert` or a counter; the judge is for what genuinely needs judgment, runs
LAST, and uses a model other than the writer rung.

Sensor authoring - vacuous sensors, `verify-sensors` canaries, counting the
spec's universals, premise sensors, structural and security gates - is
docs/lessons.md; read it before trusting a new manifest.

## Limits (be honest about these)

- **Behaviour harness gap.** Green *computational* sensors prove the code passes
  *the checks*, not that it does *the right thing*; if the model wrote the tests
  too, that's a closed loop. Mitigations shipped: conformance suites + fixtures
  you control, mutation testing (test quality), the inferential `judge` (code
  correctness + rendered UI/UX), and `pixel-diff` (exact visual regression). But
  inferential sensors are probabilistic and `pixel-diff` needs an approved
  baseline - they raise confidence, they do not remove the need for a clear
  spec (next point).
- **Correctness needs specification.** The loop cannot fix a vague `task`. A
  misunderstood instruction converges on green-but-wrong. Scope tightly.
- **Not for unfenced blast radius.** Great for greenfield modules and
  test-fenced changes; not for "loop on the payments service unattended".
- **Serial, single-agent.** The Bun run peaked at ~64 agents across 4
  worktrees, sharding a 16,000-item compiler-error queue by crate. That is
  worth it when failures are numerous AND independent; for a single scoped
  feature it is pure coordination cost, and their own false start (agents
  running `git stash` / `git reset --hard` on each other) is precisely what
  this loop's ref-guard and index-guard already solve for the serial case.
  The transferable half without parallelism: when one sensor emits many
  independent failures, feed the model one GROUP at a time instead of the
  whole wall of errors.
- **No separate fixer role.** See the judge section of docs/sensors.md -
  reviewer/implementer are split, implementer/fixer are not.
- **Timeouts bound the loop, not the spend.** A budget stops a hang; it does
  not stop N iterations of expensive-but-productive work. `maxIterations` and
  the model ladder are the cost controls.
- **Escalation can be triggered by a harness defect, and then it is the wrong
  remedy.** The 2026-08-05 eaves run is the case study. Iteration 4: the agent
  built all 15 endpoints, left the code unformatted, went 1 -> 2 failing,
  reverted. Iteration 5: broke the build, 1 -> 12, reverted. Iteration 6:
  rebuilt all 15 endpoints, left the code unformatted again, 1 -> 2, reverted -
  byte-for-byte the same failure as iteration 4. Three consecutive
  no-progress iterations tripped `stallPatience: 3` and the ladder escalated
  haiku -> sonnet.

  Sonnet then passed everything on iteration 7, `gofmt` included, and the run
  ended green. So escalation WORKED - I predicted it would fail the same way
  and it did not.

  But look at what the cheap model was up against. Feedback is built from the
  best-known-good state, so after iteration 4 was reverted, the prompt for
  iteration 5 described iteration 3's failures - judge only. The word `gofmt`
  never appeared. The attempt history said `touched serve.go (failing 1 -> 2,
  rolled back)` without naming what broke. **The failure that causes a rollback
  was the one thing the next prompt could not see**, so iteration 6 walked into
  it again, and the loop read the repetition as the model being too weak.

  Two fixes, both cheaper than a model rung: the gate list is now derived from
  the manifest so the agent knows `gofmt` is a gate before it declares success,
  and the attempt history now names the sensors each rejected attempt broke.
  Generalisation: before reading a stall as "the model is too weak", check
  whether the loop ever told it what it was being judged on. `loop report
  --prompt N` answers that in one command - it exists because this took an hour
  of reading raw logs to see.

- **The governor's later rungs are thinly evidenced.** As of that run,
  rollback-on-no-progress and `stallPatience` escalation have both fired for
  real. The negative-knowledge history and the upper rungs beyond the first
  escalation are still exercised only by scripted agents in
  `loop.integration.test.ts`. Treat those as designed-and-unit-tested, not as
  field-proven.
- **A crashed agent iteration can read as "progress" and eat the escalation
  it should have triggered.** Observed 2026-08-13 (composer run-persistence
  run, local Gemma rung): the agent died mid-iteration with a malformed
  tool-call (`pi -p` exit 1, zero tree changes), the governor continued,
  sensors re-ran on the unchanged checkpoint, and the verdict printed
  `failing 3 -> 3 (progress)` - the stall counter reset on an iteration where
  the agent did literally nothing, so `stallPatience: 2` never fired and the
  local model kept (and wasted) the final iteration. Read "(progress)" with
  the iteration's agent exit status, not just the sensor delta: an
  agent-exit-1 iteration is definitionally no-progress. Related crash surface,
  now patched in `loop.ts`: an agent that writes thousands of files into the
  repo (a repo-local build cache was the observed case) made the
  scope-violation note embed every path into the next prompt's argv and
  `posix_spawn` died with E2BIG - the note is now capped at 20 paths, and the
  harness rule "GOCACHE/GOMODCACHE under /tmp" prevents the trigger.

  That first real rollback is also the clearest statement of the aggregate
  count's limit. The discarded iteration had built 15 working endpoints and
  failed on `gofmt`; `1 -> 2 failing` is the correct reading of every signal
  the loop had, and it still threw away substantive work over a formatting
  error.

  Note what does NOT fix it. `after` gating would have skipped the judge (its
  dependency was red) and saved 147s - but a skipped sensor counts as failing,
  so the count is still `1 -> 2` and the rollback still happens. Per-sensor
  movement does not save it either: `gofmt` green -> red is a regression and
  `judge` red -> red is not an improvement, so every available signal agrees.
  The derived gate list is the only one of today's changes that addresses the
  cause, by telling the agent `gofmt` was a gate before it declared success.

  The information the loop actually lacks is a GRADIENT on the binary
  inferential sensor. An iteration that resolves five of the judge's seven
  objections is indistinguishable from one that resolves none, so work aimed
  at the persistent blocker is invisible to the keep/rollback decision and any
  incidental regression outweighs it. A scored judge would change this; the
  reviewer tally (`1/2` vs `2/2` rejected) is already computed and discarded.
  Unproven either way - reviewer disagreement is partly variance, and that
  needs measuring before it is trusted as signal.

## Interaction with `epistemic-guard`

Each iteration is a fresh `pi -p`, so the guard's provenance corpus starts
EMPTY every pass. Consequences:

- The answer footer is disabled under `pi -p` (it would corrupt captured
  stdout / a subagent's return payload), so it cannot affect a sensor.
- Write blocks still apply, but capped at `PI_EPISTEMIC_MAX_BLOCKS` (default 3)
  per iteration; after that the guard degrades to observe-only. Worst case is a
  few extra turns, not a wedged loop.
- If a loop keeps tripping it, the corpus is the problem, not the guard: have
  the `task` prompt read the source of truth (lockfile, `--help`, the doc)
  before writing docs about it. That is the behaviour you wanted anyway - a
  loop that writes version numbers from memory produces green-but-wrong docs.
- Escape hatches: `PI_EPISTEMIC_MAX_BLOCKS=0` (observe-only),
  `PI_EPISTEMIC_GUARD_OFF=1` (off). Set them in the loop's environment, not
  globally.

## Testing this skill

```bash
cd ~/.pi/agent/skills/self-correcting-loop && bun test harness.test.ts   # pure helpers
cd ~/.pi/agent/skills/self-correcting-loop && bun test                   # everything
```

The `limits` path is A/B-verifiable by hand - with `limits` set, a sensor
reading its own cgroup sees the cap; without it, the same check fails:

```bash
# sensor cmd, passes only when MemoryMax=512M is actually applied
cat /sys/fs/cgroup/$(cat /proc/self/cgroup | tail -1 | cut -d: -f3 | sed 's|^/||')/memory.max | grep -q 536870912
```
