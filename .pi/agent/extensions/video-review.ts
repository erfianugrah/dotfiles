/**
 * video-review - turn a recorded video (call, demo, walkthrough) into a
 * structured doc or an objective conversation review, on top of the local
 * whisper-transcribe stack (`:7860`).
 *
 * Six tools orchestrate the whisper primitives:
 *   video_extract  run the transcription+diarization pipeline once (slow),
 *                  cache the bundle, return a COMPACT summary + bundle path.
 *   video_overlap  objective conversation analysis (speech overlaps, speaking
 *                  time, turn-taking latency, who-over-whom).
 *   video_metrics  speaking-style metrics + DAMSL-lite question-flow.
 *   video_doc      markdown-ready evidence bundle for the agent to write the doc.
 *   video_enroll   manage server-side voice prints (auto-naming).
 *   video_name     relabel speakers in a cached bundle from a {label:name} map.
 *
 * Pure logic + the whisper HTTP orchestration + the on-disk bundle cache live
 * in ./lib/video-review-core.ts (shared with the Claude Code MCP toolkit);
 * this file is the thin pi adapter. It re-exports the pure symbols existing
 * importers (tests/extensions.test.ts) resolve here.
 * See also: ~/.pi/agent/TOOLKIT.md (workflows, canonical invocations)
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runVideoReview, type VideoReviewArgs } from "./lib/video-review-core.ts";

// Re-export the pure symbols the test suite imports from this path.
export {
  isExternalMedia,
  resolveMediaPath,
  suggestFormat,
  bundleCacheKey,
  mergeUtterances,
  computeOverlap,
  hhmmss,
  parseNameMap,
  applyNameMap,
  resolveEmbedding,
  countFillers,
  isAssent,
  analyzeQuestions,
  computeMetrics,
  type Segment,
  type Bundle,
  type Utterance,
} from "./lib/video-review-core.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(args: VideoReviewArgs, signal: AbortSignal | undefined, onUpdate: any) {
  const emit = (m: string) => onUpdate?.({ content: [{ type: "text", text: m }] });
  const { text, details, isError } = await runVideoReview(args, emit, signal);
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }], details };
}

const videoExtract = defineTool({
  name: "video_extract",
  promptSnippet: "video_extract - transcribe+diarize (optionally VLM frames) a video via the whisper stack; caches a bundle, returns a compact summary.",
  promptGuidelines: [
    "This is the SLOW step (transcription + diarization run on the GPU; a 60-min call is minutes). It caches a bundle to disk so video_overlap / video_doc are then instant.",
    "`file` accepts a /media or /tmp server path, 'latest'/'newest', or a filename substring (resolved via /api/media).",
    "Set frames:true only when the visual track matters (screen-shares, slides, whiteboard) - it adds a VLM pass.",
    "Diarization is on by default and is REQUIRED for video_overlap.",
    "The summary reports active speech vs wall time, warns when the enrolled owner is near-silent (possible mic-routing failure), and suggests a format tag for untagged calls - pass the suggestion to video_metrics format= to start a longitudinal baseline.",
  ],
  label: "Video Extract",
  description:
    "Transcribe + diarize a video (word-level speaker timing) via the local whisper stack, optionally describe its visual frames (VLM), cache the full bundle to disk, and return a compact summary + bundle path. Feeds video_overlap and video_doc.",
  parameters: Type.Object({
    file: Type.String({ description: "Server-side path (/media/... or /tmp/...), 'latest'/'newest', or a filename substring resolved via /api/media." }),
    diarize: Type.Optional(Type.Boolean({ description: "Speaker labels + word-level speaker timing (default true; required for overlap analysis)." })),
    frames: Type.Optional(Type.Boolean({ description: "Also run the VLM frame-description pass for the visual track (default false)." })),
    min_speakers: Type.Optional(Type.Number({ description: "Diarization floor (0 = auto)." })),
    max_speakers: Type.Optional(Type.Number({ description: "Diarization ceiling (0 = auto)." })),
    language: Type.Optional(Type.String({ description: "ISO code (en, fr) or 'Auto-detect' (default)." })),
    translate: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")], { description: "'auto' (default) translates non-English to English; true forces; false keeps source." })),
    fps_interval: Type.Optional(Type.Number({ description: "Seconds between described frames (default 10; only with frames:true)." })),
    max_frames: Type.Optional(Type.Number({ description: "Cap on described frames (default 60; only with frames:true)." })),
    timeout_sec: Type.Optional(Type.Number({ description: "Max seconds to wait for transcription (default 1800)." })),
    refresh: Type.Optional(Type.Boolean({ description: "Bypass the local bundle cache and re-run (default false)." })),
    format: Type.Optional(Type.String({ description: "Call format tag (review, customer, discovery, 1:1) - stored on the bundle so video_metrics can build per-format longitudinal baselines." })),
  }),
  async execute(_id, params, signal, onUpdate) {
    return run({ action: "extract", ...params }, signal, onUpdate);
  },
});

const videoOverlap = defineTool({
  name: "video_overlap",
  promptSnippet: "video_overlap - objective conversation review over a cached video bundle: speech overlaps, speaking-time, turn-taking latency, who-over-whom.",
  promptGuidelines: [
    "Pass `bundle` (path from video_extract) OR `file` (auto-runs extract, slow first time).",
    "This is the objective proxy a diarized transcript can't render: real acoustic collisions, not rounded segment turns.",
    "It CANNOT judge intent (steering vs information-seeking question) - report the numbers, leave intent to the human.",
    "`min_overlap_sec` filters alignment jitter + short backchannels (default 0.3).",
  ],
  label: "Video Overlap",
  description:
    "Compute objective conversation analysis from a diarized video bundle: speech-overlap events (who came in over whom, and who yielded), speaking-time distribution, turn-taking latency per speaker, and overlap clustering by speaker pair.",
  parameters: Type.Object({
    bundle: Type.Optional(Type.String({ description: "Path to a cached bundle from video_extract." })),
    file: Type.Optional(Type.String({ description: "Video file ref (if no bundle) - runs video_extract with diarize:true first." })),
    min_overlap_sec: Type.Optional(Type.Number({ description: "Minimum collision duration to count (default 0.3)." })),
    max_events: Type.Optional(Type.Number({ description: "Cap the returned overlap-event list (default 40; math still runs over all)." })),
  }),
  async execute(_id, params, signal, onUpdate) {
    return run({ action: "overlap", ...params }, signal, onUpdate);
  },
});

const videoMetrics = defineTool({
  name: "video_metrics",
  promptSnippet: "video_metrics - speaking-style metrics over a cached bundle: rate/density/fillers, turn-gap distributions, per-pair gap matrix, block (multi-unit-turn) floor-holding stats, verbatim repeats, and question-flow classification (DAMSL-lite; self-answered vs assent vs elaboration).",
  promptGuidelines: [
    "Pass `bundle` (from video_extract) OR `file`.",
    "Gap percentiles matter more than the median: p25 exposes the fast tail that a median hides.",
    "Question outcomes are heuristic: 'self-answered' = no substantive other-speaker response within the window. Verify flagged instances against the transcript before asserting them.",
    "Blocks (multi-unit turns) expose floor-holding that words/turn hides - but long blocks are not inherently monologuing (expert answers are long too); read the top-block evidence before judging.",
    "Pass format= (review, customer, discovery, 1:1) to tag the call - metrics history is stored per speaker and deltas vs prior calls print automatically.",
    "Assent vs elaboration tells you whether questions are extracting information or just confirmation - the core signal for discovery-quality review.",
  ],
  label: "Video Metrics",
  description:
    "Compute speaking-style metrics from a diarized bundle: per-speaker wpm, words/turn, filler rate, turn-gap p25/median/p75, per-pair gap matrix, and question-flow analysis (ask-then-self-answer detection, assent-vs-elaboration after each question).",
  parameters: Type.Object({
    bundle: Type.Optional(Type.String({ description: "Path to a cached bundle from video_extract." })),
    file: Type.Optional(Type.String({ description: "Video file ref (if no bundle) - runs video_extract with diarize:true first." })),
    min_overlap_sec: Type.Optional(Type.Number({ description: "Minimum collision duration to count (default 0.3)." })),
    max_events: Type.Optional(Type.Number({ description: "Cap the returned question-event list (default 30)." })),
    question_window_sec: Type.Optional(Type.Number({ description: "Seconds to wait for a response before classifying a question self-answered/unanswered (default 10)." })),
    format: Type.Optional(Type.String({ description: "Call format tag (review, customer, discovery, 1:1) for longitudinal baselines; persisted on the bundle. Overrides the tag set at extract time." })),
  }),
  async execute(_id, params, signal, onUpdate) {
    return run({ action: "metrics", ...params }, signal, onUpdate);
  },
});

const videoDoc = defineTool({
  name: "video_doc",
  promptSnippet: "video_doc - assemble markdown-ready evidence (diarized transcript + visual timeline + overlap summary) from a cached bundle for you to write the doc.",
  promptGuidelines: [
    "Pass `bundle` (from video_extract) OR `file`.",
    "Returns SECTIONS for you to synthesise the final doc - it does not write prose itself.",
    "`include_transcript` can be large; it is timestamp+speaker prefixed. Use include_frames when frames were extracted.",
    "Pass `output_path` to write the markdown straight to disk and get back only stats - the default for long calls so the transcript never enters context.",
    "After this, YOU write the meeting-notes / review / summary in the user's voice.",
  ],
  label: "Video Doc",
  description:
    "Assemble a markdown-ready evidence bundle from a video: metadata, speaking-time table, the diarized transcript, a visual timeline (VLM frame descriptions), and an overlap summary. The agent turns this into the final doc.",
  parameters: Type.Object({
    bundle: Type.Optional(Type.String({ description: "Path to a cached bundle from video_extract." })),
    file: Type.Optional(Type.String({ description: "Video file ref (if no bundle) - runs video_extract first." })),
    include_transcript: Type.Optional(Type.Boolean({ description: "Include the full diarized transcript (default true; can be large)." })),
    include_frames: Type.Optional(Type.Boolean({ description: "Include the VLM visual timeline if present (default true)." })),
    include_overlap: Type.Optional(Type.Boolean({ description: "Include the overlap summary (default true when diarized)." })),
    speaker: Type.Optional(Type.String({ description: "Filter transcript to these speakers (comma-separated, e.g. 'Erfi,Max')." })),
    start: Type.Optional(Type.Number({ description: "Only include transcript segments ending after this time (seconds)." })),
    end: Type.Optional(Type.Number({ description: "Only include transcript segments starting before this time (seconds)." })),
    output_path: Type.Optional(Type.String({ description: "Write the assembled markdown to this file instead of returning it; returns only stats (path, bytes, section sizes). Parent dirs are created." })),
  }),
  async execute(_id, params, signal, onUpdate) {
    return run({ action: "doc", ...params }, signal, onUpdate);
  },
});

const videoEnroll = defineTool({
  name: "video_enroll",
  promptSnippet: "video_enroll - enroll/list/remove a voice print so the whisper server auto-names that speaker in ALL future transcripts (UI, bot, curl, extension).",
  promptGuidelines: [
    "Enroll from an existing bundle: pass name + bundle + speaker (the diarized label, e.g. 'M-SPEAKER_01'). Pulls that speaker's embedding from the bundle - no re-run.",
    "Or enroll from a clean clip: pass name + file (+ optional start/end seconds) and the server embeds it.",
    "action:'list' shows enrolled names; action:'remove' + name deletes.",
    "Identification is server-side, so enrolled names appear in plain transcription too - not just via this extension.",
    "Enrolling the same name twice adds a second reference vector (improves matching); it does not overwrite.",
  ],
  label: "Video Enroll",
  description:
    "Manage server-side voice prints for automatic speaker naming. Enroll a name from a cached bundle's speaker (by embedding) or from an audio/video clip; list or remove enrolled prints. Enrolled speakers are auto-named in every diarized transcript the server produces.",
  parameters: Type.Object({
    action: Type.Optional(Type.Union([Type.Literal("add"), Type.Literal("list"), Type.Literal("remove")], { description: "'add' (default), 'list', or 'remove'." })),
    name: Type.Optional(Type.String({ description: "Person's name (required for add/remove)." })),
    bundle: Type.Optional(Type.String({ description: "add: cached bundle path to pull the speaker embedding from." })),
    speaker: Type.Optional(Type.String({ description: "add-from-bundle: the diarized speaker label to enroll (e.g. 'M-SPEAKER_01')." })),
    file: Type.Optional(Type.String({ description: "add-from-clip: server-side path / 'latest' / filename substring the server will embed." })),
    start: Type.Optional(Type.Number({ description: "add-from-clip: clip start (seconds)." })),
    end: Type.Optional(Type.Number({ description: "add-from-clip: clip end (seconds)." })),
  }),
  async execute(_id, params, signal, onUpdate) {
    return run({ action: "enroll", enroll_action: params.action, name: params.name, bundle: params.bundle, speaker: params.speaker, file: params.file, start: params.start, end: params.end }, signal, onUpdate);
  },
});

const videoName = defineTool({
  name: "video_name",
  promptSnippet: "video_name - relabel speakers in a cached bundle from a manual/LLM-inferred {label:name} map (client-side; does not enroll).",
  promptGuidelines: [
    "Use for one-off naming or correcting a transcript WITHOUT re-running the server - e.g. you inferred names from the transcript ('thanks, Alice').",
    "`map` accepts JSON {\"M-SPEAKER_01\":\"Alice\"} or compact 'M-SPEAKER_01=Alice, M-SPEAKER_00=Erfi'.",
    "To make a name stick across FUTURE calls, use video_enroll instead (server-side voice print).",
    "Rewrites the cached bundle in place; video_overlap / video_doc then show the names.",
  ],
  label: "Video Name",
  description:
    "Relabel speakers in a cached bundle from a {label:name} map (manual or LLM-inferred). Client-side only - rewrites the bundle so downstream tools show real names. Does not enroll a voice print (use video_enroll for that).",
  parameters: Type.Object({
    bundle: Type.String({ description: "Path to a cached bundle from video_extract." }),
    map: Type.String({ description: "Name map: JSON {\"M-SPEAKER_01\":\"Alice\"} or compact 'M-SPEAKER_01=Alice, M-SPEAKER_00=Erfi'." }),
    enroll: Type.Optional(Type.Boolean({ description: "Also enroll each mapped name as a server-side voice print (from the bundle embeddings) so future calls auto-name them. Default false." })),
  }),
  async execute(_id, params, signal, onUpdate) {
    return run({ action: "name", bundle: params.bundle, map: params.map, enroll_action: params.enroll ? "add" : undefined }, signal, onUpdate);
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(videoExtract);
  pi.registerTool(videoOverlap);
  pi.registerTool(videoMetrics);
  pi.registerTool(videoDoc);
  pi.registerTool(videoEnroll);
  pi.registerTool(videoName);
}
