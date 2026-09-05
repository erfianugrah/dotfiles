# whisper: video-to-docs / call review (the video-review extension)

Supporting reference for the `whisper` skill. Read when reviewing a recorded
call or turning a video into notes; the SKILL.md HTTP API is what these tools
orchestrate.

Contents: tools, call-review workflow, vocabulary discipline, voice prints,
limitations.

## Tools

The pi extension `~/dotfiles/.pi/agent/extensions/video-review.ts` (unit
tests in `~/dotfiles/.pi/agent/tests/extensions.test.ts`) orchestrates the
service primitives into a video-to-docs / call-review pipeline:

- **`video_extract`** - transcribe + diarize (word-level speaker timing),
  optionally VLM-describe frames. Runs the slow GPU work ONCE, caches the
  full bundle to `~/.local/share/video-review/<key>.json` (persistent; an
  `index.json` beside the bundles enables cross-bundle lookups), and returns
  only a compact summary + bundle path (the huge word array never enters
  model context).
- **`video_overlap`** - pure-TS conversation analysis over the cached bundle:
  objective speech-overlap events, speaking-time %, turn-taking latency
  (median entry gap per speaker), who-came-in-over-whom, pair clustering.
- **`video_metrics`** - speaking-style metrics: per-speaker wpm, words/turn,
  filler rate, turn-gap p25/median/p75 (p25 exposes the fast tail a median
  hides), per-pair gap matrix, and question-flow classification
  (self-answered vs assent vs elaboration after each question).
- **`video_doc`** - markdown-ready evidence bundle (metadata + speaking-time
  + diarized transcript + visual timeline + overlap summary). Transcript can
  be filtered with `speaker=`, `start=`, `end=` to keep context small. Pass
  **`output_path`** to write the markdown straight to disk and get back only
  stats (path, bytes, section sizes) - the default for long calls so a
  900+-segment transcript never enters model context.
- **`video_enroll` / `video_name`** - voice-print management + client-side
  relabel. `video_name` with `enroll:true` relabels AND enrolls in one step.
  Bundles keep embeddings keyed by the ORIGINAL diarized label (stable ID);
  `video_enroll` accepts either the label or the current display name.

Depends on the `GET /api/artifact?path=...` endpoint (serves the word-level
JSON the job writes server-side; path-guarded to the temp dir). `video_extract`
passes `refresh:true` because the transcript cache stores text only and nulls
`subtitle_file` on a hit.

## Call-review workflow

1. **`video_extract`** on the recording. Read the summary carefully - it
   reports three advisories beyond the basics:
   - *active speech vs wall time* - a call that is 30%+ silence is dead air;
     note it, don't analyse it as talk.
   - *owner-presence warning* - if the enrolled owner (`VIDEO_REVIEW_OWNER`,
     default "Erfi") speaks <60s in a >10min recording, the mic was probably
     not routed into the recording. Flag it to the user the same day instead
     of discovering a dead recording a week later.
   - *format suggestion* - heuristic from speaker count / identification /
     dominance (`suggestFormat`): 2 named speakers -> "1:1", dominant speaker
     >=60% + guests -> "customer", 3+ mostly-named -> "review".
2. **Tag the format** via `video_metrics format=<suggestion>` (confirms the
   guess and persists it on the bundle). Untagged calls do not accumulate
   longitudinal baselines - the deltas-vs-prior-calls output only works when
   calls are tagged consistently.
3. **`video_doc` with `output_path`** for the transcript + evidence file;
   write the notes doc from that file plus `video_metrics` output. Never let
   a long transcript ride through model context.
4. **Name speakers** from the extract's name suggestions / transcript cues
   (`video_name`), enrol your recurring counterparts (`enroll:true`).

## Vocabulary discipline

`/api/vocabulary` (60-term cap): public product / project / company names
ONLY. No customer or account names, no colleague names (voice-print
enrollment covers people), no internal program names, no unreleased roadmap
terms. The file is readable over the API and its terms flow into every job's
prompt - treat it as publishable.

## Automatic speaker names (voice prints)

Speaker identification is **server-side** so names land in every output (SPA,
bot, curl, extension) - not just via pi. A voice print is a 256-d WeSpeaker
embedding (from the diarization pipeline) tagged with a person's name, stored
on the persistent `/data` volume (`/data/voiceprints.json`).

- Diarized `format:json` jobs emit `speaker_embeddings` ({label: 256-vec})
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

## Limitation - single-stream diarization cannot see dense simultaneous speech

WhisperX transcribes one audio stream and assigns each word to exactly one
speaker, so genuinely overlapping talk gets serialized rather than
represented as two colliding word spans. `video_overlap` therefore detects
turn-boundary collisions and reports the median-entry-gap signal reliably,
but under-counts true talk-over. For an acoustically exact overlap
measurement, record with **OBS multi-track** (mic on track 2, desktop audio on
track 3, mkv container), then compare the isolated tracks with VAD/RMS - no
diarization needed. New OBS recordings should enable this.
