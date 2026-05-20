---
name: lora-train
description: Train SDXL or Flux LoRAs via the llm-compose lora-train service (HTTP API on the proxy at localhost:11434/train/*). Use for fine-tuning checkpoints with kohya sd-scripts. Defaults differ by model type — SDXL uses dim=32 alpha=dim (Illustrious base, clip_skip=2); Flux uses dim=16 alpha=16 (flux1-dev base, fp8_base+t5_attn_mask on). 4 epochs default — bump to 8-12 for Flux face LoRAs. Also handles BLIP-2/WD14 captioning and deploying trained LoRAs to ComfyUI.
---

# LoRA Training

kohya sd-scripts wrapped in an HTTP API. Routes through the llm-compose proxy
which also handles GPU mode swap (stops llama-server / ComfyUI, starts trainer).

## Service

- **Base URL**: `http://localhost:11434/train/*` (proxy routes; env: `TRAIN_PROXY_URL`)
- **Output dir**: `~/docker-volumes/training-data/output/`
- **Training data root**: `~/docker-volumes/training-data/` (datasets/, configs/, output/, raw/)
- **GPU swap**: triggered automatically; switches to train mode for the duration.

## Endpoints

### Training

| Method | Path | Purpose |
|---|---|---|
| POST | `/train/train` | Start a training job |
| GET  | `/train/status` | Current job state, step count, ETA |
| GET  | `/train/logs?lines=N` | Tail recent log output (default 50) |
| POST | `/train/cancel` | Cancel current job |
| GET  | `/train/jobs` | List output LoRAs |
| POST | `/train/deploy` | Copy a trained LoRA to ComfyUI's loras/ |
| GET  | `/train/datasets` | List available datasets |

### Captioning

| Method | Path | Purpose |
|---|---|---|
| POST | `/train/caption` | Start async captioning job on a dataset |
| GET  | `/train/caption/status` | Job state, captions_written / images_total |
| GET  | `/train/caption/logs?lines=N` | Tail recent caption log |
| POST | `/train/caption/cancel` | Cancel caption job |

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

`model_type` auto-detects from `base_model` filename (flux*.safetensors → flux),
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
curl -s http://localhost:11434/train/status | jq
# { state: training|completed|failed|idle, step: 1200, loss: 0.08, epoch: 2, elapsed: "23m", eta: "1h12m" }
```

## Get last N log lines

```bash
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
- **blip2** — natural language captions, recommended for Flux (aligns with T5-XXL). Produces ~1 image/sec on 32GB VRAM.
- **wd14** — Danbooru tags, recommended for SDXL/anime models.

Florence-2 was previously supported but is broken on transformers >= 4.54 — use BLIP-2.

## Deploy trained LoRA to ComfyUI

```bash
curl -sX POST http://localhost:11434/train/deploy \
  -H 'content-type: application/json' \
  -d '{"name": "my-lora"}'   # with or without .safetensors extension
```

Copies the file from `output/` to `~/docker-volumes/comfyui/models/loras/`.

## List trained LoRAs

```bash
curl -s http://localhost:11434/train/jobs | jq '.files[] | .name'
```

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

## Common reference (from past runs)

- **sophia-clean-d32-ep6** — production face LoRA, dim=32, 526 BLIP-2 captioned images, 2680 steps, AdamW8bit, lr=1e-4, batch 2 @ 1024
- Flux face: ~8s/step on 5090, batch_size=4 → ~5-6h for full training
- Anti-masculine NSFW negatives: 'masculine, male, man, boy, broad shoulders, muscular abs, square jaw, beard, stubble'

## Tips

- Training service goes through GPU mode swap on start — first call takes 30-60s
- For SDXL: `clip_skip=2` for Illustrious/NoobAI/Pony anime bases, `clip_skip=1` for JuggernautXL and photo-realistic
- Set `v_parameterization=true` for NoobAI-v-pred
- `save_every_n_epochs` lets you checkpoint mid-training for ablation

## Related

- Service repo: `~/llm-compose`
- MCP wrapper: `~/llm-compose/mcp/train-server.py`
- Training data: `~/docker-volumes/training-data/`
