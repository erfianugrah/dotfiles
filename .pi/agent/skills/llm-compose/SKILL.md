---
name: llm-compose
description: Use when working on or with the user's local LLM stack (llm-compose on the 5090 dev box) - switching/locking model presets, the llmc bench framework (perf/eval/gumshoe/tasks), adding a preset or GGUF, debugging the model_proxy_go, GPU mode sharing with comfyui/lora-train/whisper, or the Qwen3.8-vs-Gemma-4 model evaluation. Fires on 'llm-compose', 'llmc', 'llama-server', 'model preset', 'loop engine', 'llmc bench', 'qwen38', 'local model bench'. NOT for the servarr gumshoe/1070 stack (gumshoe/research skills), whisper transcription (whisper skill), image gen (comfyui skill), or LoRA training (lora-train skill).
---

# llm-compose

Local LLM + image + LoRA-train stack on the WSL2 dev box (RTX 5090 32GB,
sm_120). Repo `~/infra/ai/llm-compose` (PUBLIC GitHub repo - no internal
identifiers in tracked files). All Docker; only one GPU workload at a time;
`model_proxy_go` (:11434, OpenAI-compatible) owns container lifecycle.

## Daily commands

```bash
export PATH="$HOME/infra/ai/llm-compose/bin:$PATH"
llmc status / models / switch <preset> / health
llmc lock <preset> --owner <id> --wait   # pin against evicting swaps; ALWAYS lock before unattended loops, one owner per concurrent loop. --wait queues FIFO when another preset is pinned (contended lock NEVER hijacks since 2026-08-17); drop --wait for fail-fast 409.
llmc unlock [--owner id]          # ownerless = force-clear all
llmc lock --renew [--owner id]    # heartbeat the 900s lock TTL - legs that go >TTL with no request lapse the lock silently; `llmc status` shows expires-in
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

**Reading bench output (each lesson cost a wrong conclusion, 2026-09-02):**
- **Read medians, not totals/means.** A single task run hit 1165s inside ONE
  iteration; it moved the arm's total by 3x and meant nothing about the arm.
- **2 runs is not a sample.** A 2-run pass had the UD quant looking 63%
  slower; at 3 runs it was FASTER. The first pass ran on a GGUF downloaded
  minutes earlier - cold page cache.
- **The `tasks` micro-suite (t1-t6) cannot measure long-horizon behaviour.**
  Max single generation across the 4 fast tasks is 412 tokens (1134 at
  xhigh). A real greenfield build generated 9564. Anything about thinking
  length, context growth or compaction measured on t1-t6 is a false
  negative. Use a real scoped task in a git worktree instead (pylon Phase 0
  was the instrument: 202 requests, 490k tokens, prompts to 36k).
- `perf`'s `pp` column was meaningless before 2026-09-02 (read off a
  ~30-token prompt = overhead, not prefill; it reported 27 tok/s against a
  real 2452). Now measured on a ~17k uncached prompt and printed with
  `prompt_n` - anything quoting old pp numbers is quoting noise.
- Measured reference (qwen38 on UD-Q4_K_M, 262144 ctx): gen 75.6 tok/s,
  prefill 3675.5 tok/s at prompt_n 17221, TTFT p50 167.7ms, VRAM peak
  29217 MiB.

## Upstream GGUF drift - `make audit` (2026-09-02)

A preset's `[model] repo`+`file` is the entrypoint's download fallback, and
upstream DELETES files: unsloth wiped every plain K-quant of Qwen3.8-27B on
2026-08-19 (UD-only + imatrix re-upload), ggml-org did the same to both
gemma-4 repos. Four local GGUFs were orphaned - unrecoverable if the volume
had been lost - and nothing noticed for two weeks.

`make audit` / `llmc audit [--deep] [--backup] [--unreferenced]` classifies
every preset file ok/renamed/diff/gone/missing/local-only; `--backup` rsyncs
orphans to `servarr:/tank/backups/llm-models/orphaned` with far-end sha256
verify; weekly `llmc-model-audit.timer` (units in `deploy/`, `make
install-timer`). Read-only mode checks the backup dest, so a safe orphan
exits 0. Full doc: `docs/reference/model-audit.md`.

- **HF's LFS `oid` IS the file's sha256** (verified against gemma-4-12b) -
  upstream identity is checkable without downloading anything.
- A failed HF lookup is `unknown`, NEVER `gone` - a rate limit read as a
  deletion triggers pointless multi-GiB copies.
- `--unreferenced` is the mirror question (which files does no preset name):
  found 146G of dead GGUFs on a 91%-full disk.
- Archive dormant GGUFs to tank, do NOT network-mount them. Measured
  2026-09-02: 3 GB read over ssh took 28.233s (106.3 MB/s), identical over
  tailnet and direct LAN, and servarr's only live NIC reports
  `Speed: 1000Mb/s` - that is wire speed, so no protocol swap beats it. A
  16.5 GB model therefore loads in ~155 s vs 5-10s warm locally. With full
  offload the file is untouched after load, so the cost is load-time only:
  fine for an archive, wrong for the daily driver.

## proxy-go (Go rewrite, AUTHORITATIVE since 2026-08-19)

`proxy-go/` = the v2 proxy in Go (spec `docs/specs/2026-08-19-model-proxy-v2.md`).
Adds over the Python proxy: drain-before-swap (`LLMC_DRAIN_GRACE_S`, default 60s),
capability serve-in-place (`X-LLM-Capability` header / `cap:<name>` model form;
preset TOMLs carry `capabilities = [...]`), lock TTL (`LLMC_LOCK_TTL_S`, 900s) +
renewal (`llmc lock --renew` / POST /mode {"renew": true}; `lock_expires_at` in
GET /mode + `llmc status`), liveness recovery (connection-level upstream death
flips mode to idle, next acquire respawns - no more 502-loop), and a durable
FIFO queue in active.toml, plus an Anthropic `/v1/messages` shim for
Claude Code (`ANTHROPIC_BASE_URL=http://127.0.0.1:11434`). `model-proxy-go`
owns **127.0.0.1:11434** (all clients cut over 2026-08-19); own state dir
`~/docker-volumes/state-go`. The Python proxy is stopped on :11436 as the
rollback lane (swap published ports in compose.yaml to revert).
Commands: `make build-proxy-go` / `make test-proxy-go` / `make smoke-proxy-go`.

## Gotchas (all hit for real)

- **Repo re-clone breaks the proxy's bind mount** (stale inode) - presets
  404 on switch until `docker restart model_proxy_go`.
- **Preset schema changes need `make build-proxy`** - the running proxy
  validates TOMLs from baked code and crash-loops on unknown keys.
- **A new runtime key must land in BOTH schemas** - `llmc/presets.py` AND
  `proxy-go/internal/proxy/presets.go` (struct field + `runtimeKeys` +
  validation + env emission). proxy-go fails the WHOLE preset reload on one
  unknown key, so adding it python-side only silently freezes `/v1/models`
  at its last good state (hit 2026-09-02 adding `reasoning_budget`).
- **A/B preset arms need distinct GGUF filenames** (presets dedup by
  model_id = the file stem); hardlink the same blob, it costs zero disk.
- `reasoning_budget` (llama.cpp `--reasoning-budget`) exists but NO preset
  sets it, deliberately: budget exhaustion injects the end-of-thinking tag
  and forces an answer from a chain cut mid-sentence. Measured p99 is 9201
  tokens and nothing has exceeded 9564, so any cap low enough to bite would
  cut converging work. `docs/reference/reasoning-budget.md` has the
  distributions; revisit only with evidence of a true runaway.
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
- **Chat template**: qwen38 presets use froggeric/Qwen-Fixed-Chat-Templates,
  saved as `templates/qwen38-fixed.jinja` + `[template] file =` in each TOML.
  Fixes empty-think poisoning, tool-call crash on JSON-string args,
  mid-dialogue system-message drops, and hallucinated user instructions
  during thinking. **v22.4 since 2026-09-02** (was v22.3): adds multi-tool
  token alignment (drops a stray newline before `<tool_call>`) and assistant
  `message.reasoning` handling. Measured on the 4 fast tasks x2, same GGUF,
  container respawned: 8/8 PASS both arms, but iterations 12 -> 8 and total
  wall 543.4s -> 452.0s. Check the repo for newer versions - the upstream
  archives every release, and a template bug reads as a model failure.
- **Quant** (2026-09-02): qwen38 / qwen38-xhigh / loop all run unsloth
  `UD-Q4_K_M`, promoted from the plain `Q4_K_M` that upstream deleted.
  Same-invocation A/B, perf re-measured warm: median 44.8s vs 52.9s, max
  124.8s vs 1165.4s, gen 75.6 vs 73.5 tok/s, 29217 vs 29897 MiB, full
  262144 ctx held. The retired blob stays on disk + tank as a rollback
  artifact, referenced by no preset. `qwen38-fixed` / `qwen38-nospec` were
  deleted the same day - both had become no-ops once their findings were
  folded into qwen38.
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
