# @erfianugrah/pi-loop

A sensor-gated, self-correcting loop driver for [pi](https://pi.dev).
Language-agnostic: it drives a fresh `pi -p` each iteration until deterministic
sensors (build / lint / test / typecheck / browser e2e) pass, then stops. **The
loop - not the model - decides "done"**, which is what makes it hold up on
sub-Opus models.

This directory is both a pi **skill** (`SKILL.md`) and an installable package
(`bin`: `loop`, `browser-assert`). Full concepts, manifest schema, the governor,
and honest limits live in [`SKILL.md`](./SKILL.md) - this README is the
30-second start.

## Install

```bash
# it ships inside the pi-harness; to get the CLIs on PATH:
cd ~/.pi/agent/skills/self-correcting-loop && bun link   # provides `loop`, `browser-assert`
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

## What it does (governor)

- **Sensors are the gate** - each iteration runs the manifest's sensor commands;
  green exit codes are the only success signal.
- **Model escalation ladder** - start on the cheapest model, climb a rung after
  N no-progress iterations.
- **git checkpoint + rollback** - a regressing/stalled iteration is reverted, so
  the loop never degrades the tree.
- **write-scope** - out-of-scope edits are reverted each turn (kills the
  test-weakening cheat).
- **browser-assert** - a dependency-free headless-Chromium behaviour sensor for
  web targets (CDP over Bun's WebSocket; no puppeteer/playwright).

## Test

```bash
bun test    # 33: pure-helper unit + governor integration + browser-sensor integration
```

See [`SKILL.md`](./SKILL.md) for the manifest reference, the harnessability
guidance, and the behaviour-harness limits.
