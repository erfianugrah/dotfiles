# Model ladder notes

Read this when choosing the `models` ladder or the judge `--model` for a run,
when a gateway drains mid-run, or when a local (llama-server) rung is in play.
The manifest field itself is documented in SKILL.md; this file is the field
evidence behind the rung recommendations. Re-verify every id before relying on
it - gateway catalogs drift and prices rot faster than the ladder strategy.

Contents:
- Cheap-but-accurate open-weight rungs (gateway ids, Kimi pricing gotcha)
- OpenRouter fallback ladder, and the Kimi K3 reasoning cliff
- The $0 local rung: lock discipline, ceiling, working-window rules, judge-gated JSON, concurrent loops
- Judge-idiom evidence and the contract-fixture distance rule
- Judge-only-red endgame (operator policy)

## Rungs

- **Cheap-but-accurate open-weight rungs (via the opencode-zen gateway - the
  `opencode/...` provider is a live model gateway in pi's auth, not the retired
  opencode harness; ids verified in `~/.pi/agent/models-store.json`, which the
  picker refreshes).**
  `opencode/deepseek-v4-pro` is the cheapest near-frontier rung (top
  open-weight SWE-bench Verified; Artificial Analysis clocks it ~40x cheaper
  per task than Opus 4.8). `opencode/glm-5.2` is the best accuracy-per-dollar
  rung (top open-weight on the AA Intelligence Index, beats GPT-5.5 on
  SWE-bench Pro, roughly 6-8x cheaper output than Opus). The two make a strong
  cheap base under a frontier top (`anthropic/claude-sonnet-5`, or
  `claude-opus-4-8` only if you want the ceiling). `opencode/deepseek-v4-flash-free`
  is a $0 bottom rung for high-volume iterations. Working example:
  `~/infra/knotea/.pi/harness.json` uses
  `["opencode/deepseek-v4-pro", "opencode/glm-5.2", "anthropic/claude-sonnet-5"]`.
- **Gotcha: Kimi K3 is NOT a cheap rung.** It matches Opus 4.8 on quality (AA
  Intelligence Index ~57) but is frontier-priced (~$3/$15 per M). It IS in
  the opencode-zen catalog (`opencode/kimi-k3`). For a Kimi rung use `opencode/kimi-k2.5`
  (cheapest) / `kimi-k2.6` / `kimi-k2.7-code` (coding-tuned). Re-verify all ids
  before relying on them - gateway catalogs drift, and exact prices rot faster
  than the ladder strategy does.
- **OpenRouter fallback ladder.** When the opencode-zen gateway returns 401
  `CreditsError` (balance exhausted), the `openrouter` provider is a working
  fallback - pi reads the same `~/.pi/agent/auth.json` and routes to
  OpenRouter instead. Worker rung: `deepseek/deepseek-v4-pro`. Judge rung:
  `moonshotai/kimi-k3`. OpenRouter's low-balance signature is HTTP 402 with a
  `lower max_tokens / prompt size` message; a native Anthropic rung
  (`anthropic/claude-sonnet-5`) completed the 2026-08-11 memledger run after
  both gateways hit their balance limits. Add these ids to the ladder so the
  loop automatically traverses gateways when one is drained.
- **Gotcha: Kimi K3 reasoning cliff on OpenRouter (since 2026-08-19/20).**
  K3's per-turn think-rate dropped from 87-99% to 23-30%, scaling with
  context (>150k prompt tokens: 4-15% vs 88-100% before). A judge that is
  not thinking rubber-stamps iterations, so treat the K3 judge-rung and
  escalation-pairing recommendations above as suspended for
  `openrouter/moonshotai/kimi-k3` until confirmed fixed.
  `deepseek-v4-pro` held 97% at >=100k on the same days - use it as the
  OpenRouter judge instead. Single-turn probes still reason (suppression
  is specific to long multi-turn session shape), so a smoke test will not
  catch it; verify via the session-jsonl reasoning-vs-context cross-tab
  (method: https://erfi.dev/guides/diagnosing-llm-reasoning-cliffs/).
  opencode-zen's K3 path reasoned in a 163k single-shot probe on 2026-08-23
  but is untested in long sessions - cross-tab it before trusting it as a
  judge.
- **$0 local rung (llama-server provider, llm-compose proxy on the 5090).**
  `llama-server/loop` (Qwen3.8 27B Dense, agentic-tuned preset - migrated
  from Gemma 4 26B-A4B MoE on 2026-08-27) is a real worker rung for judged
  loops, not just a toy. Gemma-era A/B on the same scoped task (proxy
  /metrics route, kimi-k3 judge both runs) passed in 2 iterations / 8 min
  vs the old `qwen36-moe`'s 3 iterations / 15 min - the MoE generation-speed
  and instruction-following edge showed as wall-clock; Qwen3.8's medium
  effort keeps thinking traces leaner than Gemma 4's 10K+ xhigh binges, so
  the wide-window rules below stay load-bearing.
  Two operational requirements, both observed live on 2026-08-12: **lock the
  preset first** (`llmc lock loop --owner "$PI_SESSION_ID" --wait` -
  `--wait` queues FIFO if another preset is pinned) or any other
  client of the proxy (Open WebUI re-POSTs the previously-selected model)
  evicts the worker's model mid-iteration; and keep the judge on a hosted
  frontier model - the local rung writes, the frontier judges, so the only
  cost is a per-iteration review call.
- **Local-rung ceiling + the working-window rules.** The local rung one-shots
  scoped tasks
  (single-file, ~3-hunk semantic changes with a contract probe) but stalls
  on multi-file refactors - pair it with a frontier escalation rung
  (`["llama-server/loop", "openrouter/moonshotai/kimi-k3"]`) for anything
  bigger. To make the local rung reliable at all you must size its working
  window: (1) the loop preset needs a WIDE context (262144) - at 131072 the
  85% auto-compact threshold (~111K tokens) killed every iteration, because
  big file reads plus 10K-token thinking traces eat ~15K/turn; (2) pass
  `PI_COMPACT_FRACTION=0.95` for headroom; (3) bump `agentTimeoutMs` to
  3600000 - 1800s is too tight for a thinking MoE on multi-file tasks (two
  iterations died mid-work at the deadline); (4) slice manifests to ~3-hunk
  scope and put EDIT DISCIPLINE in `rules` (no whole-file rewrites, exact
  oldText from a fresh read, `python3 -c 'import <module>'` after every
  edit) - unsliced, the model corrupted proxy.py with syntax errors on 4
  straight iterations; sliced, it converged in 3; (5) for precise contracts,
  an operator-owned acceptance probe OUTSIDE writeScope (e.g.
  `.pi/lock-owners-probe.py`, booting the real handler over HTTP) is the
  strongest sensor form - the agent cannot edit it, and its named check
  failures are exactly the feedback a weak model needs.
- **Judge-gated schema-exact JSON is beyond the local rung (measured
  2026-08-13, hearth power dashboard loop, 6 iterations + trial).** Gemma
  26B one-shot ~95% of a 4-file task (render.sh job, compose changes,
  16-panel dashboard, valid PromQL) in iteration 1, then ORBITED the
  frontier judge for 6 iterations without converging: every rewrite fixed
  the judge's named items and invented fresh schema errors (drawMode/
  stackType keys, matcher `type` vs `id`, raw-tab corruption inside
  strings, gridPos deleted wholesale). Practical endgame: when the judge's
  list is down to enumerable schema placements and the local rung has
  rewritten the file 3+ times, the operator lands the list by hand (judge
  went green first try). Adjacent traps, all observed: (1) **kept-on-
  changed-failure-content sinks the floor** - when the judge is the ONLY
  red sensor, a strictly-worse diff (gridPos deleted, datasource type
  corrupted) is KEPT because the failure text changed; add a cheap
  computational floor sensor for shape invariants (gridPos keys,
  datasource `type`) so regressions flip a guard red and force rollback.
  (2) **Mid-run guide edits are futile** - the scope guard restores
  tracked out-of-scope files from the checkpoint, including the operator's
  own guide enrichment; enrich the guide BETWEEN runs. (3) The scope guard
  otherwise works exactly as designed: 33 out-of-scope agent writes (a
  split-into-p1..p17.json strategy) reverted cleanly. (4) A strong
  anti-hallucination sensor form: validate every metric name in dashboard
  exprs against the LIVE endpoint (caught `hearth_sensor_power_sw`).
  (5) A trial/run that dies mid-iteration leaves the governor's checkpoint
  staged in the index; recover the pre-run state with
  `git restore --source=HEAD --staged --worktree -- .`
- **Local-rung ceiling refined (measured 2026-08-17/18, supabase-lab
  battery, 6 modules):** the single-file ceiling is really a
  single-CONTRACT ceiling. X03 (one API claim, ~150 lines, live pair
  already up) one-shotted probe-green in iteration 1. Anything with 4+
  result rows, two systems (Supabase + a gateway), or ~400 lines (M01,
  M02, L01) thrashed: mid-write regressions rolled back, malformed
  `peg-gemma4` output, markdown bold leaked into a FILENAME, confessional
  comments left in code ("typo I introduced", "fix in a second"), and a
  fabricated error excuse ("project host unreachable") when the real bug
  was its own wrong URL constant. Two of six drafts SMUGGLED SECRETS
  (token values into serialized results via extra fields / raw 200 bodies
  with rotated tokens) - the frontier judge caught both; never run the
  local rung without a judge sensor on anything touching credentials.
  Working pattern: let the loop reach probe-green, then the operator
  lands judge nits by hand - every hand-landing was under 15 targeted
  lines. Also: (1) check the new module's id against `pvlab --list`
  BEFORE writing the manifest - two of my manifests hit pre-existing id
  collisions (P01, I04) and the `registered` expect-fail sensor then
  passes at baseline, refusing the run; (2) `loop run` needs a green
  BASELINE - two sessions found pre-existing typecheck breakage in
  sibling experiments that blocked every run until fixed by hand; (3)
  bg_task tmux sessions do NOT inherit the caller's env - a probe that
  reads secrets from the environment silently falls back to placeholders
  and 401s unless wrapped in `bash -lc`.
- **Concurrent loops (llm-compose).** The proxy lock is a SHARED lock with
  named owners: each loop `llmc lock loop --owner <session-id>`, unlock
  releases only that owner. Concurrent loops must share ONE preset (the
  `loop` preset runs `parallel_slots = 1`, 262144 ctx); loops on DIFFERENT
  presets queue instead of fighting - `llmc lock <preset> --wait` joins a
  FIFO and the grant lands when the current owners drain (a contended
  lock without --wait 409s; it NEVER hijacks the running model - the
  pre-2026-08-17 hijack killed a loop mid-iteration). Same-repo loops need
  a separate git worktree each; and loop sensors must never rebuild/restart
  the stack that serves them (a proxy restart kills the other loop's
  in-flight request). Since 2026-08-12 (llm-compose a566af5) the lock is
  persisted via the proxy state file and SURVIVES a proxy restart - so a
  loop that exits without unlocking leaves the pinned model resident,
  holding VRAM indefinitely (observed 2026-08-13: Gemma 26B squatting
  22.5 GiB for hours after loop end). Always `llmc unlock --owner <id>`
  in loop teardown; `llmc unlock` (ownerless) force-clears a stale set.
- **Judge-idiom evidence.** In the 2026-08-11 memledger-summarise loop the
  `moonshotai/kimi-k3` judge caught a degenerate-filter threshold drift (40
  -> 27) plus a fabricated `the contract test pins this` justification
  comment that every deterministic sensor (build, test, lint, vuln, secrets)
  passed green. The judge sensor earns its cost - it catches plausible-looking
  incorrectness that deterministic sensors are structurally blind to.
- **Contract-fixture distance rule.** Keep contract-test fixture values far
  from any threshold you intend to freeze. A 27-character fake-LLM summary
  fixture silently pinned the summarise-filter threshold below the intended
  40 in the 2026-08-11 run, forcing the implementation to drift. The agent
  correctly adapted to the test - the test was simply wrong.

## Judge-only-red endgame

- **Judge-only-red endgame (operator policy, not a harness flag).** If every
computational sensor is green and the judge is the ONLY red sensor for 3
consecutive iterations, stop the run and land the judge's remaining list
by hand (or one frontier-worker pass) - do not burn the rest of the
iteration budget pleasing a fail-closed judge with a weaker writer.
Measured 2026-08-13: a local rung orbited a frontier judge for 6
iterations, each rewrite fixing the named items and inventing fresh
breakage; the operator landed the list first try. Two preconditions
before treating a run as judge-only-red: (1) add cheap computational
floor sensors for shape invariants first - kept-on-changed failure text
can let a strictly-worse diff survive when the judge is the sole red;
(2) confirm the judge's remaining asks are enumerable nits, not a real
design objection - this policy covers taste/schema nits, not substance.
