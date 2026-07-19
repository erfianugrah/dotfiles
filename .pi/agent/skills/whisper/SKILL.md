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

Returns `{ "filename": "/tmp/yt-dlp-XXXX/<id>.wav", "title": ...,
"duration": <seconds>, "was_live": false, "live_status": ... }` on the whisper
server's filesystem (NOT your local FS). The download path is under
**`.filename`** (NOT `.path`) - pass it to `/api/jobs` as `file_path`.

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
- **Empty transcript**: audio too quiet or language mismatch; try explicit `language` param.
- **Long delay on YouTube**: yt-dlp deno path may need fresh remote-components. Check whisper service logs.
- **Path not found**: `file_path` must exist on whisper server's filesystem, not yours. Use `/api/yt-download` to materialise YouTube URLs first.

## Video-to-docs / conversation review (video-review extension)

The pi extension `video-review.ts` orchestrates the primitives above into a
video-to-docs / call-review pipeline. Three tools:

- **`video_extract`** - transcribe + diarize (word-level speaker timing),
  optionally VLM-describe frames. Runs the slow GPU work ONCE, caches the
  full bundle to `/tmp/video-review/<key>.json`, and returns only a compact
  summary + bundle path (the huge word array never enters model context).
- **`video_overlap`** - pure-TS conversation analysis over the cached bundle:
  objective speech-overlap events, speaking-time %, turn-taking latency
  (median entry gap per speaker), who-came-in-over-whom, pair clustering.
- **`video_doc`** - markdown-ready evidence bundle (metadata + speaking-time
  + diarized transcript + visual timeline + overlap summary) for the agent to
  synthesise the final notes/review.

Depends on the `GET /api/artifact?path=...` endpoint (serves the word-level
JSON the job writes server-side; path-guarded to the temp dir). `video_extract`
passes `refresh:true` because the transcript cache stores text only and nulls
`subtitle_file` on a hit.

### Automatic speaker names (voice prints)

Speaker identification is **server-side** so names land in every output (SPA,
bot, curl, extension) - not just via pi. A voice print is a 256-d WeSpeaker
embedding (from the diarization pipeline) tagged with a person's name, stored
on the persistent `/data` volume (`/data/voiceprints.json`).

- Diarized `format:json` jobs now emit `speaker_embeddings` ({label: 256-vec})
  and, when prints match, `speaker_names` ({label: name}) - and the transcript
  labels are rewritten to the names in ALL formats (txt/srt/vtt/json).
- Matching is greedy one-to-one cosine (threshold `VOICEPRINT_THRESHOLD`,
  default 0.5; self-cos ~1.0 vs cross-speaker ~0.13, so it is well separated).
- Toggle with `IDENTIFY_SPEAKERS=0`.

Endpoints:

```bash
# enroll from a clean clip (server embeds it)
curl -sX POST :7860/api/voiceprints -d '{"name":"Erfi","file_path":"/media/clip.mkv","start":0,"end":20}'
# or enroll a vector directly (e.g. pulled from a prior job's speaker_embeddings)
curl -sX POST :7860/api/voiceprints -d '{"name":"Erfi","embedding":[...]}'
curl -s   :7860/api/voiceprints            # list names + counts
curl -sX DELETE :7860/api/voiceprints/Erfi # remove
```

Enrolling the same name twice appends a second reference vector (improves
matching). From pi, the `video_enroll` tool wraps these (enroll from a cached
bundle's speaker, or from a clip); `video_name` does client-side manual/LLM
relabel of a cached bundle without re-running the server.

**Host-from-track (future):** with multi-track OBS recordings, transcribing
track 2 (mic) separately would name the host with zero ML. Not yet wired -
enrolling your own voice print covers the host in the meantime, on single- and
multi-track files alike.

**Limitation - single-stream diarization cannot see dense simultaneous
speech.** WhisperX transcribes one audio stream and assigns each word to
exactly one speaker, so genuinely overlapping talk gets serialized rather
than represented as two colliding word spans. `video_overlap` therefore
detects turn-boundary collisions and reports the median-entry-gap signal
reliably, but under-counts true talk-over. For an acoustically exact overlap
measurement, record with **OBS multi-track** (mic on track 2, desktop audio on
track 3, mkv container), then compare the isolated tracks with VAD/RMS - no
diarization needed. New OBS recordings should enable this.

## Related docs

- Extension: `~/dotfiles/.pi/agent/extensions/video-review.ts` (unit tests in `~/dotfiles/.pi/agent/tests/extensions.test.ts`)
- Service repo: `~/whisper-transcribe`
- MCP wrapper (Python): `~/llm-compose/mcp/whisper-server.py`
- Compose definitions: `~/llm-compose/compose.yaml` (whisper + bot services)
