---
name: self-correcting-loop
description: "Run an unattended, sensor-gated agent loop that drives a fresh pi -p each iteration until deterministic checks (build/lint/test/typecheck) pass, then stops. Use when the user wants to 'set an agent in a loop', run a task autonomously, self-correct without supervision, or make a weaker model (Sonnet/GLM/DeepSeek) reliably good on a scoped coding task. The model never decides 'done' - the sensors do. Language-agnostic - sensors are just command strings declared in a per-project .pi/harness.json (go/node/rust/astro/python presets included). Pairs with scaffold-new-project (which builds the target) and software-architecture (tight contracts = better sensors)."
---

# Self-correcting loop

A deterministic **outer harness** around `pi -p`. It exists to answer one
question: *how do you let an agent run unattended - and be good even on a
sub-Opus model - without it declaring victory on broken code?*

The answer (from Bockeler's "Harness engineering", the article that seeded
this): **externalize the feedback control.** The loop, not the model, decides
completion. The model only ever sees the failing sensor output as its next
prompt.

## The mechanism

```
repeat until every sensor exits 0, OR maxIterations spent:
    pi -p  <task + previous iteration's failing sensor output>
    run sensors (build / vet / test / tsc / clippy / astro check ...)
    all pass?  -> STOP, success           (deterministic gate)
    any fail?  -> feed exact failures into the next prompt
```

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
| `harness.ts` | Pure core: manifest schema/validation, prompt + feedback builders, stack detection. Unit-tested. |
| `loop.ts` | CLI driver (Bun): spawns `pi -p`, runs sensors, drives the loop. |
| `presets/*.json` | Starter manifests per stack (go/node/rust/astro/python). |
| `harness.test.ts` | Unit tests for the pure helpers (`bun test` in this dir). |

## Usage

From the **target project root** (the repo the loop should work on):

```bash
LOOP=~/.pi/agent/skills/self-correcting-loop/loop.ts

# 1. write .pi/harness.json (auto-detects stack from go.mod/package.json/...)
bun "$LOOP" init            # or: init go | node | rust | astro | python

# 2. edit .pi/harness.json: set "task", tune "sensors", pick "model"

# 3. see what the sensors say right now, without spawning pi
bun "$LOOP" run --dry

# 4. run the loop
bun "$LOOP" run
bun "$LOOP" run --model claude-sonnet-4 --max 15    # weak-model test
```

`run` exit codes: `0` all sensors green, `1` still red after budget, `2`
manifest/usage error.

## The manifest (`.pi/harness.json`)

```json
{
  "task": "Add a WeChat OAuth provider module; loop until conformance passes.",
  "maxIterations": 10,
  "model": null,
  "tools": ["read", "edit", "write", "bash"],
  "sensors": [
    { "name": "build", "cmd": "go build ./..." },
    { "name": "vet",   "cmd": "go vet ./..." },
    { "name": "test",  "cmd": "go test ./..." }
  ]
}
```

- `task` - the feed-forward instruction. Keep it scoped; one module/feature.
- `sensors` - the feedback controls. Each `cmd` runs under `bash -lc`; exit 0 =
  pass. Order them cheap-to-expensive (build before test) - all must pass.
- `model` - `null` = pi default. Set to a weaker model to pressure-test the
  harness. CLI `--model` overrides.

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
