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
- **Runs on**: llm-compose stack, `whisper` service
- **GPU swap**: starting transcription stops llama-server. Proxy auto-swaps.
- **Model default**: turbo (override with `model` param)

## Endpoints

### Status check

```bash
curl -s http://localhost:7860/api/status
```

Returns `{ "ready": true, "gpu_info": {...} }` when ready.

### YouTube download (synchronous, fast)

```bash
curl -sX POST http://localhost:7860/api/yt-download \
  -H 'content-type: application/json' \
  -d '{"url": "https://youtube.com/watch?v=..."}'
```

Returns `{ "path": "/tmp/<download>.<ext>" }` on the whisper server's
filesystem (NOT your local FS — pass the returned path to `/api/transcribe`).

### Transcribe a file (async via job)

```bash
JOB=$(curl -sX POST http://localhost:7860/api/transcribe \
  -H 'content-type: application/json' \
  -d '{
    "file_path": "/tmp/audio.mp3",
    "model": "turbo",
    "language": "Auto-detect",
    "translate": "auto",
    "diarize": false,
    "hotwords": "",
    "initial_prompt": ""
  }' | jq -r .job_id)

# Poll
curl -s "http://localhost:7860/api/jobs/$JOB"
```

Response when complete: `{ "status": "done", "transcript": "..." }`.

### Job polling

```bash
curl -s http://localhost:7860/api/jobs/<job_id>
```

States: `queued | running | done | error`. `transcript` field set when `done`.

## Parameters reference

| Field | Type | Default | Notes |
|---|---|---|---|
| `file_path` | string | — | Path on whisper server (e.g. result of `/api/yt-download`) |
| `url` | string | — | YouTube URL (only on `/api/yt-download` and yt_transcribe variants) |
| `model` | enum | `turbo` | `tiny\|base\|small\|medium\|large\|turbo` |
| `language` | string | `Auto-detect` | ISO code (`en`, `fr`) or `Auto-detect` |
| `translate` | bool\|`"auto"` | `"auto"` | `"auto"` = LID pre-pass, translate non-English to English. `true` forces translate. `false` keeps source language. |
| `diarize` | bool | `false` | Speaker labels (SPEAKER_00, SPEAKER_01, …) |
| `hotwords` | string | "" | Comma-separated proper-noun bias. Shares Whisper's 448-token prompt budget with `initial_prompt`. |
| `initial_prompt` | string | "" | Context hint. Cap at 600 chars; longer eats hotword budget. |

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

JOB=$(curl -sX POST http://localhost:7860/api/transcribe \
  -H 'content-type: application/json' \
  -d "{\"file_path\":\"$DL\",\"translate\":\"auto\"}" | jq -r .job_id)

# Poll until done
while :; do
  R=$(curl -s "http://localhost:7860/api/jobs/$JOB")
  S=$(echo "$R" | jq -r .status)
  echo "$S"
  [[ "$S" == "done" || "$S" == "error" ]] && break
  sleep 5
done
echo "$R" | jq -r .transcript
```

### Translate Japanese podcast to English

```bash
JOB=$(curl -sX POST http://localhost:7860/api/transcribe \
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
