---
name: whisper
description: "Use when transcribing audio or video via the local whisper-transcribe service - YouTube videos or playlists, local audio files, or OBS recordings on the /media mount - with translation, diarization, language hints, hotwords or voice prints, or when reviewing a recorded call with the video_* tools. Fires on 'transcribe', 'whisper', 'YouTube transcript', 'diarize this call', 'subtitles', 'video_extract'. NOT for LLM inference (llm-compose) or image generation (comfyui)."
---

# Whisper Transcription

WhisperX-backed transcription service. The MCP wrapper
(`~/infra/ai/llm-compose/mcp/whisper-server.py`, registered as `whisper` in
`~/.pi/agent/mcp-servers.json`) is the tool surface; this skill documents the
HTTP API for curl and scripts. The call-review tools (`video_extract`,
`video_doc`, voice prints) are in `video-review.md` - read it when the task is
reviewing a recorded call rather than getting a transcript.

## Service

- **Base URL**: `http://localhost:7860` (env: `WHISPER_URL`)
- **Runs on**: the `whisper-transcribe` compose stack on this dev box
  (`~/infra/ai/whisper-transcribe/compose.yaml`: whisper, whisper-live, bot,
  valkey, crawl4ai, flaresolverr), sharing the RTX 5090 with llm-compose.
- **GPU sharing**: a transcription job swaps llama-server out; a 503 "model
  lock active" means an unattended loop has pinned the LLM preset. The rule
  and the etiquette live in the llm-compose skill ("One GPU job at a time") -
  do not `llmc unlock` without asking.
- **Model default**: turbo (override with `model` param)
- **Extras**: VLM frame description (`/api/describe`) + OCR (`/api/image`) via
  the `vision` model reported in `/api/status`.

### Server-side files (the `/media` mount)

The whisper container mounts the host's video directory at `/media`
(`/mnt/d/Videos` on the host -> `/media` inside the container). **Do NOT
`docker inspect` the mounts or `ls` the host dir to find a file** - the
service exposes the listing directly:

```bash
curl -s http://localhost:7860/api/media | jq -r '.files[].path'   # newest first
curl -s 'http://localhost:7860/api/media?refresh=1'               # bust TTL cache
```

Returns `{"files":[{"name":"2026-06-19 14-00-39.mkv","path":"/media/..."}]}`,
sorted newest-first. Pass the returned `path` straight to `/api/jobs` as
`file_path` - it's already a container-side path, no upload needed. The
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

Returns `{ "filename": "/tmp/yt-dlp-XXXX/<id>.wav", "title": ...,
"duration": <seconds>, "was_live": false, "live_status": ... }` on the whisper
server's filesystem (NOT your local FS). The download path is under
**`.filename`** (NOT `.path`) - pass it to `/api/jobs` as `file_path`.

### Transcribe a file (async via queue - canonical)

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

### Upload a local file (your FS -> server FS)

```bash
curl -sX POST http://localhost:7860/api/upload -F 'file=@./audio.mp3'
# -> {"file_path":"/tmp/upload-XXXX/audio.mp3", ...}  -> feed to /api/jobs
```

### Job polling

```bash
curl -s http://localhost:7860/api/jobs/<job_id>
```

States: `queued | running | done | failed | cancelled`. Shape varies by
status - when `done`, the transcript is nested: `.result.transcript`
(and `.result.subtitle_file` if a subtitle format was requested).
`DELETE /api/jobs/<id>` cancels; `GET /api/queue` shows queue depth.

## Parameters reference

| Field | Type | Default | Notes |
|---|---|---|---|
| `file_path` | string | - | Path on whisper server (`/api/yt-download`, `/api/upload`, or a `/media/...` path from `/api/media`) |
| `url` | string | - | YouTube URL (only on `/api/yt-download` and yt_transcribe variants) |
| `model` | enum | `turbo` | `tiny\|base\|small\|medium\|large\|turbo` |
| `language` | string | `Auto-detect` | ISO code (`en`, `fr`) or `Auto-detect` |
| `format` | enum | `txt` | `txt\|srt\|vtt\|json` - subtitle/output format (UI default `srt`) |
| `translate` | bool\|`"auto"` | `"auto"` | `"auto"` = LID pre-pass, translate non-English to English. `true` forces translate. `false` keeps source language. |
| `diarize` | bool | `false` | Speaker labels (SPEAKER_00, SPEAKER_01, ...) |
| `min_speakers` | int | `0` | Diarization floor (0 = auto) |
| `max_speakers` | int | `0` | Diarization ceiling (0 = auto) |
| `batch_size` | int | VRAM-derived | Override the auto batch (`default_batch_size` in `/api/status`) |
| `suppress_numerals` | bool | `false` | Spell out numbers instead of digits |
| `hotwords` | string | "" | Comma-separated proper-noun bias. Shares Whisper's 448-token prompt budget with `initial_prompt`. |
| `initial_prompt` | string | "" | Context hint. Cap at 600 chars; longer eats hotword budget. |
| `return_file` | bool | `true` | Set `false` to skip subtitle-file generation when only the transcript text is needed |
| `cleanup` | bool | `false` | Remove `file_path` + its parent yt-dlp tmp dir on completion |
| `wait` | bool | `false` | (`/api/transcribe` only) legacy sync mode - block and return result inline |

## Whisper prompt context

WhisperX's `initial_prompt` + `hotwords` share a **448-token budget**. Long
prompts crowd out hotwords. Empirical rule: cap `initial_prompt` at ~600 chars
and skip `hotwords` when the prompt is non-trivial.

### Auto-hotwords (vocabulary + voice-print names)

Every job's hotwords are **automatically merged** server-side
(`_build_hotwords`) from three sources, in priority order:

1. the request's own `hotwords` field (wins position),
2. enrolled voice-print names (`/data/voiceprints.json`),
3. the persistent vocabulary file `/data/vocabulary.txt` (one term per line,
   `#` comments) - company / product / account names whisper would otherwise
   mangle ("Supabase" -> "superbase", "Erfi" -> "Erfie").

Case-insensitive dedupe; capped at `HOTWORDS_MAX_TERMS` (default 60) to
protect the prompt budget. Env: `AUTO_HOTWORDS=0` disables the automatic
sources; `VOCABULARY_FILE` relocates the file.

Manage the vocabulary over HTTP (also editable in the SPA Voices tab):

```bash
curl -s :7860/api/vocabulary                              # terms + state
curl -sX PUT :7860/api/vocabulary -H 'content-type: application/json' \
  -d '{"terms":["Supabase","PostgREST","Acme Corp"]}'    # replace whole list
```

## Diarization quality

- **Gender prefixes are OFF by default**: labels are plain `SPEAKER_00` (not
  `M-SPEAKER_00`). The old F0-pitch prefix mislabeled often enough over
  compressed mics (a male voice landed as F-SPEAKER) that it misled readers;
  voice prints are the identity mechanism. Opt back in with
  `SPEAKER_GENDER_LABELS=1`.
- **Micro-turn cleanup**: a < 1s diarized turn sandwiched between two turns of
  the SAME speaker (A -> B -> A flicker) is reassigned to the flanking speaker
  before word-speaker assignment. Fixes single sentences split across two
  labels and keeps voice-print enrollment clean. Env: `MICRO_TURN_CLEANUP=0`
  to disable, `MICRO_TURN_MAX_SEC` to tune the threshold.
- **Duplicate recordings**: `GET /api/media` annotates files whose
  name-embedded start times are within `MEDIA_DUPE_WINDOW_SEC` (default 120s)
  with `possible_duplicate_of` - OBS false starts show up flagged in the SPA
  picker.


## Common workflows

### YouTube -> transcript

```bash
URL='https://youtube.com/watch?v=...'
# Single shot
DL=$(curl -sX POST http://localhost:7860/api/yt-download \
  -H 'content-type: application/json' \
  -d "{\"url\":\"$URL\"}" | jq -r .filename)   # .filename, NOT .path

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
- **Resident VRAM**: whisper-live keeps large-v3 loaded on the GPU (~5.6 GiB)
  even when idle - batch whisper idle-unloads after ~300s but live does not.
  GPU-exclusive work (quant benches, >26 GB model loads) must `docker stop
  whisper-transcribe-whisper-1 whisper-transcribe-whisper-live-1` first.
  NEVER `docker rm` them - they are compose-managed and an rm'd container
  cannot be `docker start`ed; recover with `cd ~/infra/ai/whisper-transcribe
  && make up`.
- **Empty transcript**: audio too quiet or language mismatch; try explicit `language` param.
- **Long delay on YouTube**: yt-dlp deno path may need fresh remote-components. Check whisper service logs.
- **YouTube 403 "unable to download video data"**: IP-throttle - YouTube rate-limits the host IP after a burst of downloads (a couple of videos, then every download 403s for ~30 min). The server auto-retries each download through the `YT_DLP_PLAYER_CLIENTS` chain (default `default,android,ios,tv,mweb`; compose/.env overridable) - the android client usually still serves while the default is throttled. Check the whisper logs for `succeeded with fallback player_client=...` to confirm which client is working, and reorder the chain to put it first. If EVERY client 403s, the IP is fully hot: wait ~30-60 min, route yt-dlp through a different egress with `YT_DLP_EXTRA_ARGS` (raw arg passthrough, e.g. `--proxy socks5://host:1055`; also the PO-token path - pin `YT_DLP_PLAYER_CLIENTS` to the matching client), or use the escape hatch below.
- **Escape hatch when yt-download is fully blocked**: download on any machine whose IP is clean (`yt-dlp -x --audio-format wav --extractor-args "youtube:player_client=android" <url>`), then push the file to the server with `POST /api/upload -F 'file=@./audio.wav'` and transcribe the returned `/tmp/upload-*` path via `/api/jobs` (or the whisper_transcribe tool's `file_path`). Note pi's yt_transcribe/yt_download tools always route through the server's own yt-dlp, so the hatch is inherently a bash curl flow, not a tool call.
- **Path not found**: `file_path` must exist on whisper server's filesystem, not yours. Use `/api/yt-download` to materialise YouTube URLs first.

## Related docs

- `video-review.md` - the video_* tools, call-review workflow, voice prints. Read when reviewing a call.
- Service repo + compose stack: `~/infra/ai/whisper-transcribe` (its AGENTS.md has the Makefile targets; `make` is canonical)
- MCP wrapper (Python): `~/infra/ai/llm-compose/mcp/whisper-server.py`
- Extension source: `~/dotfiles/.pi/agent/extensions/video-review.ts`
