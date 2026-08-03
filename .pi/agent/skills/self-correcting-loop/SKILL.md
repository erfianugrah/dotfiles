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
    pi -p  <task + previous iteration's failing sensor output + loop notes
            + rolled-back attempt history (negative knowledge)>
    jail the agent (bwrap: ro /, rw repo+tmp, overlayfs on ~/.pi/agent,
        masked ~/.ssh et al) - unless sandbox: "off"
    undo any agent-run git commit/reset (HEAD back + checkpoint restored)
    re-impose the checkpoint index (index-guard)
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
- **run report** - `.pi/harness-report.json` records model, failing-count
  trend, kept/rolled-back, escalations, scope violations, and changed files
  per iteration.

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
| `harness.ts` | Pure core: manifest schema/validation, prompt + feedback + attempt-history builders, stack detection, glob/scope, decide/ladder logic. Unit-tested (43 cases). |
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
  "sensors": [
    { "name": "build", "cmd": "go build ./..." },
    { "name": "vet",   "cmd": "go vet ./..." },
    { "name": "test",  "cmd": "go test ./..." },
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
  language lockfile scan) and `{ "name": "secrets", "cmd": "gitleaks detect
  --no-banner -v" }`. Pair each with a `hint` telling the model to bump/remove
  the offending dep or move the secret to env, not to delete the scanner.

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
cd ~/.pi/agent/skills/self-correcting-loop && bun test harness.test.ts
```
