---
name: llm-compose
description: "Use when working on or with the user's local LLM stack (llm-compose on the RTX 5090 dev box) - switching or locking a model preset, llmc bench, adding a preset or GGUF, debugging model_proxy_go, GGUF drift audits, or GPU time between llama-server, whisper, comfyui and lora-train. Fires on 'llm-compose', 'llmc', 'llama-server', 'model preset', 'qwen38', 'model lock active'. NOT for the servarr gumshoe stack (research), transcription (whisper), image gen (comfyui) or LoRA training (lora-train)."
---

# llm-compose

Local LLM + image + LoRA-train stack on the WSL2 dev box (RTX 5090 32GB,
sm_120). Repo `~/infra/ai/llm-compose` (PUBLIC GitHub repo - no internal
identifiers in tracked files). All Docker; `model_proxy_go` (:11434,
OpenAI-compatible) owns container lifecycle.

## One GPU job at a time (the model-lock rule)

This is the canonical statement; the whisper, comfyui and lora-train skills
point here.

- The proxy runs ONE GPU workload: llama-server (a preset), ComfyUI, or the
  trainer. Starting whisper batch jobs, a ComfyUI prompt or a training run
  swaps the running model out; the next LLM request swaps it back (20-60s).
- `llmc lock <preset> --owner <id>` pins a preset against evicting swaps.
  ALWAYS lock before an unattended loop, one owner per concurrent loop. A
  swap/comfyui/train call that gets **503 "model lock active"** means a loop
  holds the pin: do NOT `llmc unlock` without asking. `curl -s
  localhost:11434/mode` shows `lock_owners` (who holds it) and `lock_queue`
  (who waits); wait or coordinate.
- A contended `llmc lock` 409s and never hijacks the running model. `--wait`
  joins the proxy's FIFO queue (202 + position; the head's next poll gets the
  grant once owners drain; the swap to the granted preset is lazy). Unlocking
  drops your queue entry. The queue is in-memory (a proxy restart drops it,
  pollers re-enqueue); the lock itself is persisted and restart-safe.
- Lock TTL is 900s (`LLMC_LOCK_TTL_S`). A leg that sends no request for longer
  than the TTL lapses the lock silently - heartbeat with `llmc lock --renew`;
  `llmc status` prints expires-in.
- Bench modules (owner `bench`) fail fast on contention; a killed bench run
  leaves a stale `bench` lock -> `llmc unlock --owner bench`.
- whisper-live keeps ~5.6 GiB resident even when idle; `llmc bench perf` stops
  and restarts the whisper containers around GPU-exclusive work.

## Daily commands

```bash
export PATH="$HOME/infra/ai/llm-compose/bin:$PATH"
llmc status / models / switch <preset> / health
llmc lock <preset> --owner <id> [--wait]   # --wait queues FIFO; without it a contended lock 409s
llmc unlock [--owner id]                   # ownerless = force-clear all
llmc lock --renew [--owner id]             # heartbeat the 900s TTL
llmc mode llm|comfyui|train [--model X]    # explicit GPU mode swap
make up / down / restart / test            # restart = force-recreate proxy+webui
make build-proxy                           # after ANY llmc/ code change (proxy bakes it)
```

Presets = `models/*.toml` ([model] repo/file, [mmproj], [runtime]
reasoning/context_size/parallel_slots/sampling/spec_type, [template] file,
[bench] tokenizer). Adding a preset TOML = hot-reload, no restart. GGUFs live
in `~/docker-volumes/llama-server/models/` (local file beats HF download).

## Adopted model configuration (qwen38 is the daily driver)

The eval matrix that produced these is closed; numbers live in the repo:
`docs/plans/2026-08-16-p3-matrix-results.md` (final scores),
`docs/reference/eval-harness.md` (harness internals + bfcl-eval landmines),
`docs/plans/2026-08-19-qwen38-p5-effort-spec.md` and
`docs/reference/speculative-decoding.md` (effort/spec A/Bs), public writeup
https://erfi.dev/reference/local-model-bench/. The rules that came out:

- **Roles**: `loop` preset for the loop engine (ties qwen38 on the task suite
  at 2.7x decode and far cheaper failure); `qwen38` for interactive coding,
  chat and vision; gemma4-12b is the small-track candidate, gated on 3080 Ti
  deploy-fit.
- **`reasoning_effort = "medium"`** in `models/qwen38.toml`. Quality-neutral
  on the task suite; xhigh (the server default) injects think-carefully
  language and produces thinking binges. Mechanics: preset key ->
  `CHAT_TEMPLATE_KWARGS` env -> `--chat-template-kwargs` (compact JSON, no
  spaces - the entrypoint word-splits). pi sends no per-request effort, so the
  preset default is the only lever.
- **No speculation** for qwen38. Both MTP (draft-mtp) and ngram-mod degrade to
  <1 tok/s under agentic churn on this hybrid Gated DeltaNet model; only
  no-spec sustains 55-66 tok/s over long tasks. MTP survives only in the
  babysat `qwen38-xhigh` variant. Spec numbers are interactive-only.
- **Quant**: qwen38 / qwen38-xhigh / loop run unsloth `UD-Q4_K_M` (upstream
  deleted the plain K-quants). The retired blob stays on disk + tank as a
  rollback artifact referenced by no preset.
- **Chat template**: `templates/qwen38-fixed.jinja` (froggeric
  Qwen-Fixed-Chat-Templates, v22.4) via `[template] file =` in each qwen38
  TOML. Fixes empty-think poisoning, tool-call crash on JSON-string args,
  mid-dialogue system-message drops, stray newline before `<tool_call>`.
  Upstream archives every release; check for newer - a template bug reads as
  a model failure.
- **Context**: `context_size = 262144` (native max) x 1 slot. The old 196608
  "ceiling" was a measurement artifact (the sweep ran while whisper-live held
  ~4 GB of the GPU); the note in `models/qwen38.toml` has the story.
- **`reasoning_budget`** (llama.cpp `--reasoning-budget`) exists but NO preset
  sets it: exhaustion injects the end-of-thinking tag and forces an answer
  from a chain cut mid-sentence, and the measured p99 (9201 tokens) means any
  cap that bites cuts converging work. `docs/reference/reasoning-budget.md`
  has the distributions.
- **BFCL dropped** from the eval set: the sixth crash is inside bfcl's own
  leaderboard CSV formatter; per-category score files are the fix path.

## Bench framework (`llmc bench`)

`llmc bench perf|eval|gumshoe|tasks|report|watch` in `llmc/bench/`. Result
store `bench/results/runs.jsonl` (COMMITTED - trend history is the point)
with llama.cpp pin + GPU + preset_hash provenance. perf runs through the
proxy (lock+switch per preset); eval = eval container (HumanEval/lm-eval,
per-preset tokenizer); gumshoe = 18-case research-agent suite (fixtures in the
gumshoe repo, stub tools, measures JSON-protocol validity); tasks =
sensor-gated loop-task suite (every probe needs a canary + `llmc bench tasks
--verify-only` before scoring models). `bench watch` = staleness report after
pin bumps or preset edits.

**Reading bench output (each rule cost a wrong conclusion):**
- **Read medians, not totals or means.** One 1165s outlier inside a single
  iteration moved an arm's total 3x and meant nothing.
- **2 runs is not a sample.** A 2-run pass had the UD quant 63% slower; at 3
  runs it was faster - the first pass ran on a just-downloaded GGUF with a
  cold page cache.
- **The `tasks` micro-suite (t1-t6) cannot measure long-horizon behaviour.**
  Its longest generation is 412 tokens (1134 at xhigh); a real greenfield
  build generated 9564. Claims about thinking length, context growth or
  compaction need a real scoped task in a git worktree.
- `perf`'s `pp` column is measured on a ~17k uncached prompt and printed with
  `prompt_n`; older runs read pp off a ~30-token prompt and are noise.
- Measured reference (qwen38, UD-Q4_K_M, 262144 ctx): gen 75.6 tok/s, prefill
  3675.5 tok/s at prompt_n 17221, TTFT p50 167.7ms, VRAM peak 29217 MiB.
- Empty-metrics eval records in runs.jsonl = broken harness run; patch or
  drop them.

## Upstream GGUF drift - `make audit`

A preset's `[model] repo`+`file` is the entrypoint's download fallback, and
upstream DELETES files (unsloth wiped every plain K-quant of Qwen3.8-27B;
ggml-org did the same to both gemma-4 repos). `make audit` / `llmc audit
[--deep] [--backup] [--unreferenced]` classifies every preset file
ok/renamed/diff/gone/missing/local-only; `--backup` rsyncs orphans to
`servarr:/tank/backups/llm-models/orphaned` with far-end sha256 verify;
weekly `llmc-model-audit.timer` (units in `deploy/`, `make install-timer`).
Read-only mode checks the backup dest, so a safe orphan exits 0. Full doc:
`docs/reference/model-audit.md`.

- **HF's LFS `oid` IS the file's sha256** - upstream identity is checkable
  without downloading.
- A failed HF lookup is `unknown`, NEVER `gone` - a rate limit read as a
  deletion triggers pointless multi-GiB copies.
- `--unreferenced` is the mirror question (which files does no preset name).
- Archive dormant GGUFs to tank, do NOT network-mount them: servarr's live
  NIC is 1 GbE, so a 16.5 GB model loads in ~155 s over the wire vs 5-10 s
  warm locally. Fine for an archive, wrong for the daily driver.

## proxy-go (authoritative)

`proxy-go/` is the v2 proxy in Go (spec `docs/specs/2026-08-19-model-proxy-v2.md`).
Over the retired Python proxy it adds drain-before-swap (`LLMC_DRAIN_GRACE_S`,
default 60s), capability serve-in-place (`X-LLM-Capability` header /
`cap:<name>` model form; preset TOMLs carry `capabilities = [...]`), lock TTL
+ renewal (POST /mode `{"renew": true}`; `lock_expires_at` in GET /mode),
liveness recovery (connection-level upstream death flips mode to idle, next
acquire respawns), the durable FIFO lock queue, and an Anthropic
`/v1/messages` shim for Claude Code (`ANTHROPIC_BASE_URL=http://127.0.0.1:11434`).
`model-proxy-go` owns **127.0.0.1:11434**; state dir
`~/docker-volumes/state-go`. The Python proxy is stopped on :11436 as the
rollback lane (swap published ports in compose.yaml to revert). Commands:
`make build-proxy-go` / `make test-proxy-go` / `make smoke-proxy-go`.

## Gotchas (all hit for real)

- **Repo re-clone breaks the proxy's bind mount** (stale inode) - presets 404
  on switch until `docker restart model_proxy_go`.
- **Preset schema changes need `make build-proxy`** - the running proxy
  validates TOMLs from baked code and crash-loops on unknown keys.
- **A new runtime key must land in BOTH schemas** - `llmc/presets.py` AND
  `proxy-go/internal/proxy/presets.go` (struct field + `runtimeKeys` +
  validation + env emission). proxy-go fails the WHOLE preset reload on one
  unknown key, so adding it python-side only silently freezes `/v1/models`
  at its last good state.
- **Presets dedup by model_id (the GGUF file stem)** - two presets on one GGUF
  crash-loop the proxy. An A/B arm needs a distinct filename: hardlink the
  same blob (zero disk; see `bench/p4-mtp.sh`). `llmc models` indexes by
  model_id, `llmc bench` by preset name - don't confuse the keyings.
- **Dispatching work TO the local model** (bg_task with llama-server/*): scope
  each dispatch to one deliverable and paste API contracts into the prompt
  with a "do NOT read other files" rule - read-everything prompts collapse
  throughput; scoped ones finish in minutes.
- `loop run` workdir must be clean (commit .pi/harness.json into baseline).
- Eval image: bfcl-eval needs `--no-deps` + relaxed faiss-cpu, lives in its
  own venv (/opt/venv-bfcl) with a sitecustomize shim registering local model
  ids. BFCL has no working subset flag; the category is `non_live`.
- python stdout through tee/pipes is block-buffered - bin/llmc sets
  PYTHONUNBUFFERED=1.
