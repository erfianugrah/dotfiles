---
name: lora-train
description: "Use when fine-tuning an SDXL or Flux checkpoint into a LoRA via the local lora-train service (kohya sd-scripts), captioning a training dataset (BLIP-2 natural language or WD14 Danbooru tags), auditing or filtering a dataset, or deploying a trained LoRA to ComfyUI. Fires on 'train a LoRA', 'fine-tune this checkpoint', 'kohya', 'caption this dataset', 'deploy the LoRA', 'llmc train'. NOT for generating images with a LoRA (comfyui) or LLM fine-tuning."
---

# LoRA Training

kohya sd-scripts wrapped in an HTTP API. Routes through the llm-compose proxy,
which also handles the GPU mode swap (stops llama-server / ComfyUI, starts
the trainer). A 503 "model lock active" means an unattended loop has pinned
the LLM preset - the rule and the etiquette live in the llm-compose skill
("One GPU job at a time"); do not `llmc unlock` without asking.

**Prefer the CLI over raw curl**: `llmc train status|logs|cancel|list|cleanup|deploy`
and `llmc dataset audit|filter|focus|caption|caption-status|caption-logs|caption-cancel`
(`~/infra/ai/llm-compose/bin/llmc`, `llmc train --help`) wrap the endpoints
below with the right proxy URL and JSON shaping. The curl forms are for
scripts and for anything the CLI does not expose (starting a training job).

## Service

- **Base URL**: `http://localhost:11434/train/*` (proxy routes; env: `TRAIN_PROXY_URL`)
- **Output dir**: `~/docker-volumes/training-data/output/`
- **Training data root**: `~/docker-volumes/training-data/` (datasets/, configs/, output/, raw/)
- **GPU swap**: triggered automatically; switches to train mode for the
  duration. First call takes 30-60s.

## Endpoints

### Training

| Method | Path | Purpose | CLI |
|---|---|---|---|
| POST | `/train/train` | Start a training job | - |
| GET  | `/train/status` | Current job state, step count, ETA | `llmc train status` |
| GET  | `/train/logs?lines=N` | Tail recent log output (default 50) | `llmc train logs` |
| POST | `/train/cancel` | Cancel current job | `llmc train cancel` |
| GET  | `/train/jobs` | List output LoRAs | `llmc train list` |
| POST | `/train/deploy` | Copy a trained LoRA to ComfyUI's loras/ | `llmc train deploy <lora>` |
| GET  | `/train/datasets` | List available datasets | - |

### Captioning

| Method | Path | Purpose | CLI |
|---|---|---|---|
| POST | `/train/caption` | Start async captioning job on a dataset | `llmc dataset caption` |
| GET  | `/train/caption/status` | Job state, captions_written / images_total | `llmc dataset caption-status` |
| GET  | `/train/caption/logs?lines=N` | Tail recent caption log | `llmc dataset caption-logs` |
| POST | `/train/caption/cancel` | Cancel caption job | `llmc dataset caption-cancel` |

Dataset prep before captioning: `llmc dataset audit <name> [--expected tags]`
(WD14 caption sanity), `llmc dataset filter <src> <dst>` (copy minus rejected
stems), `llmc dataset focus` (pick the N best images for a focus run).

## Start a training job

```bash
curl -sX POST http://localhost:11434/train/train \
  -H 'content-type: application/json' \
  -d '{
    "dataset_config": "/data/configs/my-dataset.toml",
    "output_name": "my-lora",
    "base_model": "Illustrious-XL-v0.1.safetensors",
    "model_type": "sdxl",
    "epochs": 4,
    "network_dim": 32,
    "network_alpha": 32,
    "learning_rate": "1e-4",
    "save_every_n_epochs": 1,
    "clip_skip": 2,
    "gradient_checkpointing": true
  }'
```

`model_type` auto-detects from `base_model` filename (flux*.safetensors -> flux),
so usually you can omit it.

### Flux-specific defaults

```json
{
  "model_type": "flux",
  "base_model": "flux1-dev.safetensors",
  "network_dim": 16,
  "network_alpha": 16,
  "fp8_base": true,
  "apply_t5_attn_mask": true,
  "epochs": 8
}
```

## Poll status

```bash
llmc train status            # or:
curl -s http://localhost:11434/train/status | jq
# { state: training|completed|failed|idle, step: 1200, loss: 0.08, epoch: 2, elapsed: "23m", eta: "1h12m" }
curl -s 'http://localhost:11434/train/logs?lines=100'
```

## Start captioning a dataset

```bash
curl -sX POST http://localhost:11434/train/caption \
  -H 'content-type: application/json' \
  -d '{
    "dataset": "my-dataset",
    "engine": "blip2",
    "prompt": "a photograph of",
    "trigger_word": "mysubject",
    "overwrite": false
  }'
```

Engines:
- **blip2** - natural language captions, recommended for Flux (aligns with
  T5-XXL). Roughly 1 image/sec on 32GB VRAM.
- **wd14** - Danbooru tags, recommended for SDXL/anime models.
- **florence** - still wired (`train/caption_florence.py`) but the server
  marks it broken on transformers >= 4.54 (`train/server.py`,
  `mcp/train-server.py`) - use BLIP-2.

## Deploy a trained LoRA to ComfyUI

```bash
llmc train deploy my-lora    # .safetensors suffix optional; or:
curl -sX POST http://localhost:11434/train/deploy \
  -H 'content-type: application/json' -d '{"name": "my-lora"}'
```

Copies the file from `output/` to `~/docker-volumes/comfyui/models/loras/`.
`llmc train list` / `GET /train/jobs` lists what is available to deploy.

## Dataset structure

Each dataset lives under `~/docker-volumes/training-data/datasets/<name>/`
with image/caption pairs (image.png + image.txt).

Dataset TOML configs at `~/docker-volumes/training-data/configs/<name>.toml`:

```toml
[general]
shuffle_caption = false  # if true, set keep_tokens=1 in train job
caption_extension = ".txt"
keep_tokens = 0

[[datasets]]
resolution = 1024
batch_size = 2
enable_bucket = true

  [[datasets.subsets]]
  image_dir = "/data/datasets/my-dataset"
  num_repeats = 1
```

## Base-model settings that matter

- **`clip_skip`**: 2 for Illustrious / NoobAI / Pony anime bases; 1 for
  JuggernautXL and photo-realistic SDXL bases. Wrong clip_skip trains fine
  and samples wrong.
- **`v_parameterization=true`** for v-prediction bases (NoobAI-v-pred).
- `save_every_n_epochs` gives mid-run checkpoints for ablation; a face LoRA at
  dim 32, lr 1e-4, batch 2 @ 1024 over ~500 captioned images is the shape
  that has worked. Flux at batch 4 is several hours per run on the 5090 -
  budget accordingly.

## Related

- Service repo: `~/infra/ai/llm-compose` (trainer in `train/`, image `lora-train.Dockerfile`)
- MCP wrapper: `~/infra/ai/llm-compose/mcp/train-server.py`
- Training data: `~/docker-volumes/training-data/`
