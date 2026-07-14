# @erfianugrah/pi-loop

A sensor-gated, self-correcting loop driver for [pi](https://pi.dev).
Language-agnostic: it drives a fresh `pi -p` each iteration until deterministic
sensors (build / lint / test / typecheck / browser e2e) pass, then stops. **The
loop - not the model - decides "done"**, which is what makes it hold up on
sub-Opus models.

This directory is both a pi **skill** (`SKILL.md`) and an installable package
(`bin`: `loop`, `browser-assert`, `judge`). Full concepts, manifest schema, the
governor, and honest limits live in [`SKILL.md`](./SKILL.md) - this README is
the 30-second start.

## Install

```bash
# it ships inside the pi-harness; to get the CLIs on PATH:
cd ~/.pi/agent/skills/self-correcting-loop && bun link   # provides `loop`, `browser-assert`, `judge`
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
- **Model escalation ladder** - start on the cheapest model, climb a rung after
  N no-progress iterations.
- **git checkpoint + rollback** - a regressing/stalled iteration is reverted, so
  the loop never degrades the tree.
- **write-scope** - out-of-scope edits are reverted each turn (kills the
  test-weakening cheat).
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
- **judge** - an *inferential* (LLM-as-judge) sensor: feeds the git diff + spec
  to a second `pi -p` and gates on its `VERDICT: PASS/FAIL`. The computational
  sensors prove the code passes the checks; the judge checks it did the *right
  thing* (green-but-wrong, misunderstood spec, self-weakened tests). Fail-closed;
  run it LAST with a stronger `--model` than the writer.

Sensor types to reach for: build/typecheck/unit (fast gate), **structural /
architecture** (`golangci-lint` depguard, `dependency-cruiser`, `import-linter`,
ArchUnit - fitness functions), **security / drift** (`osv-scanner`, `gitleaks`),
**mutation testing** (gremlins/StrykerJS/PIT - grades test quality; expensive,
post-fast-sensor), **browser e2e** (`browser-assert`), and the **inferential
gate** (`judge` - correctness against the spec).

## Test

```bash
bun test    # 77: pure-helper + arg-parser unit; governor/dirty/freeze/subdir-scope integration; CDP; browser flow/screenshot; judge verdict + gate
```

See [`SKILL.md`](./SKILL.md) for the manifest reference, the harnessability
guidance, and the behaviour-harness limits.
