---
name: whisper
description: Transcribe audio/video via the whisper-transcribe HTTP API on localhost:7860. Use for transcribing YouTube videos/playlists, local audio files, or anything WhisperX can process. Returns plain transcript text, supports translation, diarization, language hints, and hotwords. Handles long-running jobs via job_id polling. Triggers GPU mode swap on the llm-compose stack (stops llama-server, starts whisper).
---

# Whisper Transcription

WhisperX-backed transcription service. The MCP wrapper at
`~/llm-compose/mcp/whisper-server.py` is the canonical Python client. This
skill documents the same HTTP API for direct invocation when running outside
opencode (e.g. Pi, scripts, ad-hoc curl).

## Service

- **Base URL**: `http://localhost:7860` (env: `WHISPER_URL`)
- **Runs on**: llm-compose stack, `whisper` service (RTX 5090 / 31 GB VRAM)
- **GPU swap**: starting transcription stops llama-server. Proxy auto-swaps.
- **Model default**: turbo (override with `model` param)
- **Extras**: VLM frame description (`/api/describe`) + OCR (`/api/image`) via
  the `vision` model reported in `/api/status`.

### Server-side files (the `/media` mount)

The whisper container mounts the host's video directory at `/media`
(`/mnt/d/Videos` on the host → `/media` inside the container). **Do NOT
`docker inspect` the mounts or `ls` the host dir to find a file** — the
service exposes the listing directly:

```bash
curl -s http://localhost:7860/api/media | jq -r '.files[].path'   # newest first
curl -s 'http://localhost:7860/api/media?refresh=1'               # bust TTL cache
```

Returns `{"files":[{"name":"2026-06-19 14-00-39.mkv","path":"/media/..."}]}`,
sorted newest-first. Pass the returned `path` straight to `/api/jobs` as
`file_path` — it's already a container-side path, no upload needed. The
Gradio UI's "Server file" picker is backed by this same endpoint.

## Endpoints

### Status check

```bash
curl -s http://localhost:7860/api/status
```

Returns `{ "status": "ready", "busy": false, "gpu": "...", "device":
"cuda", "compute_type": "float16", "diarization_available": true,
"default_batch_size": 64, "vision": {...} }`. Service is usable when
`status == "ready"`; `busy` flags an in-flight job.

### YouTube download (synchronous, fast)

```bash
curl -sX POST http://localhost:7860/api/yt-download \
  -H 'content-type: application/json' \
  -d '{"url": "https://youtube.com/watch?v=..."}'
```

Returns `{ "path": "/tmp/<download>.<ext>" }` on the whisper server's
filesystem (NOT your local FS — pass the returned path to `/api/jobs`).

### Transcribe a file (async via queue — canonical)

`POST /api/jobs` is the canonical path: enqueues on the Valkey-backed FIFO
so all consumers (bot, MCP, UI, curl) serialise. Returns `202 + job_id`.

```bash
JOB=$(curl -sX POST http://localhost:7860/api/jobs \
  -H 'content-type: application/json' \
  -d '{
    "file_path": "/media/2026-06-19 14-00-39.mkv",
    "model": "turbo",
    "language": "Auto-detect",
    "translate": "auto",
    "diarize": false
  }' | jq -r .job_id)

# Poll
curl -s "http://localhost:7860/api/jobs/$JOB"
```

`POST /api/transcribe` takes the **same body** but is **deprecated**; its
default now also returns `202 + job_id`. Pass `"wait": true` for the legacy
sync shape (`{status, transcript, subtitle_file}` inline).

### Upload a local file (your FS → server FS)

```bash
curl -sX POST http://localhost:7860/api/upload -F 'file=@./audio.mp3'
# → {"file_path":"/tmp/upload-XXXX/audio.mp3", ...}  → feed to /api/jobs
```

### Job polling

```bash
curl -s http://localhost:7860/api/jobs/<job_id>
```

States: `queued | running | done | failed | cancelled`. Shape varies by
status — when `done`, the transcript is nested: `.result.transcript`
(and `.result.subtitle_file` if a subtitle format was requested).
`DELETE /api/jobs/<id>` cancels; `GET /api/queue` shows queue depth.

## Parameters reference

| Field | Type | Default | Notes |
|---|---|---|---|
| `file_path` | string | — | Path on whisper server (`/api/yt-download`, `/api/upload`, or a `/media/...` path from `/api/media`) |
| `url` | string | — | YouTube URL (only on `/api/yt-download` and yt_transcribe variants) |
| `model` | enum | `turbo` | `tiny\|base\|small\|medium\|large\|turbo` |
| `language` | string | `Auto-detect` | ISO code (`en`, `fr`) or `Auto-detect` |
| `format` | enum | `txt` | `txt\|srt\|vtt\|json` — subtitle/output format (UI default `srt`) |
| `translate` | bool\|`"auto"` | `"auto"` | `"auto"` = LID pre-pass, translate non-English to English. `true` forces translate. `false` keeps source language. |
| `diarize` | bool | `false` | Speaker labels (SPEAKER_00, SPEAKER_01, …) |
| `min_speakers` | int | `0` | Diarization floor (0 = auto) |
| `max_speakers` | int | `0` | Diarization ceiling (0 = auto) |
| `batch_size` | int | VRAM-derived | Override the auto batch (`default_batch_size` in `/api/status`) |
| `suppress_numerals` | bool | `false` | Spell out numbers instead of digits |
| `hotwords` | string | "" | Comma-separated proper-noun bias. Shares Whisper's 448-token prompt budget with `initial_prompt`. |
| `initial_prompt` | string | "" | Context hint. Cap at 600 chars; longer eats hotword budget. |
| `return_file` | bool | `true` | Set `false` to skip subtitle-file generation when only the transcript text is needed |
| `cleanup` | bool | `false` | Remove `file_path` + its parent yt-dlp tmp dir on completion |
| `wait` | bool | `false` | (`/api/transcribe` only) legacy sync mode — block and return result inline |

## Whisper prompt context

WhisperX's `initial_prompt` + `hotwords` share a **448-token budget**. Long
prompts crowd out hotwords. Empirical rule: cap `initial_prompt` at ~600 chars
and skip `hotwords` when the prompt is non-trivial.

## Common workflows

### YouTube → transcript

```bash
URL='https://youtube.com/watch?v=...'
# Single shot
DL=$(curl -sX POST http://localhost:7860/api/yt-download \
  -H 'content-type: application/json' \
  -d "{\"url\":\"$URL\"}" | jq -r .path)

JOB=$(curl -sX POST http://localhost:7860/api/jobs \
  -H 'content-type: application/json' \
  -d "{\"file_path\":\"$DL\",\"translate\":\"auto\"}" | jq -r .job_id)

# Poll until done
while :; do
  R=$(curl -s "http://localhost:7860/api/jobs/$JOB")
  S=$(echo "$R" | jq -r .status)
  echo "$S"
  [[ "$S" == "done" || "$S" == "failed" || "$S" == "cancelled" ]] && break
  sleep 5
done
echo "$R" | jq -r .result.transcript
```

### Transcribe the newest server-side recording

```bash
FP=$(curl -s http://localhost:7860/api/media | jq -r '.files[0].path')
JOB=$(curl -sX POST http://localhost:7860/api/jobs \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg f "$FP" '{file_path:$f, format:"srt", diarize:true}')" | jq -r .job_id)
```

### Translate Japanese podcast to English

```bash
JOB=$(curl -sX POST http://localhost:7860/api/jobs \
  -H 'content-type: application/json' \
  -d '{"file_path":"/tmp/podcast.mp3","language":"ja","translate":true}' | jq -r .job_id)
```

## Troubleshooting

- **GPU error**: another service may be using GPU. Wait 30s; proxy auto-swaps.
- **Empty transcript**: audio too quiet or language mismatch; try explicit `language` param.
- **Long delay on YouTube**: yt-dlp deno path may need fresh remote-components. Check whisper service logs.
- **Path not found**: `file_path` must exist on whisper server's filesystem, not yours. Use `/api/yt-download` to materialise YouTube URLs first.

## Related docs

- Service repo: `~/whisper-transcribe`
- MCP wrapper (Python): `~/llm-compose/mcp/whisper-server.py`
- Compose definitions: `~/llm-compose/compose.yaml` (whisper + bot services)
