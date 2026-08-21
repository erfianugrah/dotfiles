---
name: llm-compose
description: Use when working on or with the user's local LLM stack (llm-compose on the 5090 dev box) - switching/locking model presets, the llmc bench framework (perf/eval/gumshoe/tasks), adding a preset or GGUF, debugging the model_proxy, GPU mode sharing with comfyui/lora-train/whisper, or the Qwen3.8-vs-Gemma-4 model evaluation. Fires on 'llm-compose', 'llmc', 'llama-server', 'model preset', 'loop engine', 'llmc bench', 'qwen38', 'local model bench'. NOT for the servarr gumshoe/1070 stack (gumshoe/research skills), whisper transcription (whisper skill), image gen (comfyui skill), or LoRA training (lora-train skill).
---

# llm-compose

Local LLM + image + LoRA-train stack on the WSL2 dev box (RTX 5090 32GB,
sm_120). Repo `~/infra/ai/llm-compose` (PUBLIC GitHub repo - no internal
identifiers in tracked files). All Docker; only one GPU workload at a time;
`model_proxy` (:11434, OpenAI-compatible) owns container lifecycle.

## Daily commands

```bash
export PATH="$HOME/infra/ai/llm-compose/bin:$PATH"
llmc status / models / switch <preset> / health
llmc lock <preset> --owner <id> --wait   # pin against evicting swaps; ALWAYS lock before unattended loops, one owner per concurrent loop. --wait queues FIFO when another preset is pinned (contended lock NEVER hijacks since 2026-08-17); drop --wait for fail-fast 409.
llmc unlock [--owner id]          # ownerless = force-clear all
make up / down / restart / test   # restart = force-recreate proxy+webui
make build-proxy                  # after ANY llmc/ code change (proxy bakes it)
```

Presets = `models/*.toml` ([model] repo/file, [mmproj], [runtime]
reasoning/context_size/parallel_slots/sampling/spec_type, [bench] tokenizer).
Adding a preset TOML = hot-reload, no restart. GGUFs live in
`~/docker-volumes/llama-server/models/` (local file beats HF download).

## Bench framework (`llmc bench`, shipped 2026-08-16)

`llmc bench perf|eval|gumshoe|tasks|report|watch` in `llmc/bench/`.
Result store `bench/results/runs.jsonl` (COMMITTED - trend history is the
point) with llama.cpp pin + GPU + preset_hash provenance. Conventions:
perf through the proxy (lock+switch per preset); eval = eval container
(HumanEval/lm-eval/BFCL, per-preset tokenizer); gumshoe = 18-case
research-agent suite (canonical fixtures in the gumshoe repo, stub tools,
measures JSON-protocol validity the gateway hides); tasks = sensor-gated
loop-task suite (fixtures+manifests+canary solutions in bench/, every probe
needs a canary + `llmc bench tasks --verify-only` before scoring models).
`bench watch` = staleness report after pin bumps/preset edits.

## proxy-go (Go rewrite, AUTHORITATIVE since 2026-08-19)

`proxy-go/` = the v2 proxy in Go (spec `docs/specs/2026-08-19-model-proxy-v2.md`).
Adds over the Python proxy: drain-before-swap (`LLMC_DRAIN_GRACE_S`, default 60s),
capability serve-in-place (`X-LLM-Capability` header / `cap:<name>` model form;
preset TOMLs carry `capabilities = [...]`), lock TTL (`LLMC_LOCK_TTL_S`, 900s) +
durable FIFO queue in active.toml, and an Anthropic `/v1/messages` shim for
Claude Code (`ANTHROPIC_BASE_URL=http://127.0.0.1:11434`). `model-proxy-go`
owns **127.0.0.1:11434** (all clients cut over 2026-08-19); own state dir
`~/docker-volumes/state-go`. The Python proxy is stopped on :11436 as the
rollback lane (swap published ports in compose.yaml to revert).
Commands: `make build-proxy-go` / `make test-proxy-go` / `make smoke-proxy-go`.

## Gotchas (all hit for real)

- **Repo re-clone breaks the proxy's bind mount** (stale inode) - presets
  404 on switch until `docker restart model_proxy`.
- **Preset schema changes need `make build-proxy`** - the running proxy
  validates TOMLs from baked code and crash-loops on unknown keys.
- whisper GPU services hold ~5.6GB - `llmc bench perf` stops+restarts them.
- Locks are restart-safe (persisted to state volume). A client POSTing a
  different model gets 503 "model lock active" while locked.
- **qwen38 context ceiling = 196608 x 1 slot** (2026-08-20 occupancy sweep,
  real KV fill): 196608 -> 59.8->42 t/s as occupancy rises; 229376 -> 4 t/s
  (14x collapse, flat across occupancy); 245760 -> 0.31. Structural limit past
  196608, NOT occupancy/VRAM. 196608 x 1 slot is the config.
- **Dispatching work TO the local model** (bg_task with llama-server/*):
  scope each dispatch to one deliverable and paste API contracts into the
  prompt with a "do NOT read other files" rule - monolithic read-everything
  prompts collapse throughput; scoped ones finish in minutes.
- Lock queue (2026-08-17): a contended `llmc lock` 409s (never hijacks the
  running model); `--wait` joins the proxy's FIFO queue (202 + position; the
  head's next poll gets the grant once owners drain; swap to the granted
  preset is lazy). Unlocking drops your queue entry too. The queue is
  IN-MEMORY only - a proxy restart drops it and pollers re-enqueue
  automatically; the lock itself stays restart-safe. `llmc status` shows
  `Lock queue`. Bench modules (owner `bench`) fail fast on contention -
  rerun when the GPU is free.
- llmc models indexes by model_id (GGUF stem), llmc bench re-indexes by
  preset name - don't confuse the two keyings.
- `loop run` workdir must be clean (commit .pi/harness.json into baseline).
- Eval image: bfcl-eval needs `--no-deps` + relaxed faiss-cpu (PyPI dropped
  its pinned 1.11.0), lives in its own venv (/opt/venv-bfcl) with a
  sitecustomize shim registering local model ids. BFCL has no working
  subset flag; the category is `non_live` (the old `ast` is gone).
- python stdout through tee/pipes is block-buffered - bin/llmc sets
  PYTHONUNBUFFERED=1.

## Model eval state (2026-08-17) - COMPLETE, decisions adopted

Final numbers: repo docs/plans/2026-08-16-p3-matrix-results.md. Harness
internals + the six bfcl-eval landmines: docs/reference/eval-harness.md.
Public writeup: https://erfi.dev/reference/local-model-bench/

Adopted:
- loop engine: loop preset stays (tasks 12/18 tie with qwen38; 2.7x decode,
  3-7x cheaper failure; write-new-tests is the suite ceiling, not a
  differentiator)
- interactive coding/chat/vision: qwen38, now (2026-08-19, P5+P6)
  `reasoning_effort = "medium"` and NO speculation in
  models/qwen38.toml. BOTH speculators degrade under agentic churn on
  this hybrid Gated DeltaNet model: MTP draft-mtp within ~10 min
  (upstream #27151/#27296) and ngram-mod identically (p6 validation:
  0.6-0.7 tok/s, GPU idle, restart restores). Hypothesis: rejected-draft
  rollback of the recurrent state costs too much at 24k+ context. Only
  no-spec sustained 55-66 tok/s through a 5433s task. ngram-mod short-
  burst perf was +93-100% cold pool - worth re-testing on future pins.
  MTP survives only as the `qwen38-xhigh` variant preset (babysat
  interactive). llama.cpp pin b10472 fixed the abandoned-stream
  slot-parking bug. Details: docs/plans/2026-08-19-qwen38-p5-effort-spec.md
  + docs/reference/speculative-decoding.md.
- small track: gemma4-12b ties qwen35-9b incumbent (0.944 hit) with fewer
  steps (1.67 vs 2.30); swap gated on 3080 Ti deploy-fit. g15-chain is 0/3
  for everything - the discriminator case.
- BFCL dropped: five harness fixes committed (see reference doc), sixth
  crash is inside bfcl's own leaderboard CSV formatter; per-category score
  files are the fix path if revisited.

Numbers: humaneval loop 0.116 / gemma4 0.293 / qwen38 0.451
(harness-relative, xhigh effort). Perf gen tok/s: loop 199 / gemma4 63 /
qwen38 74 / qwen38-mtp 85 / qwen38-ngram ~141 cold (both speculators
short-burst only - they degrade under churn; treat spec numbers as
interactive-only).

reasoning_effort (2026-08-19 P5 A/B, resolved): quality-neutral on the
task suite (ceiling tasks fail identically xhigh vs medium), and medium
kills the thinking-binge lottery (xhigh burned 1308s on a 19.7s task;
medium: tight 10-31s band) - adopted as the qwen38 default.
Mechanics: preset key `reasoning_effort = "medium"` -> CHAT_TEMPLATE_KWARGS
env -> --chat-template-kwargs (compact JSON - the entrypoint word-splits,
no spaces allowed). xhigh (server default) injects 'think carefully'
language = 15k-40k thinking tokens/prompt (community-reported). pi sends
no per-request effort (supportsReasoningEffort: false) - preset default
is the only lever.

Ops gotchas added this run: presets dedup by model_id (GGUF stem) - two
presets on one GGUF crash-loop the proxy; an A/B preset needs a hardlinked
GGUF filename (see bench/p4-mtp.sh). Killed bench runs leave a stale
`bench` lock -> `llmc unlock --owner bench`. Empty-metrics eval records in
runs.jsonl = broken harness run; patch or drop them.
