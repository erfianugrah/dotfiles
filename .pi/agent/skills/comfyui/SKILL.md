---
name: comfyui
description: Use when generating images with Stable Diffusion (SDXL/Illustrious/Flux checkpoints) via the local ComfyUI service, inspecting the generation queue, or retrieving past generations. Fires on 'generate an image', 'comfyui', an SDXL/Flux prompt, LoRA weights in a prompt, image history. Triggers a GPU mode swap - llama-server pauses during generation.
---

# ComfyUI Image Generation

ComfyUI workflows routed through the llm-compose proxy. The proxy handles GPU
swapping between llama-server and ComfyUI automatically.

## Service

- **Base URL**: `http://localhost:11434` (llm-compose proxy; env: `COMFYUI_PROXY_URL`)
- **Routes**: `/comfyui/*` → ComfyUI HTTP API
- **Output dir**: `~/docker-volumes/comfyui/output/` (env: `COMFYUI_OUTPUT_DIR`)
- **GPU swap**: triggered automatically; expect 20-60s startup if llama-server was active.

## Mode swap (manual)

```bash
# Check current GPU mode
curl -s http://localhost:11434/mode | jq

# Force ComfyUI mode (or swap will happen on first /comfyui call)
curl -sX POST http://localhost:11434/mode -d '{"mode":"comfyui"}'
```

## Generate via the SDXL default workflow

```bash
WORKFLOW=$(cat <<'JSON'
{
  "3": {"class_type":"KSampler","inputs":{"seed":1234,"steps":30,"cfg":5,"sampler_name":"euler","scheduler":"normal","denoise":1,"model":["4",0],"positive":["6",0],"negative":["7",0],"latent_image":["5",0]}},
  "4": {"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"Illustrious-XL-v0.1.safetensors"}},
  "5": {"class_type":"EmptyLatentImage","inputs":{"width":832,"height":1216,"batch_size":1}},
  "6": {"class_type":"CLIPTextEncode","inputs":{"text":"masterpiece, best quality, your prompt here","clip":["4",1]}},
  "7": {"class_type":"CLIPTextEncode","inputs":{"text":"lowres, blurry, jpeg artifacts","clip":["4",1]}},
  "8": {"class_type":"VAEDecode","inputs":{"samples":["3",0],"vae":["4",2]}},
  "9": {"class_type":"SaveImage","inputs":{"filename_prefix":"pi","images":["8",0]}}
}
JSON
)

PROMPT_ID=$(curl -sX POST http://localhost:11434/comfyui/prompt \
  -H 'content-type: application/json' \
  -d "{\"prompt\": $WORKFLOW}" | jq -r .prompt_id)
```

## Poll generation status

```bash
# Queue overview
curl -s http://localhost:11434/comfyui/queue | jq

# Single-job history (output paths + metadata)
curl -s "http://localhost:11434/comfyui/history/$PROMPT_ID" | jq

# Find the output file
curl -s "http://localhost:11434/comfyui/history/$PROMPT_ID" | \
  jq -r '.[].outputs."9".images[].filename'
```

Output is at `~/docker-volumes/comfyui/output/<filename>.png`.

## Common workflows

### Single image with prompt override

```bash
# Easiest: use the pi comfyui_generate tool with prompt / negative_prompt / seed
# overrides (defaults come from comfyui.local.env). Or send full workflow JSON
# as above.
```

### List recent generations

```bash
curl -s http://localhost:11434/comfyui/history | jq -r '
  to_entries | sort_by(.value.prompt[0]) | reverse | .[:10] |
  .[] | "\(.key)  prompt: \(.value.prompt[2]."3".inputs.seed)"'
```

## Default parameters

| Param | Default | Notes |
|---|---|---|
| `checkpoint` | `sd_xl_base_1.0.safetensors` (overridable) | Override via env or workflow |
| `width × height` | 832 × 1216 (portrait) | Good SDXL: 1024×1024, 1216×832, 768×1344 |
| `steps` | 30 | More = higher quality but slower |
| `cfg` | 5 | Classifier-free guidance scale |
| `sampler` | Euler | Sane default for SDXL |
| `scheduler` | normal | |

## Tips

- Prefix prompts with quality tags: `masterpiece, best quality`
- Negative defaults are loaded from `comfyui.local.env`
- The proxy returns immediately after submitting prompt; image generation runs async. Use `comfyui/history/{prompt_id}` to fetch when ready.
- **WARNING**: Triggers GPU mode swap — llama-server stops for 20-60s.
- **Model lock**: if a swap/comfyui/train call 503s with "model lock active", an unattended loop has pinned the LLM preset (`llmc lock`). Do NOT `llmc unlock` without asking - check `curl -s localhost:11434/mode` (lock_owners shows who holds it, lock_queue shows who is waiting) and wait or coordinate.
- Do NOT call Read on the returned PNG path — viewing inlines base64 image data that exceeds the model's input limit. Generation creates the image for the human user; only Read it if explicitly asked to analyse.

## Related

- Service repo: `~/infra/ai/llm-compose` (ComfyUI service: see `comfyui.Dockerfile`)
- MCP wrapper: `~/infra/ai/llm-compose/mcp/comfyui-server.py`
- Models: `~/docker-volumes/comfyui/models/`
