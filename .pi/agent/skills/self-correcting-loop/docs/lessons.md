# Harnessability lessons

Read this when authoring or debugging a manifest's sensors: what makes a
target loop well, which sensor shapes are vacuous, how to prove a sensor can
flip, and the operator traps that have burned real runs. Everything here was
paid for on a real run; the dated stories that became defaults have been
folded into the rules.

Contents:
- Operator traps (moving files to "clean" the tree; the staged checkpoint after a killed run)
- Feature sensors must be red at baseline (`expect: "fail"`, `kind: "premise"`, the two failure modes, negative doc greps)
- The fence shapes the architecture
- Making the target harnessable (contracts, golden reference, fixtures, structural sensors, mutation testing, security sensors)
- Count the spec's universals before they become sensors; premise sensors
- Greenfield: the empty repo IS the canary
- `loop verify-sensors`: prove each sensor can flip
- Run journal: outcomes across repos over time
- Reading a run: `.pi/harness-run.log` and `loop report`
- Never redirect the loop's output INTO the repo
- Iteration 1 already sees the baseline failures
- Sensors that cannot fail (vacuous sensors)

## Operator traps

Two adjacent operator traps, both observed on a real run:

- **Do not move/delete a file a guard sensor references to make the tree
  "clean" for a run.** The guard goes red at baseline, and the agent's
  cheapest path back to green is inside its writeScope - weakening the test.
  (A preset TOML parked in /tmp made `test_load_all_presets` fail; the agent
  deleted the preset name from the expected set. The judge caught it, but the
  run was unfixable: restoring the file was outside `writeScope`.) Fix the
  baseline honestly, or commit the file, before running.
- **A killed run leaves the checkpoint's `git add -A` staged.** The next
  `git commit` you make sweeps the agent's staged work into YOUR commit.
  After killing a loop mid-iteration, `git status` and unstage/restore
  deliberately before committing anything; check `git show --stat HEAD`
  for surprise passengers.

### Feature sensors must be red at baseline

On an ADDITIVE-feature task every sensor passes
at baseline, so the loop exits "nothing to do" without iterating. Encode the
desired end state as a feature-present sensor that FAILS pre-change (e.g.
`rg -q <new-symbol> <file>`, `jq -e '.x == false' <cfg>`) - that is what
gives the loop something to converge on.

Mark those `"expect": "fail"`. The run is REFUSED (exit 2) if such a sensor
passes at baseline, because a feature sensor that is already green gates
nothing - the loop can converge having built nothing and still report PASS.
Guards (build/lint/test) default to `"expect": "pass"` and are never flagged.
The symmetric case is `"kind": "premise"` - a sensor that must be GREEN at
baseline because it encodes a factual claim the spec depends on; red there
means the spec is wrong and the run is refused before a token is spent.

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


### The fence shapes the architecture

Draw `writeScope` with this in mind. A
worked example: a run built an HTTP API over an existing CLI, with
`internal/parse` deliberately out of scope ("this is transport, not
parsing"). The agent needed lease-filter validation in both the CLI and the
API. Duplicating it is the thing a reviewer rejects, and the shared home for
it - `internal/parse` - was fenced off. So it put the shared code in the new
transport package and had the CLI import it, inverting the layering; that
created an import cycle for one endpoint, which it broke by duplicating a
struct and injecting a callback, under a four-line comment explaining why.

Every step is locally reasonable and the result is wrong. The fence
protected the module it named and deformed everything around it. When you
scope a run, ask where shared code will have to go, and if the answer is
"nowhere good", widen the scope to a small shared package rather than
leaving the agent to invent a home for it.

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
  fast and deterministic, so run them alongside the fast sensors.

  This is not hypothetical insurance. On the 2026-08-05 eaves run the agent
  inverted the layering between the CLI and the new transport package (see
  "The fence shapes the architecture" above), and BOTH adversarial opus reviewers passed it - despite
  their own rubric saying "reject a change whose workaround needs a
  paragraph-long comment to justify it", and the workaround carrying exactly
  such a comment. A one-line `depguard` rule forbidding the import would have
  been red, deterministic, and free. Where a boundary matters, do not delegate
  it to a probabilistic reviewer. Per stack:
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
  `detect` is wrong here in two compounding ways. It scans COMMITS - but the loop's ref-guard
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

### Count the spec's universals before they become sensors

Every quantifier in the task spec - "both", "all", "every", "none", and any
bare cardinal ("the 14 checks", "all 15 endpoints") - is a claim your sensors
will inherit and your judge will re-assert. Derive it rather than asserting
it: one `grep -c` before the run, and a count-deriving sensor wherever the
number reaches the output. **No sensor authored from the spec can dispute the
spec.**

This is a loop-specific hazard, not general advice. Outside the loop a false
premise yields one wrong artifact you might notice while writing it. Inside,
the same sentence becomes the task, the sensors AND the `judge --spec` - three
signals with one parent.

Worked instance. An eaves task spec said "all 15 GET endpoints under /api/v0
plus /healthz, exactly as the roadmap lists them". The roadmap lists 14.
Nobody counted. The sentence propagated verbatim into the judge spec, and out
into docs that contradicted each other (`roadmap.md` claiming 15 + /healthz,
`architecture.md` claiming 14 + /healthz).

The interesting part is what the judge did with it. It did not go quiet - it
went **red, and blamed the wrong file**:

> `docs/roadmap.md` phase-A note says "15 GET endpoints + /healthz" (i.e. 16);
> `docs/architecture.md` says "14 GET endpoints + /healthz (15 total)". The
> roadmap line is wrong.

The roadmap was the only artifact in the chain that was right. The judge
inherited "15" as a premise, met a contradiction, and resolved it against the
one place it could look without questioning itself. An agent obeying that
finding would have "fixed" the roadmap to say 15 and entrenched the error with
a reviewer's authority behind it. So the failure mode is not silence - it is a
confident, actionable, wrong defect report. "My judge would catch it" is right
that it fires and wrong about what it says.

`--trial` does not cover this. The bad count never made a sensor stuck; it
made the OUTPUT self-contradictory. Trial verdicts the sensors, not the
premises they were written from.

Where the number reaches the output, make it a sensor that computes N rather
than one that hard-codes it - eaves' `doctor-count-docs` is the shape:

```json
{
  "name": "doctor-count-docs",
  "cmd": "N=$(EAVES_FIXTURE_DIR=testdata/fixtures go run . doctor | grep -cE '^(OK|WARN|FAIL|SKIP)'); test -z \"$(rg -o --no-filename '[0-9]+ checks?' README.md docs/*.md | grep -oE '^[0-9]+' | sort -u | grep -vx \"$N\")\"",
  "hint": "A doc states a check count that does not match the binary. Derive the real number and update every doc that claims one."
}
```

A pre-flight `grep -c` protects one run. A count-deriving sensor protects
every future one, including the runs where nobody remembers this rule.

#### Premise sensors: put the spec's factual claim in front of the machinery

The pre-flight count above is discipline, and discipline is the thing that
fails. A claim about current state IS a sensor, so write it as one:

```json
{ "name": "premise-shared-primitives", "kind": "premise",
  "cmd": "grep -q password_hash guides/consolidation.mdx && grep -q password_hash guides/promotion.mdx" }
```

`kind: "premise"` declares a claim the SPEC rests on. It must be green at
baseline; red REFUSES the run (exit 2) with a message that says fix the spec,
not the tree. It is checked once and then dropped from the gating set - a claim
about the state the spec was written against is not an invariant the work must
preserve, and it must never reach the model as feedback, because "make this
true" is the failure being prevented. A premise may not carry `expect` (its
expectation is fixed by what it is) or a `canary` (planting a fault would prove
grep works, not that the claim holds); both are manifest errors.

This is the symmetric case to `expect: "fail"`, and the machinery was already
half-built. That one refuses a spec asking for something already true. This one
refuses a spec asserting something that was never true. Without it a red sensor
at baseline reads as "the thing to fix" - which for a premise means the loop's
cheapest path to green is to invent the state the spec assumed.

Worked instance (2026-08-08, lexicanum). A task said "unify the four primitives
these two migration guides share". The second guide shared none of them: the
two directions do not use the same mechanism at all. Every sensor written from
that sentence inherited the error, so they were all satisfiable only by
fabricating the agreement they were meant to consolidate. The premise above
fails in milliseconds. The point is not that `grep` is clever - it is that a
claim about current state belongs in front of the machinery instead of behind
it.

What this does NOT cover: whether the goal was right. If "unify the primitives"
had been a bad design rather than a false premise, every sensor here would be
green and the output still wrong. That part stays human.

### Greenfield: the empty repo IS the canary

`verify-sensors` reports "unverified, no canary declared" on a manifest for
work that does not exist yet, and that is fine - when every sensor is red at
baseline and the spec's "Done When" list is what turned them green, the run
itself is the discrimination proof. Confirm the baseline is red by hand
(`for s in ...; do eval "$s" && echo GREEN-BAD || echo red; done`) and go.
Declare canaries for anything you keep re-running.

A fully-specified, unimplemented project is also the best *measuring*
instrument you have. Micro-fixture tasks are too small to exercise thinking
length, context growth or compaction: on a 4-task fixture suite the largest
single generation was 412 tokens, where one real greenfield bootstrap
(pylon Phase 0, 2026-09-02) ran 202 requests, 490k generated tokens and
prompts to 36k. A knob measured on the small suite measures as "no effect"
whether or not it has one. Run it in a git worktree (`git worktree add
.worktrees/<slice> -b <slice>-loop`) so a bad run cannot touch the main
checkout, and so the branch survives when you remove the tree.

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
declared - not a failure, but not evidence either), `pending` (an uncanaried
FEATURE sensor).

`pending` is reported separately from `unverified` on purpose. A feature
sensor cannot carry a canary before its feature exists - the fault you would
plant IS the implementation - so filing it beside a guard that merely lacks
one inflates the gap count in the single report you read right before deciding
to spend money. On eaves that read "9 unverified" when the real number was 3.
Feature sensors are verified by a different instrument: the baseline `expect`
check aborts the run if one already passes on the unchanged tree, and going
green at the end proves the other end of the range. `--strict` ignores them
and fails only on uncanaried guards.

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
- **A test you write for the loop needs the same treatment.** After adding
  process reaping I ran the new regression tests and all three passed - but
  one of them had passed *before* the fix too, so it was proving nothing.
  Disabling just the agent-side reap turned it red, which is what earned it.
  Canary your own assertions or you are writing the vacuous sensors this
  section warns about, one layer up.
- Beware allowlisted example values. The canonical AWS docs key will not trip
  gitleaks, so a canary built from it "passes" while proving nothing.
- If a sensor reports STUCK, EITHER the check is broken OR the canary plants
  the wrong thing. Diagnose before editing - the first real STUCK found in
  this repo was a broken sensor, and the fix was a different scanner mode.
- **`! rg ...` is STUCK-by-construction over not-yet-existing files.** An
  absence guard like `! rg 'pattern' a.ts b.ts` silently passes forever when
  one of the files does not exist at baseline: rg exits 2 (error) for the
  missing operand, and 2 outranks a match - so even with the fault planted
  the negated command exits 0. Found by `verify-sensors` on 2026-08-09 on a
  no-stubs guard spanning files the feature itself would create. Assert on
  output, not exit code: `test -z "$(rg --no-messages 'pattern' a.ts b.ts)"`.
- A canary that cannot be expressed is a smell: it usually means the sensor
  asserts something too vague to fault deliberately.

### Run journal: outcomes across repos over time

Every completed run also appends ONE JSON line to a per-machine, append-only
cross-repo journal at `~/.local/share/loop/runs.jsonl` (override with
`$LOOP_JOURNAL`; never committed - same convention as the session-ledger
DB). The per-repo report answers "what happened in THIS run"; the journal
answers "how does this model do across a variety of real tasks over time" -
whoever drove the run, whichever repo it ran in.

```bash
loop history                 # last 20 runs: when, repo, result, iters, kept, duration, models
loop history --last 100 --json | jq 'select(.result=="pass") | [.modelUsed[0], .iterations]'
duckdb -c "select modelUsed[1] m, result, count(*) n, avg(iterations) iters,
           avg(agentMs)/60000 agent_min from read_json_auto('$HOME/.local/share/loop/runs.jsonl')
           group by all order by m, n desc"
```

Each line: `v, ts, startedAt, durationMs, cwd, repo, headSha, models
(ladder), modelUsed, trial, humanGate, maxIterations, result
(pass|fail|already-green|trial-stalled|trial-partial), iterations, kept,
escalations, agentTimeouts, agentMs, sensorsMs, initialFailing,
finalFailing, finalFailingNames, failureModes, taskSha, taskExcerpt`, plus `iter[]` with
per-iteration model/kept/progressed/escalated/agentMs/failing-delta.

`failureModes` is the WHY (computed by `classifyRun` in harness.ts, unit-
tested per tag): `agent-error` (non-zero exit, no timeout - gateway 401,
GPU-lock 422, sandbox death; the run says "stalled" but the model never
ran), `agent-timeout`, `agent-silent` (clean exit, zero files changed),
`thrash` (2+ changed-but-rolled-back iterations - doing work, work is
wrong), `scope-fighting` (fence reversions), `sensor-timeout` (final
iteration), `budget-exhausted` (last iteration was STILL progressing -
wanted more iterations, not a better model), `no-progress` (catch-all).
Green runs get `[]` or `needed-escalation` (a higher rung did the work -
a cost signal). Tags compose; `loop history` shows them bracketed.

Deliberately NOT captured: premise/manifest refusals and dry runs
(harness-authoring events, not model outcomes), and token counts - the
llm-compose proxy's token counters are shared across clients, so a
before/after delta mis-attributes. Wall-clock + iterations-to-green is the
honest perf proxy at this granularity. Scripted-fake-agent runs
($LOOP_PI_CMD without an explicit $LOOP_JOURNAL) never journal - tests do
not pollute the store.

### Reading a run: `.pi/harness-run.log` and `loop report`

You do not need to redirect anything. Every run tees its console output to
`.pi/harness-run.log` (append-only, so history accumulates; `--no-log` opts
out). `.pi/**` is exempt from the scope guard, so the loop cannot eat its own
trace. After a run:

```bash
loop report                      # rendered summary of the last run
loop report --report path.json   # or an archived one
loop report --prompt 2           # the EXACT text iteration 2 was given
```

`loop report` turns the JSON into the thing you actually want after an
unattended run: the failing-count trend, kept vs ROLLED BACK per iteration
with the sensors that moved (`broke:` / `fixed:` - on a rollback, `broke:` is
the cause),
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

The report is rewritten after **every** iteration, so `loop report` and
`--prompt N` are usable on a run still in progress - `result` stays `fail`
until it finishes, which is the honest reading of an unfinished run. Before
this it was written only at the end, so for the hours a long run takes, the
command showed the PREVIOUS run's file while looking current.

**`loop report --prompt N`** dumps the exact text iteration N was handed,
recorded to `.pi/harness-prompts/iteration-N.txt` before the agent starts (so
it survives a wedged iteration or a killed run). Everything else in the report
describes what the loop OBSERVED; this is the only view of what it SAID.

That asymmetry is not cosmetic. Three of the four defects found on the first
real run came from reading an agent prompt by hand out of `ps` output - the
loop's own log sitting inside the reviewed diff, a baseline judge verdict
presented to iteration 1 as "the previous attempt failed", and the sheer size
of the assembled feedback. None was visible in the report or the trace. The
observability work made the RUN legible; this makes the thing the run is
actually made of legible.

The report's `prompt` column carries the size per iteration, which is the
cheap version of the same question - a prompt that doubles between iterations
is feedback accumulating faster than the model can use it.

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

That exemption has a hole when `.pi/harness.json` is TRACKED in the target
repo: the AGENT can clobber the manifest and the scope guard will not revert
it. Observed 2026-08-09 (dotfiles run): the repo had an old harness manifest
committed from a previous task, and the iteration-2 agent - trying to please
the judge's diff-hygiene complaint - restored `.pi/harness.json` to HEAD
mid-run. The tell was the between-iterations hot-reload line reporting
`0 rule(s)`: the reload read HEAD's stale manifest, and every standing rule
silently dropped out of later prompts. Belt and suspenders: add a rule
forbidding the agent from touching `.pi/harness*`, and tell the judge in the
spec that harness files are loop machinery, not part of the change.

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

- **A sensor greened by a process the LAST run leaked.** *(2026-08-05)* This
  one is not about the sensor's logic at all - the check was correct and the
  repo was empty. A previous run's four `eaves serve` processes were still
  bound to 127.0.0.1:18631-18634, so four feature sensors curl'd a live API
  that the tree under test did not implement. It is the worst shape of vacuous
  green: nothing in the sensor is wrong, and re-reading it teaches you nothing.

  The leak is the ordinary way you write a server sensor - `go run . serve &
  SP=$!` ... `kill $SP` kills the `go run` wrapper, not the compiled binary it
  exec'd. Two mechanisms that look like they cover it do not: GNU `timeout`
  creates a process group but only signals it when the deadline fires, and
  `systemd-run --user --scope` does **not** reap the cgroup on normal exit
  (verified directly - a backgrounded `sleep` outlived the scope). The loop now
  SIGKILLs the sensor's and the agent's process group after each completes,
  which is a fix in the harness rather than advice to sensor authors.

  What caught it was the `expect: "fail"` baseline check reporting the four as
  non-discriminating. A feature sensor **without** `expect` would have been
  silently green from iteration 0 - declare it on every feature sensor.

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

