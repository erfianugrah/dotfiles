---
name: self-correcting-loop
description: "Run an unattended, sensor-gated agent loop that drives a fresh pi -p each iteration until the sensors pass, then stops. Sensors span computational (build/lint/test/typecheck, architecture fitness, mutation testing, security/drift scans, headless-browser DOM asserts) and inferential (LLM-as-judge on the diff; vision judge + pixel-diff for rendered UI/UX). Use when the user wants to 'set an agent in a loop', run a task autonomously, self-correct without supervision, add a UI/UX or visual-regression gate against a live dev server, an LLM-as-judge correctness gate, or make a weaker model (Sonnet/GLM/DeepSeek) reliably good on a scoped task. The model never decides 'done' - the sensors do. Language-agnostic - sensors are command strings in a per-project .pi/harness.json (go/node/rust/astro/python presets). Ships browser-assert (headless-Chromium DOM/flow/screenshot), judge (code + visual gate), and pixel-diff (visual-regression). Pairs with scaffold-new-project, frontend-stack, and software-architecture."
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

## The mechanism

```
checkpoint = git index (best known good)
repeat until every sensor exits 0, OR maxIterations spent:
    pi -p  <task + previous iteration's failing sensor output + loop notes
            + rolled-back attempt history (negative knowledge)>
    jail the agent (bwrap: ro /, rw repo+tmp, overlayfs on ~/.pi/agent,
        masked ~/.ssh et al) - unless sandbox: "off"
    undo any agent-run git commit/reset (HEAD back + checkpoint restored)
    re-impose the checkpoint index (index-guard)
    revert any edits outside writeScope
    run sensors (build / vet / test / tsc / clippy / astro check ...)
        each under a wall-clock budget + optional cgroup caps
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
- **ref-guard** - if the agent runs `git commit`/`git reset` mid-iteration
  (plan docs often instruct per-task commits), the move is undone before the
  footprint capture: HEAD back to the checkpoint. Without this a commit made
  the fence blind (worktree == index = "nothing changed") and baked
  out-of-scope edits into history - observed live on 2026-07-25 in the eaves
  loop run. The iteration prompt also forbids git ref mutations outright.
- **index-guard** - the checkpoint index is re-imposed from its `write-tree`
  snapshot after EVERY iteration (no-op for honest agents). Neutralizes the
  HEAD-preserving attacks: `git reset --hard` / `git checkout -- .` (destroy
  the staged-but-uncommitted checkpoint), `git update-index --skip-worktree`
  (hides a tracked file from `git diff` = fence evasion), and `git stash`
  (hides work from sensors; detected via refs/stash and surfaced as a loop
  note). Tests A/B in loop-index-guard.integration.test.ts are proven to
  fail with the guard disabled.
- **wall-clock budgets** - every sensor gets `timeoutMs` (default 600s,
  per-sensor override) and every agent iteration gets `agentTimeoutMs`
  (default 1800s). A process that exceeds its budget is KILLED and reported as
  a failure, never as a hang. Both spawn sites were previously unbounded, so a
  wedged suite or a stuck `pi -p` stalled the run with no rollback, no
  escalation and no report entry. The kill goes through GNU `timeout`, which
  signals the process GROUP - Bun's native spawn timeout reaps only the direct
  child, leaving grandchildren alive holding the inherited stdout pipe (so
  nothing reading the loop's output ever sees EOF), plus ports and disk.
  Verified in `loop-timeout.integration.test.ts`; the orphan count on a wedged
  agent went 1 -> 0 with the group kill.
- **PID-namespace containment for the sandboxed agent** - the jail adds
  `--unshare-pid`, so bwrap is PID 1 of a namespace the kernel tears down
  whole when it exits. This is NOT redundant with the group kill: bwrap's
  `--new-session` calls `setsid(2)`, which moves the sandbox out of the
  process group GNU `timeout` signals, so the deadline reaps bwrap and
  leaves its descendants running. Found 2026-08-04 when a killed agent kept
  editing a repo for 11 more minutes - the worst failure this loop can have,
  because the governor's checkpoint/rollback accounting no longer covers it
  and the survivor works from stale sensor feedback. `--proc` was already
  present and is only correct inside a new PID namespace anyway.
- **resource limits** *(Bun)* - optional `limits` (`memoryMax` / `cpuQuota` /
  `tasksMax`) wraps each sensor in a transient `systemd-run --user --scope`
  cgroup. Sensors run OUTSIDE the bwrap jail, so nothing else bounds them; the
  Bun run crashed its machine repeatedly on tests that exhausted memory,
  sockets and disk before they reached for cgroups. The scope also makes the
  timeout kill tree-wide by construction.
- **model escalation ladder** - start on the cheapest model; climb a rung after
  `stallPatience` consecutive no-progress iterations. Strength on demand.
- **agent sandbox (bwrap)** - the writeScope fence is repo-scoped; the jail
  covers the rest of the filesystem. `/` is read-only, only the repo cwd and
  /tmp are writable, and `~/.pi/agent` sits under an overlayfs copy-on-write
  mount: pi can write its locks/session files (discarded at exit - loop agent
  sessions never pollute the FTS index), but extensions/skills/auth/settings
  are untouchable, including the stow symlink chain (plain rw-bind + per-file
  ro-binds can't do this - bwrap can't mount over absolute symlink chains, and
  per-file binds don't stop symlink REPLACEMENT). Secret dirs (~/.ssh,
  ~/.gnupg, ~/.aws, ~/.kube, ~/.config/gh) are masked with tmpfs (resolved
  through symlinks). Network stays up - pi needs the model gateway. Sensors
  and the judge run OUTSIDE the jail (operator-configured, trusted).
- **negative-knowledge history** - each iteration's touched files are recorded
  BEFORE any revert, and rolled-back attempts are injected into later prompts
  ("Previous approaches that were rolled back - do not repeat them"). A fresh
  `pi -p` otherwise can't tell a dead end from an untried path, so it can
  re-attempt the exact approach iteration N-3 already proved wrong.
  `formatAttemptHistory` caps the block at the 5 most recent rolled-back
  attempts and truncates long file lists, so the prompt stays sharp.
- **standing rules, hot-reloaded** *(Bun)* - `rules` is appended verbatim to
  every prompt and RE-READ from the manifest between iterations, so a human
  watching a run can correct the loop without killing it. This is the article's
  central operating discipline made mechanical: when the output is wrong, fix
  the process that generates the code, not the code. ("Claude interpreted 'get
  all the crates to compile' as 'stub out the functions'... one prompt edit and
  a few hours later, these things stopped happening.") Only `rules` and `guide`
  are hot - changing sensors or scope mid-run would invalidate the checkpoint
  and progress accounting.
- **binding conventions** *(Bun)* - `guide` lists paths the agent must read
  first (a porting guide, a lifetimes table, an interface spec). Because each
  iteration is a fresh `pi -p`, an on-disk guide is the ONLY channel that
  carries conventions across iterations. The Bun run spent ~3h producing
  `PORTING.md` and a per-struct-field `LIFETIMES.tsv`, adversarially reviewed
  *the documents* before writing any code, and checked every implementer
  against them. Paths are injected, not contents, so a large guide does not
  bloat every prompt.
- **run report** - `.pi/harness-report.json` records model, failing-count
  trend, kept/rolled-back, escalations, scope violations, changed files,
  per-sensor durations, and timeout flags (`timedOut`, `agentTimedOut`) per
  iteration.

Two properties make this work on weak models:

1. **Fresh context per iteration.** Each `pi -p` is a new session. State lives
   in the *filesystem* (the model's prior edits) plus the *injected sensor
   feedback* - never in a bloating conversation that drifts. A weak model with
   a small, sharp prompt beats a strong model with a polluted 200-turn context.
2. **The sensor is the judge.** `go test` exit code is not negotiable. The
   model cannot hallucinate green. `buildPrompt` also injects anti-cheat
   guardrails because gaming the sensor is the #1 weak-model failure mode.
   The list is empirical, not imagined - test-weakening and git-ref mutation
   came from this loop's own runs, and two more come from the Bun rewrite:
   - *no stubbing*: "let's get all the crates to compile" was read as "stub out
     the functions with compilation errors". A build sensor is trivially
     satisfied by `unimplemented!()` / `throw new Error("not implemented")`, so
     the prompt states that a check satisfied by a stub is a FAILED iteration.
   - *no justifying essays*: "If you need a paragraph-long comment to justify
     why the workaround is OK, the code is wrong - fix the code." Used verbatim
     as a reviewer rejection rule; long explanatory comments turned out to be a
     reliable tell for a bad workaround.

   **These guardrails are STANDING - they render on every iteration including
   the first.** They used to live only inside the failure-feedback block, so a
   task the model one-shot received *no guardrails at all*: the iteration-1
   prompt was literally the task string. Found 2026-08-04 by an A/B that
   returned a null because every run converged in one iteration and the rule
   under test was never in the prompt. "Don't weaken tests" is a property of
   how the loop works, not advice about a particular failure. Only the two
   genuinely failure-scoped lines ("don't touch code unrelated to these
   failures", "make the smallest change") stay in the feedback block.

   **Measured effect of the anti-stub rule: none, at this difficulty.** A/B on
   a build-only gate (8 specified functions, `go build` fully satisfiable by
   stubs, hidden acceptance suite scoring the result), 3 runs per arm on
   claude-haiku-4-5: *identical* 8/8 hidden pass, 0 stub markers, 1 iteration,
   in both arms. Controls were sound - a correct implementation scores 8/8,
   pure stubs score 0/8 and still pass the gate. So the rule is unfalsified
   but unproven as a behaviour-changer: the model simply did not want to stub
   8 well-specified textbook functions. The Bun case that motivated it was a
   16,000-error Rust port where implementing correctly was genuinely hard, and
   that difficulty is the variable this experiment could not reproduce.

   Practical consequence: **treat the prompt rule as free but unproven, and
   rely on the `no-stubs` counter sensor for the actual guarantee.** A prompt
   rule is unenforceable by construction; a counter is a gate. If you only
   have budget for one, take the sensor. Harness for re-running the A/B at
   higher difficulty: `~/.local/share/loop-validation/build-gate/`.

## Files

| File | Role |
|---|---|
| `harness.ts` | Pure core: manifest schema/validation, prompt + feedback + attempt-history builders, stack detection, glob/scope, decide/ladder logic. Unit-tested (43 cases). |
| `loop.ts` | CLI driver (Bun): spawns `pi -p`, runs sensors, git checkpoint/rollback, scope guard, escalation, report. |
| `presets/*.json` | Starter manifests per stack (go/node/rust/astro/python). |
| `harness.test.ts` | Unit tests for the pure helpers. |
| `loop.integration.test.ts` | End-to-end governor test with a scripted fake agent (rollback / stall+escalate / scope-revert / pass) - no real model needed. |
| `loop-timeout.integration.test.ts` | Wall-clock budgets: hung sensor killed + rendered as a HANG, per-sensor override, fast sensor untouched, hung agent reaped, `--trial` stall verdict. Each case would hang forever without the deadline. |
| `loop-verify.integration.test.ts` | `verify-sensors` end-to-end: catches a real `grep -v` inverted-negation sensor as STUCK, proves a feature sensor's flip, confirms an un-canaried sensor is never executed, tree restored after every canary, `--only` / `--strict` / broken-canary / non-git paths. |
| `loop-steering.integration.test.ts` | `guide`/`rules` reach the real prompt, a rule appended DURING iteration 1 is in force for iteration 2, and a half-saved manifest is ignored rather than fatal. |
| `loop-logpath.integration.test.ts` | Redirecting the run log INTO the repo is eaten by the scope guard: 3-arm A/B (outside repo / inside repo / no writeScope) plus the pre-checkpoint warning. |
| `loop-runlog.integration.test.ts` | The loop owns its trace: `.pi/harness-run.log` with no redirection, appends across runs, `--no-log`, loop artifacts are not dirt / not scope violations / not changed-files / never staged / not deleted by a rollback's `git clean`, a failing sensor's output survives into the report, and `loop report` renders + fails cleanly. |
| `browser-assert.ts` | Dependency-free headless-Chromium sensor (CDP over Bun's WebSocket - no puppeteer/playwright). Ordered flow steps (wait/click/type/press/assert/screenshot) + viewport/full-page. The behaviour-harness layer for web targets; also a UI live-smoke tool. |
| `browser-assert.integration.test.ts` | Drives real Chromium against a fixture page (skips if no browser). |
| `judge.ts` | Inferential (LLM-as-judge) sensor with two modes: CODE (feeds the git diff + spec to a second `pi -p`) and VISUAL (screenshots a live URL via browser-assert and has a vision model assess the rendered UI/UX). Both gate on `VERDICT: PASS/FAIL`. The computational sensors check the code compiles/passes; this checks it did the *right thing* / *looks right*. Fail-closed by default. |
| `judge.{parse,integration}.test.ts` | Unit (arg + verdict parsing) and end-to-end (scripted fake judge via `$LOOP_JUDGE_CMD`) tests. |
| `pixel-diff.ts` | Computational visual-regression sensor: diffs a capture against a committed approved-baseline PNG (YIQ perceptual threshold, AA-tolerant). Zero-dep - PNG decode/encode via `node:zlib`. The deterministic half of the visual gate. |
| `pixel-diff.{parse,integration}.test.ts` | Unit (decode/encode round-trip, YIQ delta, diff logic) and end-to-end (baseline lifecycle, tolerance, `--url` capture) tests. |

## Usage

This skill is also the `@erfianugrah/pi-loop` package. Get the `loop` and
`browser-assert` commands on PATH once:

```bash
cd ~/.pi/agent/skills/self-correcting-loop && bun link   # provides `loop`, `browser-assert`, `judge`
```

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
is a harness bug. The 2026-08-02 run below burned five iterations and ~30
minutes before the sensors were diagnosed as the problem; a trial would have
said so in one.

### Steering a run without killing it *(Bun)*

`rules` and `guide` are re-read from the manifest **between iterations**. When
you are watching a run and see the agent do something dumb, append a rule to
`.pi/harness.json` and save - the next iteration obeys it. Fix the process
that generates the code, not the code. An invalid/half-saved manifest is
ignored (last good values are kept), so editing mid-run cannot crash the loop.

Without `bun link`, invoke directly: `bun ~/.pi/agent/skills/self-correcting-loop/loop.ts run`.

Env hooks (mainly for tests): `LOOP_PI_CMD` (agent command, default `pi` -
integration tests substitute a scripted fake), `LOOP_SANDBOX` (override the
manifest's `sandbox` mode), `LOOP_BWRAP` (path to a specific bwrap binary).

The loop refuses a **dirty working tree** by default; commit/stash first, or
pass `--allow-dirty`. (`--dry` is exempt: it runs no git ops.) With
`--allow-dirty` your uncommitted work is safe: the first checkpoint
(`git add -A`) snapshots it into the index and every revert/rollback restores
from that checkpoint index, never from HEAD - so pre-existing uncommitted
changes round-trip intact, and only files the agent actually touched since
the last checkpoint are scope-checked or rolled back. (Pre-2026-07-24 the
scope guard restored violations from HEAD and diffed against HEAD, which
destroyed uncommitted out-of-scope work; regression-tested in
loop.integration.test.ts.)

A second 2026-07-24 lesson: on an ADDITIVE-feature task every sensor passes
at baseline, so the loop exits "nothing to do" without iterating. Encode the
desired end state as a feature-present sensor that FAILS pre-change (e.g.
`rg -q <new-symbol> <file>`, `jq -e '.x == false' <cfg>`) - that is what
gives the loop something to converge on.

Mark those `"expect": "fail"`. The run is REFUSED (exit 2) if such a sensor
passes at baseline, because a feature sensor that is already green gates
nothing - the loop can converge having built nothing and still report PASS.
Guards (build/lint/test) default to `"expect": "pass"` and are never flagged.

Two failure modes this encodes, both observed on a real run (2026-08-02,
eaves roadmap Tier 1):

- **Non-discriminating.** Four sensors passed before a line was written,
  because the CLI's handlers silently ignored unknown trailing args - so
  `show interfaces terse` already exited 0 printing the default table.
  Assert the DIFFERENCE: terse must NOT carry the MAC column, the resolved
  log must NOT contain kea lines, the chain view must NOT be the tables
  summary.
- **Over-specified, therefore unsatisfiable.** Two sensors asserted
  IMPLEMENTATION LOCATION (`rg 'destination' internal/show/show.go`) and
  exact doc PHRASING (`rg 'ruleset table' README.md`). The model put the
  filter in the pure parse layer (better) and wrote `ruleset [table <t>]`
  (standard usage syntax) - both correct, both red. Five iterations and
  ~30 minutes burned before the sensors were diagnosed as the bug. Assert
  BEHAVIOUR (`--json ... | jq -e 'length == 3'`), not where code lives or
  how prose is worded. If a sensor stays red across 3+ iterations while the
  feature demonstrably works by hand, suspect the sensor first.

A doc sensor should also grep NEGATIVELY for statements the change
falsifies ("no X yet", a stale count, "duplicates the const"). Presence-only
doc checks pass while the rest of the file still contradicts the feature -
that exact gap shipped a doc asserting the opposite of five shipped items.

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
  "timeoutMs": 600000,
  "agentTimeoutMs": 1800000,
  "limits": { "memoryMax": "8G", "cpuQuota": "400%", "tasksMax": 4096 },
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
      "hint": "the provider must round-trip an auth code; see the module spec" }
  ]
}
```

- `task` - the feed-forward instruction. Keep it scoped; one module/feature.
- `expect` - `"fail"` marks a FEATURE sensor that must be red on the unchanged
  tree; the run is refused if it is green (see the discrimination lesson
  above). Omit it for guards.
- `sensors` - the feedback controls. Each `cmd` runs under `bash -lc`; exit 0 =
  pass. Order them cheap-to-expensive (build before test) - all must pass. Each
  sensor may carry an optional `hint` string, appended to the feedback when it
  fails ("how to fix: ...") - author it for the *class* of failure, so the model
  gets remediation guidance, not just the error.
- `models` - the escalation ladder, cheapest first (`""` = pi default). Legacy
  `model` (string|null) is still accepted and normalized to a one-rung ladder.
  CLI `--model` overrides to a single rung.
  - **Cheap-but-accurate open-weight rungs (via the opencode-zen gateway; ids
    verified in `~/.pi/agent/models-store.json`, which the picker refreshes).**
    `opencode/deepseek-v4-pro` is the cheapest near-frontier rung (top
    open-weight SWE-bench Verified; Artificial Analysis clocks it ~40x cheaper
    per task than Opus 4.8). `opencode/glm-5.2` is the best accuracy-per-dollar
    rung (top open-weight on the AA Intelligence Index, beats GPT-5.5 on
    SWE-bench Pro, roughly 6-8x cheaper output than Opus). The two make a strong
    cheap base under a frontier top (`anthropic/claude-sonnet-5`, or
    `claude-opus-4-8` only if you want the ceiling). `opencode/deepseek-v4-flash-free`
    is a $0 bottom rung for high-volume iterations. Working example:
    `~/knotea/.pi/harness.json` uses
    `["opencode/deepseek-v4-pro", "opencode/glm-5.2", "anthropic/claude-sonnet-5"]`.
  - **Gotcha: Kimi K3 is NOT a cheap rung.** It matches Opus 4.8 on quality (AA
    Intelligence Index ~57) but is frontier-priced (~$3/$15 per M) and is not in
    the opencode-zen catalog anyway. For a Kimi rung use `opencode/kimi-k2.5`
    (cheapest) / `kimi-k2.6` / `kimi-k2.7-code` (coding-tuned). Re-verify all ids
    before relying on them - gateway catalogs drift, and exact prices rot faster
    than the ladder strategy does.
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
- `sandbox` - `"auto"` (default: jail the agent with bwrap when available,
  warn + run bare otherwise), `"require"` (abort without bwrap), `"off"`.
  `LOOP_SANDBOX` env overrides; `LOOP_BWRAP` points at a specific bwrap
  binary. See the governor bullet above for the jail semantics.

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
- **Security / drift sensors** are cheap computational gates the article files
  under "continuous drift" - wire them so an unattended loop physically cannot
  land a leaked key or a known-vulnerable dep. Run them alongside the fast
  sensors: `{ "name": "vuln", "cmd": "osv-scanner -r --lockfile ..." }` (or a
  language lockfile scan) and `{ "name": "secrets", "cmd": "gitleaks dir .
  --no-banner" }`. Pair each with a `hint` telling the model to bump/remove
  the offending dep or move the secret to env, not to delete the scanner.

  **Use `gitleaks dir` (filesystem), NOT `gitleaks detect` (git history).**
  This doc recommended `detect` until 2026-08-09, and it was wrong in two
  compounding ways. `detect` scans COMMITS - but the loop's ref-guard
  deliberately undoes any commit the agent makes, so a leaked key lives in
  the working tree and never reaches history. The guard was structurally
  blind to the only threat model the loop actually has. It is also a
  deprecated alias in current gitleaks (the commands are `dir` / `git` /
  `stdin`), so it logs `0 commits scanned` and exits 0 - green forever.
  `loop verify-sensors` found this: the sensor reported STUCK because the
  canary planted a real token and the state did not change.

  Note the scanner has its own vacuity trap: the canonical AWS example key
  (`AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/...`) is allowlisted and will NOT
  trip it, so a canary built from documentation examples proves nothing. Use
  a `ghp_`- or `xoxb-`-shaped synthetic token.

### `loop verify-sensors`: prove each sensor can flip, before trusting any of it

**Run this on every new manifest, before the first `loop run`.** It is the
cheapest step in the whole workflow and it is the one that catches the
failure class that costs the most.

```bash
loop verify-sensors                 # mutation-test every sensor with a canary
loop verify-sensors --only secrets  # one sensor
loop verify-sensors --strict        # an undeclared canary is a failure
```

Declare, per sensor, a `canary`: a command that plants the exact fault the
sensor exists to catch. The tool applies it, asserts the sensor's state
**flips**, reverts via the git checkpoint, and asserts it comes back.

```json
{ "name": "no-stubs",
  "cmd": "test $(rg -o 'panic\\(\"(TODO|not implemented' --glob '*.go' . | wc -l) -le 0",
  "canary": "printf '\\nfunc c(){ panic(\"not implemented\") }\\n' >> main.go" }
```

**Why this exists.** The governor is well-tested; the sensors are hand-written
shell with no harness of their own - and the loop's entire notion of truth
rests on them. The manifest could already prove ONE endpoint of a sensor's
range and never the other:

- `expect: "fail"` proves a feature sensor is red at baseline. Nothing proved
  it could ever go **green** - an *unsatisfiable* sensor looks identical to a
  healthy one and burns the entire budget (the 2026-08-02 five-iteration burn).
- A guard is green at baseline by definition. Nothing proved it could ever go
  **red** - a guard that cannot fire is indistinguishable from a clean repo.

The canary closes both because it asserts a **flip**, not a direction. Same
mechanism verifies a guard going red and a feature sensor going green.

Verdicts: `flipped` (discriminates), **`STUCK`** (same state with the fault
planted - gates nothing), **`DIRTY`** (flipped but did not restore - the
canary altered the tree or the sensor is non-deterministic), **`CANARY`** (the
canary command itself errored, so nothing was proven), `unverified` (none
declared - not a failure, but not evidence either).

Cost: sensors WITHOUT a canary are never executed, so an expensive judge costs
nothing unless you deliberately give it one. Sensors with a canary run three
times (baseline / faulted / restored).

Requires a git repo - the revert restores from the checkpoint index, so
`--allow-dirty` round-trips uncommitted work intact.

**Preset canaries.** Every shipped preset declares a canary per sensor, so
`loop init && loop verify-sensors` gives a verified base on a new project.
Four were confirmed end-to-end against throwaway projects on 2026-08-09
(`go` 3/3, `python` 3/3, `rust` 3/3, `node` 3/3, each `base pass -> canary
fail -> restored pass`). **`astro` is unverified** - that toolchain is not
installed here, so treat its two canaries as drafts and let
`verify-sensors` tell you. That is exactly the failure mode the command
exists to surface, and it is why a preset canary is a starting point rather
than a guarantee.

Two gotchas found while verifying them, both of which will bite on real
projects:

- **`biome check .` lints `.pi/harness.json` too.** The loop's own manifest
  can turn the lint sensor red (a missing trailing newline is enough), which
  reads as "the repo is dirty" when it is really "the harness config is
  unformatted". Format the manifest or scope the lint command.
- **A syntax error is not a reliable lint canary.** `{a: 1,,}` parses fine
  under biome's tolerant parser and produced no diagnostic. The preset uses
  `debugger;` instead, which trips the recommended `noDebugger` rule.

**Writing a canary that proves something:**

- Plant the *real* fault, not a proxy. `echo bad >> file` does not prove a
  linter works; a genuine lint violation does.
- Beware allowlisted example values. The canonical AWS docs key will not trip
  gitleaks, so a canary built from it "passes" while proving nothing.
- If a sensor reports STUCK, EITHER the check is broken OR the canary plants
  the wrong thing. Diagnose before editing - the first real STUCK found in
  this repo was a broken sensor, and the fix was a different scanner mode.
- A canary that cannot be expressed is a smell: it usually means the sensor
  asserts something too vague to fault deliberately.

### Reading a run: `.pi/harness-run.log` and `loop report`

You do not need to redirect anything. Every run tees its console output to
`.pi/harness-run.log` (append-only, so history accumulates; `--no-log` opts
out). `.pi/**` is exempt from the scope guard, so the loop cannot eat its own
trace. After a run:

```bash
loop report                      # rendered summary of the last run
loop report --report path.json   # or an archived one
```

`loop report` turns the JSON into the thing you actually want after an
unattended run: the failing-count trend, kept vs ROLLED BACK per iteration,
which rung the ladder was on, ESCALATED / AGENT-TIMEOUT / scope-revert flags,
sensors that never passed **and the last output of each**, the slowest
sensors, and the loop's notes.

That per-sensor output is the difference between a verdict and a diagnosis.
The first real multi-iteration run ended `never passed: judge` - a sensor that
had spent 147 seconds of a frontier model per iteration writing a detailed
rejection, none of which was recorded anywhere. The text existed in memory
(the agent is fed it as the next prompt's feedback) and was dropped on the way
to the report. Failing sensors now persist a 4,000-char tail; passing ones
stay silent, because a passing sensor's output is noise.

The loop's own artifacts (`.pi/harness-run.log`, `.pi/harness-report.json`)
are excluded from the dirty-tree check, the scope fence, the changed-files
history, the checkpoint index, and the rollback `git clean`. Otherwise:

- the loop refuses to start because of its own output (what happened the first
  time the run log was added),
- `git add -A` stages the log, so it enters the diff a judge sensor reviews
  (one promptly flagged it as out-of-scope noise, correctly) and any commit you
  make after a run,
- and once unstaged, an unqualified `git clean -fdq` on rollback deletes the
  trace at exactly the moment it matters most.

You do not need to gitignore them. A tool that requires every repo to ignore
its droppings has pushed its own problem downstream.

### Never redirect the loop's output INTO the repo

```bash
loop run                         # best: trace goes to .pi/harness-run.log
loop run > /tmp/run.log 2>&1     # fine
loop run > run.log 2>&1          # log truncates the moment work starts
```

`checkpoint()` is `git add -A`, so a redirect target inside the repo gets
staged. Every line written after that makes it differ from the index, the
scope guard treats it as an out-of-scope modification, and reverts it to the
checkpoint content. The log therefore stops at exactly the point the first
iteration begins - no iteration headers, no progress lines, no verdict. It
reads as "the loop went silent", and the run itself is completely fine.

The loop now warns when it detects this (printed *before* the checkpoint, so
the warning survives the revert it describes), and `.pi/**` is exempt from the
scope guard so the manifest and report can never be clobbered the same way.

Diagnosis note, because this one cost hours: the symptom looks exactly like a
buffering or file-descriptor bug, and it is neither. It reproduces with `>`,
with `| tee`, and under a real PTY; a scripted fake agent emitting 5000 lines
never triggers it; and a minimal repro proved a real `pi` child does not
disturb the parent's descriptors. The discriminating test is a 3-way A/B:
writeScope AND log-in-repo truncates, either one alone is fine. When output
vanishes, suspect something that rewrites the file, not something that fails
to write it.

### Iteration 1 already sees the baseline failures (and your hints)

Non-obvious and worth internalising: `prev` is seeded with the **baseline**
sensor run, so the very first agent prompt already contains the full failing
block - every failing sensor's command, its output, and its `hint`. There is
no "blind first attempt".

Two consequences:

- **Hints are read on iteration 1**, so a hint that states the answer hands it
  over immediately. Usually correct (that is the point of a hint), but be
  deliberate: `hint: "Banner() must return exactly: ops v2 ready"` makes the
  task trivial, while `"output must match the golden; the diff shows what
  differs"` makes the model read the evidence.
- **You cannot force extra iterations by hiding information in a sensor.** A
  golden-diff sensor prints the expected text in its own output, so the
  "unknowable" value is in the iteration-1 prompt. Measured 2026-08-04: a task
  designed to need two iterations converged in one for exactly this reason,
  which invalidated a steering experiment built on top of it. If you need a
  multi-iteration run, the task has to be genuinely too large for one pass -
  difficulty is the only honest lever.

### Sensors that cannot fail (vacuous sensors - the silent killer)

A green loop proves nothing if a sensor passes *vacuously* - the gate reports
success because the check could never fire, not because the repo is good. Both
real cases below shipped in a "green" hand-written verification harness
(2026-07-30, `~/.local/share/harness/HARNESS-NOTES.md` items 19-23):

- **`grep -v` inverts wrong.** `cmd | grep -qv 'error TS'` exits 0 if ANY line
  does not match - and any real command prints at least one non-error line, so
  the sensor passes with errors on screen. The correct negative form is
  `! cmd | grep -q 'error TS'` (fails when the pattern appears; add a separate
  guard if empty output should also fail).
- **Suppressed-stderr + `!` wrapper passes for the wrong reason.**
  `! git -C $REPO ls-files | xargs grep -l <secret> 2>/dev/null | grep -q .`
  looks like "secret nowhere in tracked files" - but `ls-files` emits
  repo-relative paths while `xargs grep` resolves them against the *caller's*
  cwd, so from any other directory every grep errors into the suppressed
  stderr, stdout stays empty, and the `!` wrapper reports PASS. The sensor
  cannot distinguish "absent" from "unverifiable". Fix: `cd "$REPO"` inside
  the check, and add a substrate guard (`test -n "$(git ls-files)"`) so a
  missing/empty substrate FAILS instead of passing.
- **Evidence patterns weaker than their description.** A sensor labelled
  "insert returned id 301" that greps `INSERT 0 1` proves an insert happened,
  not the id. Match the most distinctive form of the real output (an aligned
  psql block, a marker string you echoed), never a generic success line - and
  never a bare value like `0` from `psql -t`, which matches half the terminal.
- **Existential sensor described as universal.** "all step logs in the time
  window" implemented as `ls ... | grep -q <window>` passes if ONE log matches.
  If the claim is universal, loop over every expected item and require each.
- **A suite that passes because it ran nothing.** *(Bun)* This is the terminal
  vacuous sensor: `go test ./...` exits 0 over zero tests, and every skip
  mechanism (`t.Skip`, `test.skip`, `@pytest.mark.skip`, a deleted file, a
  build tag, a narrowed `-run` pattern) is green by construction. The Bun
  rewrite's headline stat is "0 tests skipped or deleted", and before merging
  the author *manually verified the tests were in fact running and not being
  skipped*. Make that a gate instead of a manual check - a **test-count floor**
  pinned just under the current count (all three verified in both directions,
  2026-08-09):
  - Go: `test $(go test ./... -list '.*' | grep -c '^Test') -ge N`
  - Bun/Jest: `test "$(bun test 2>&1 | rg -o '([0-9]+) pass' -r '$1' | tail -1)" -ge N`
  - pytest: `test $(pytest --collect-only -q | grep -c '::') -ge N`
    (**not** `| wc -l` - `-q` adds a blank line and a "N tests collected"
    summary, so wc overcounts by 2 and the floor silently loosens)
  Pair it with a skip-count ceiling if your runner reports one. `writeScope`
  fencing tests out is necessary but not sufficient: it stops the agent
  *editing* tests, not the build config or a `-run` filter quietly excluding
  them.
- **A build sensor satisfied by stubs.** *(Bun)* "Get it to compile" is
  trivially achieved with `unimplemented!()` / `panic("TODO")` /
  `throw new Error("not implemented")`, and that is exactly what happened at
  scale on the Bun port. The prompt now forbids it, but a prompt is not a
  gate - add a counter sensor so the fence is computational:

  ```bash
  test "$(rg -o 'todo!\(|unimplemented!\(|not implemented' src/ | wc -l)" -le 0
  ```

  Count with `rg -o ... | wc -l`, **not** `rg -c --no-filename ... | paste -sd+ | bc`:
  on a clean tree ripgrep matches nothing and prints nothing, `bc` then
  produces empty output, and `test "" -le 0` errors out - so the tidiest
  possible repo FAILS the sensor while a stubbed one passes the syntax check.
  A negative sensor that inverts on the happy path is worse than no sensor.
  (Caught by mutation-testing this very recipe before documenting it.)

**Mutation-test every negative sensor once, by hand, before trusting it:**
plant the trigger (commit the secret to a temp repo, inject `error TS` into
the stream, touch the forbidden file), run the sensor, watch it FAIL, revert.
If you cannot make it fail it is decoration, and the loop will green over the
very thing it was meant to gate. For a whole sensor set, keep a canary
pattern: run the set once against a known-bad fixture (a scratch checkout with
the trigger planted) and require at least the canary to go red - that is the
harness-level proof the gates discriminate. (Do not leave a permanently-failing
canary in `.pi/harness.json` itself; it would keep the loop red forever. The
canary lives in a selftest script / scratch fixture, not the real manifest.)

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
  Capture is **hardened by default** (device-scale=1, reduced-motion,
  animations/transitions/caret zeroed, waits on `document.fonts.ready`), so
  screenshots and visual diffs are deterministic; `--no-stabilize` opts out.

- **Deterministic layout assertions (computational - prefer these over the
  vision judge where they apply).** A lot of "gross breakage" is exactly
  checkable with `--assert`, which turns a probabilistic visual guess into a
  hard gate with no baseline and no model:
  - horizontal overflow: `--assert 'document.documentElement.scrollWidth <= window.innerWidth'`
  - element actually rendered a box: `--assert 'document.querySelector("nav").getBoundingClientRect().height > 0'`
  - no unstyled-content flash / stylesheet actually applied:
    `--assert 'getComputedStyle(document.querySelector("h1")).fontSize !== "16px"'` (or pin the exact expected value)
  - two elements do not overlap (stacking correct): compare their
    `getBoundingClientRect()` boxes in one expression
  - no raw error banner / framework error overlay:
    `--assert '!document.querySelector(".error, #vite-error-overlay, astro-dev-overlay")'`
  Reach for the vision judge (below) only for what genuinely needs eyes
  (spacing/contrast/"looks off"); everything mechanical should be an `--assert`.

- **Style-ethos gates: computed-style asserts are the pressure, the vision judge is the tiebreaker** (learned the hard way on the docs-ssh landing restyle: the vision judge PASSed the original off-ethos page - it only fails *ugly*, not *off-brief*). When the task is "restyle to ethos X" (dense / flat / sharp / single-accent), encode the ethos as computed-style asserts; they are what create real selection pressure:
  - density: `--assert 'parseFloat(getComputedStyle(document.querySelector("main")).paddingTop) <= 32'`
  - sharp corners: `--assert '[...document.querySelectorAll("*")].every(e => parseFloat(getComputedStyle(e).borderTopLeftRadius) <= 6)'`
  - flat: same `.every()` shape for `getComputedStyle(e).boxShadow === "none"` and `!getComputedStyle(e).backgroundImage.includes("gradient")`
  - single accent: count distinct saturated text colors outside `<pre>`/code blocks (parse the rgb() triple, flag max-min > 60, dedupe in a Set), assert `<= 1` - working IIFE in `~/docs-ssh/.pi/harness.json` ("dom" sensor)
  Then keep the vision judge LAST for what computed styles can't express (overlap, clipping, unstyled flash) - as tiebreaker, not primary gate.

- **Inferential (as a debugging aid): a screenshot the model reads.**
  `browser-assert ... --screenshot /tmp/x.png` captures the post-interaction
  page; the agent then `read`s the PNG to reason about layout/visual issues the
  DOM can't express. On its own this is a probabilistic aid, not a gate - but
  when you *do* want rendered-UI to gate the loop, use `judge.ts` VISUAL mode
  (next section), which captures the same way and puts a second model's verdict
  behind it. The bare screenshot-read stays the free-form debugging path.

Visual-regression (diff the `--screenshot` PNG against a baseline) and a11y
(`axe`) are further sensors you can layer on; they need their own baselines/
tooling. `--type`/`--click` use trusted CDP Input events, but for complex flows
(multi-tab, downloads, network mocking) a target's own Playwright suite is still
the right tool - `browser-assert` is the zero-dep gate.

## Inferential gate: correctness the computational sensors miss (`judge.ts`)

Bockeler splits sensors into **computational** (tests/linters/types -
deterministic, cheap, every change) and **inferential** (semantic AI review /
"LLM as judge" - slower, non-deterministic, richer judgment). Everything above
is computational: it proves the code *passes the checks*, never that it did the
*right thing*. A misunderstood-but-green change, over-engineering, or an agent
that weakened its own tests all sail through. `judge.ts` adds the inferential
column as an actual **gate**:

```json
{ "name": "judge",
  "cmd": "bun ~/.pi/agent/skills/self-correcting-loop/judge.ts --spec 'the task, restated as acceptance criteria' --model claude-opus-4-8" }
```

It collects `git diff HEAD` (plus untracked files), feeds it with the spec to a
SECOND `pi -p`, and exits on the model's `VERDICT: PASS/FAIL`. Use it well:

- **Put it LAST** (keep quality left): it is the expensive, probabilistic tier -
  it should only run once the cheap computational gates are green.
- **Use a DIFFERENT / stronger model** than the one writing the code (`--model`).
  A judge that is the same model that wrote the diff is a closed loop, same as
  self-graded tests.
- **Measured reviewer variance: zero, and `--adversarial` bought nothing.**
  A/B on a fixed diff with one planted, unambiguous spec violation (`Median`
  sorting the caller's slice, which the spec explicitly forbids), scored
  against a clean control. 8 single-reviewer trials per arm per model:

  | judge | caught the flaw | false-rejected clean |
  |---|---|---|
  | claude-sonnet-5 | 8/8 | 0/8 |
  | claude-haiku-4-5 | 8/8 | 0/8 |

  With p = 1.0 and q = 0.0, `1-(1-p)^k` is flat: a second and third reviewer
  add cost and change no outcome. Be honest about the sample: n=8 with no
  errors gives an exact 95% one-sided bound of p >= 0.688 and q <= 0.312,
  so this rules out a *badly* noisy reviewer, not a mildly noisy one. The
  flaw was also localised and spec-explicit - variance should be expected
  to appear on ambiguous or diffuse defects. But the load-bearing
  claim ("one sampled judgment is noisy") did NOT reproduce at this
  difficulty, on either a strong or a weak judge.

  **The one apparent miss was a bug in this harness, not model variance.**
  A haiku run came back `unknown` -> fail-closed. The transcript showed it had
  diagnosed the flaw correctly and written `**VERDICT: FAIL**`; `parseVerdict`
  required a bare line and discarded it. Fail-closed hid the damage that time,
  but the symmetric case is worse - a bolded `**VERDICT: PASS**` becomes a
  FAIL and blocks good work. Fixed to tolerate markdown decoration (bold,
  headings, list markers, blockquotes, backticks) while still refusing prose
  mentions. Before assuming a judge is flaky, check that its verdict parses.

  Practical consequence: **leave `--adversarial` at 1 unless you have measured
  variance on your own diffs.** Harness to measure it:
  `~/.local/share/loop-validation/judge-variance/`.
- **Run 2+ reviewers with `--adversarial N`** *(Bun)*. The Bun rewrite's unit
  of work was `1 implementer -> 2 adversarial reviewers -> 1 fixer`, with the
  roles kept strictly apart: "The Claude that wrote the code wants the code to
  get accepted. The Claude that reviews wants to find issues... The implementer
  doesn't review. The reviewer doesn't implement." `--adversarial N` runs N
  independent reviewer contexts concurrently and fails if **any** rejects -
  deliberately not a majority vote, because one reviewer finding a real bug
  outranks N-1 that missed it. It also blunts the biggest weakness of an
  inferential gate: one sampled judgment is noisy, unanimity is not. Costs N
  model calls per iteration, so reserve it for runs that matter.
- **Reviewer rejection rules worth stealing.** Give `--rubric` the ones that
  run had to add after watching the failure modes: reject a change whose
  workaround needs a paragraph-long comment to justify it; reject stubbed or
  no-op'd functions presented as an implementation; reject behaviour that
  differs from the stated reference even when the code compiles and passes.
- **Role separation is only half-implemented here.** `judge.ts` gives you the
  reviewer half (separate context, separate model, read-only tools). There is
  no distinct *fixer* role yet - a judge FAIL restarts the implementer with the
  findings as feedback rather than handing them to an agent that only fixes.
  Worth knowing when comparing this loop against the article.
- **Fail-closed by default**: an unparseable / errored verdict counts as FAIL,
  so the loop keeps trying rather than declaring victory on an unclear answer.
  `--lenient` flips to fail-open for noisy judges.
- **Read-only tools** (`--tools read` default) - the judge inspects, never edits.
- `--rubric "..."` appends task-specific acceptance criteria; `--base <ref>`
  changes what the diff is taken against (default `HEAD`, the loop's baseline).

Honest caveat: it is inferential, so it is non-deterministic and costs a model
call per iteration. It raises confidence, it does not replace a specification -
a vague `--spec` judges vaguely. It is the answer to "green but wrong", not a
license to skip writing down what "right" means.

### VISUAL mode: UI/UX awareness for a live dev server

DOM asserts (`browser-assert`) prove elements *exist*; they cannot see that the
page *looks* right. `judge.ts --url` closes that: it screenshots a live dev
server (reusing `browser-assert` under the hood) and asks a vision-capable
`pi -p` to judge the render - layout, overflow/clipping, contrast, unstyled
flash, overlap, raw-markup/error banners - against the spec, gating on the same
`VERDICT: PASS/FAIL`.

```json
{ "name": "ux",
  "cmd": "bun ~/.pi/agent/skills/self-correcting-loop/judge.ts --url http://localhost:4333/guides/x --wait 'main' --full-page --viewport 1280x800 --model claude-opus-4-8 --spec 'the guide page renders: readable prose, code blocks styled (not raw), no horizontal overflow, no error banners'" }
```

- `--url` captures to a temp PNG (or `--screenshot <path>` to keep it); pass
  `--screenshot <path>` WITHOUT `--url` to judge a pre-captured PNG instead.
- `--wait <sel>` / `--viewport WxH` / `--full-page` are forwarded to the
  capture, so you gate the *hydrated* page at a real size, full-height.
- The judge opens the PNG with its `read` tool (pi renders images to the model),
  so `read` is forced into `--tools` automatically.
- Same discipline as code mode: run it LAST (it is the slowest/most expensive
  tier), use a strong `--model`, fail-closed by default. A capture failure
  (server down, wedged browser) is a FAIL unless `--lenient`.
- Wrap the dev-server lifecycle in the sensor `cmd` if it is not already up,
  e.g. `(bun dev & SP=$!; sleep 2; bun judge.ts --url ...; RC=$?; kill $SP; exit $RC)`.

Caveat: a vision judgment is coarser than a human's eye and non-deterministic -
it reliably catches gross breakage (overflow, unstyled content, blank/error
pages) and is far weaker on pixel-level polish. For exact regressions, use the
computational baseline diff below.

### Computational visual regression: baseline PNG diff (`pixel-diff.ts`)

The deterministic half of the visual gate: capture the current render and diff
it against a committed, human-**approved** baseline PNG, failing when too many
pixels changed. Zero-dep (PNG decode/encode via `node:zlib`), with a YIQ
perceptual per-pixel threshold so anti-aliasing / sub-pixel noise does not
false-positive.

```json
{ "name": "visual-regression",
  "cmd": "bun ~/.pi/agent/skills/self-correcting-loop/pixel-diff.ts --url http://localhost:4333/guides/x --baseline .pi/baselines/guide-x.png --wait 'main' --full-page --viewport 1280x800 --max-diff-ratio 0.001 --diff-out /tmp/guide-x.diff.png" }
```

- **Approved-baseline lifecycle:** generate baselines as a SETUP step and COMMIT
  them (committing = approval). On a missing baseline the sensor writes it and
  FAILs ("review and commit it") - so a stray baseline can never silently gate.
  Refresh an intentionally-changed reference with `--update-baseline`.
- **`--baseline <png>`** is the reference; the current render comes from `--url`
  (captured via browser-assert, forwarding `--wait`/`--viewport`/`--full-page`)
  or `--current <png>` (pre-captured).
- **`--threshold 0..1`** = per-pixel YIQ sensitivity (default 0.1); **`--max-diff-ratio 0..1`** = allowed fraction of changed pixels (default 0). Capture
  hardening (on by default in browser-assert) makes same-host re-captures
  bit-identical, so 0 is realistic; bump the ratio for cross-host noise.
- **`--ignore-region x,y,w,h`** (repeatable) zeroes dynamic areas (timestamps,
  avatars) before diffing. **`--diff-out <png>`** writes a red-highlight image
  the agent can `read` to see exactly what moved.
- Run it LAST with the fast sensors green, same as the other visual gates.

When to use which visual gate: **`pixel-diff`** for "nothing should change"
(regression-locking a stable page - exact, deterministic); **`judge` VISUAL**
for "does this new/changed page look right" (no baseline exists yet, or the
change is intended and you want a judgment not a byte-compare).

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
- **No separate fixer role.** See the judge section - reviewer/implementer are
  split, implementer/fixer are not.
- **Timeouts bound the loop, not the spend.** A budget stops a hang; it does
  not stop N iterations of expensive-but-productive work. `maxIterations` and
  the model ladder are the cost controls.

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
cd ~/.pi/agent/skills/self-correcting-loop && bun test                   # all 158
```

The `limits` path is A/B-verifiable by hand - with `limits` set, a sensor
reading its own cgroup sees the cap; without it, the same check fails:

```bash
# sensor cmd, passes only when MemoryMax=512M is actually applied
cat /sys/fs/cgroup/$(cat /proc/self/cgroup | tail -1 | cut -d: -f3 | sed 's|^/||')/memory.max | grep -q 536870912
```
