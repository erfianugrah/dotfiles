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
llmc lock <preset> --owner <id>   # pin against evicting swaps; ALWAYS lock before unattended loops, one owner per concurrent loop
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

## Gotchas (all hit for real)

- **Repo re-clone breaks the proxy's bind mount** (stale inode) - presets
  404 on switch until `docker restart model_proxy`.
- **Preset schema changes need `make build-proxy`** - the running proxy
  validates TOMLs from baked code and crash-loops on unknown keys.
- whisper GPU services hold ~5.6GB - `llmc bench perf` stops+restarts them.
- Locks are restart-safe (persisted to state volume). A client POSTing a
  different model gets 503 "model lock active" while locked.
- llmc models indexes by model_id (GGUF stem), llmc bench re-indexes by
  preset name - don't confuse the two keyings.
- `loop run` workdir must be clean (commit .pi/harness.json into baseline).
- Eval image: bfcl-eval needs `--no-deps` + relaxed faiss-cpu (PyPI dropped
  its pinned 1.11.0). BFCL has no working subset flag.
- python stdout through tee/pipes is block-buffered - bin/llmc sets
  PYTHONUNBUFFERED=1.

## Model eval state (2026-08-17)

Qwen3.8-27B (qwen38 preset, 196608x2) vs Gemma 4 loop engine: tied on the
task suite (both one-shot scoped edits, both stall writing NEW tests),
Gemma 2.7x faster decode + fails 3-7x cheaper. MTP draft-mtp spike queued
(bench/p4-mtp.sh; current Q4_K_M GGUF has the nextn MTP head baked in).
Small track for gumshoe/1070: qwen35-9b incumbent vs qwen35-4b, lfm25-8b,
gemma4-12b (12B deploy-fit deferred to planned 3080 Ti). Decision rules +
results: repo docs/plans/2026-08-15-local-model-bench-framework.md and
2026-08-17-mtp-speed-track.md. Pause/resume: bench/p3-resume.sh.
