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
| `harness.ts` | Pure core: manifest schema/validation, prompt + feedback builders, stack detection, glob/scope, decide/ladder logic. Unit-tested (37 cases). |
| `loop.ts` | CLI driver (Bun): spawns `pi -p`, runs sensors, git checkpoint/rollback, scope guard, escalation, report. |
| `presets/*.json` | Starter manifests per stack (go/node/rust/astro/python). |
| `harness.test.ts` | Unit tests for the pure helpers. |
| `loop.integration.test.ts` | End-to-end governor test with a scripted fake agent (rollback / stall+escalate / scope-revert / pass) - no real model needed. |
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
- **Security / drift sensors** are cheap computational gates the article files
  under "continuous drift" - wire them so an unattended loop physically cannot
  land a leaked key or a known-vulnerable dep. Run them alongside the fast
  sensors: `{ "name": "vuln", "cmd": "osv-scanner -r --lockfile ..." }` (or a
  language lockfile scan) and `{ "name": "secrets", "cmd": "gitleaks detect
  --no-banner -v" }`. Pair each with a `hint` telling the model to bump/remove
  the offending dep or move the secret to env, not to delete the scanner.

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

## Testing this skill

```bash
cd ~/.pi/agent/skills/self-correcting-loop && bun test harness.test.ts
```
