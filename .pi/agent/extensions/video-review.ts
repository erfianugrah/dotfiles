/**
 * video-review - turn a recorded video (call, demo, walkthrough) into a
 * structured doc or an objective conversation review, on top of the local
 * whisper-transcribe stack (`:7860`).
 *
 * The whisper service already exposes every primitive:
 *   - POST /api/jobs {diarize:true, format:"json"}  -> word-level transcript
 *       with per-word start/end/speaker/confidence (WhisperX alignment)
 *   - POST /api/describe                            -> VLM frame descriptions
 *   - GET  /api/artifact?path=...                   -> fetch the word-level
 *       JSON file the job wrote server-side (added alongside this extension)
 *   - GET  /api/media                               -> server-side file list
 *
 * This extension orchestrates them into three tools:
 *
 *   video_extract  run the pipeline once (slow: transcription + diarization,
 *                  optional VLM frames). Caches the full bundle to disk and
 *                  returns only a COMPACT summary + a bundle path. The huge
 *                  word-level array never enters the model context.
 *   video_overlap  pure-TS conversation analysis over the cached bundle:
 *                  objective speech overlaps ("started while they were still
 *                  talking"), speaking-time distribution, turn-taking latency,
 *                  who-interrupted-whom, and whether overlaps cluster on
 *                  specific (high-latency) speakers.
 *   video_doc      assemble a markdown-ready evidence bundle (diarized
 *                  transcript + a visual timeline from VLM frames + the
 *                  overlap summary) sized for the agent to write the final
 *                  meeting-notes / review doc.
 *
 * Design split: the tools do deterministic extraction + math; the agent (an
 * LLM already) does the prose synthesis. That is the token-disciplined shape.
 *
 * WORD OF WARNING on cache: the whisper transcript cache stores only the
 * flattened text, NOT the word arrays, and nulls `subtitle_file` on a cache
 * hit. So video_extract passes `refresh:true` to guarantee a fresh word-level
 * JSON artifact. The expensive run happens once per (file, params); the parsed
 * bundle is then cached locally on disk so video_overlap / video_doc are
 * instant.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const WHISPER_URL = process.env.WHISPER_URL ?? "http://localhost:7860";
// Persistent store (survives reboots - /tmp does not; a lost bundle costs a
// full GPU re-extract). LEGACY dir kept as a read fallback for pre-move bundles.
const CACHE_DIR = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "video-review");
const LEGACY_CACHE_DIR = join(tmpdir(), "video-review");

// ── types ───────────────────────────────────────────────────────────────

export interface Word {
  word: string;
  start?: number;
  end?: number;
  confidence?: number;
  speaker?: string;
}
export interface Segment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
  words?: Word[];
}
export interface Frame {
  timestamp: number;
  text: string;
}
export interface Bundle {
  file: string;
  language: string;
  duration: number;
  segments: Segment[];
  frames?: Frame[];
  speakers: string[];
  hasWordSpeakers: boolean;
  /** Per-speaker 256-d WeSpeaker voice embeddings, keyed by the segment
   * speaker label. Present when a diarized job returned them. Used for
   * voice-print identification. */
  speakerEmbeddings?: Record<string, number[]>;
  /** label -> assigned real name, from voice-print match or manual/LLM map. */
  names?: Record<string, string>;
  createdAt: string;
  params: Record<string, unknown>;
}

// ── speaker naming (pure) ─────────────────────────────────────
// Voice-print enrollment + cosine identification live SERVER-SIDE (whisper
// app.py) so the SPA, bot, and plain-curl transcription all get named
// speakers - not just this extension. The client keeps only manual/LLM
// relabeling of an already-cached bundle.

/**
 * Relabel a bundle in place from a { oldLabel: newName } map: rewrites
 * seg.speaker, each word.speaker, and the speakers list. Embedding keys are
 * deliberately NOT renamed: speakerEmbeddings stays keyed by the original
 * diarized label (a stable ID) so video_enroll can always pull a vector by
 * label, and bundle.names carries the label -> display-name mapping.
 * Re-renames are normalised: if a map key is an existing names VALUE
 * (e.g. Jess -> Tim after M-SPEAKER_05 -> Jess), that entry is updated in
 * place instead of chaining {M-SPEAKER_05: Jess, Jess: Tim}.
 */
export function applyNameMap(bundle: Bundle, map: Record<string, string>): Bundle {
  const remap = (label: string | undefined) => (label && map[label] ? map[label] : label);
  for (const seg of bundle.segments) {
    seg.speaker = remap(seg.speaker);
    for (const w of seg.words ?? []) w.speaker = remap(w.speaker);
  }
  bundle.speakers = [...new Set(bundle.segments.map((s) => s.speaker).filter((x): x is string => !!x))].sort();
  const names = { ...(bundle.names ?? {}) };
  for (const [k, v] of Object.entries(map)) {
    const prior = Object.keys(names).find((label) => names[label] === k);
    if (prior) names[prior] = v;
    else names[k] = v;
  }
  bundle.names = names;
  return bundle;
}

/**
 * Resolve a speaker argument (original diarized label OR current display
 * name) to that speaker's embedding. Returns null when unknown.
 */
export function resolveEmbedding(bundle: Bundle, speakerArg: string): { label: string; vec: number[] } | null {
  const embs = bundle.speakerEmbeddings ?? {};
  if (embs[speakerArg]) return { label: speakerArg, vec: embs[speakerArg] };
  for (const [label, name] of Object.entries(bundle.names ?? {})) {
    if (name === speakerArg && embs[label]) return { label, vec: embs[label] };
  }
  return null;
}

// ── file resolution (pure) ────────────────────────────────────────────────

export interface MediaFile {
  name: string;
  path: string;
}

/**
 * Resolve a user-supplied file reference to a whisper-server-side path.
 * - Already-server-side paths (/media/... or /tmp/...) pass through.
 * - "latest" / "newest" -> files[0] (the media list is newest-first).
 * - Anything else -> case-insensitive substring match against file names,
 *   newest match wins.
 * Pure: takes the media list, returns the resolved path or null.
 */
export function resolveMediaPath(query: string, files: MediaFile[]): string | null {
  const q = query.trim();
  if (!q) return null;
  if (q.startsWith("/media/") || q.startsWith("/tmp/")) return q;
  if (q === "latest" || q === "newest") return files[0]?.path ?? null;
  const lower = q.toLowerCase();
  const hit = files.find((f) => f.name.toLowerCase().includes(lower));
  return hit?.path ?? null;
}

// ── cache key (pure) ──────────────────────────────────────────────────────

export function bundleCacheKey(serverPath: string, params: Record<string, unknown>): string {
  const h = createHash("sha256");
  h.update(serverPath);
  h.update(JSON.stringify(params));
  return h.digest("hex").slice(0, 16);
}

// ── utterance merging (pure) ──────────────────────────────────────────────

export interface Utterance {
  speaker: string;
  start: number;
  end: number;
  wordCount: number;
  text: string;
}

/**
 * Merge word-level tokens into per-speaker utterances. Words are grouped BY
 * SPEAKER first, then each speaker's own stream is merged: consecutive words
 * separated by <= gapSec become one utterance. Grouping per-speaker (rather
 * than merging a single globally-sorted stream) is load-bearing - when two
 * speakers overlap, a global sort interleaves their words and would fragment
 * both into spurious back-and-forth utterances, inventing ping-pong overlaps
 * that never happened. Per-speaker spans stay whole; overlap is then a clean
 * interval intersection between different speakers. Words missing
 * start/end/speaker are skipped. Output is sorted by start time.
 */
export function mergeUtterances(segments: Segment[], gapSec = 0.6): Utterance[] {
  const bySpeaker = new Map<string, Word[]>();
  for (const seg of segments) {
    for (const w of seg.words ?? []) {
      if (typeof w.start === "number" && typeof w.end === "number" && w.speaker) {
        let arr = bySpeaker.get(w.speaker);
        if (!arr) bySpeaker.set(w.speaker, (arr = []));
        arr.push(w);
      }
    }
  }

  const out: Utterance[] = [];
  for (const [speaker, words] of bySpeaker) {
    words.sort((a, b) => (a.start! - b.start!) || (a.end! - b.end!));
    let cur: Utterance | null = null;
    for (const w of words) {
      if (cur && w.start! - cur.end <= gapSec) {
        cur.end = Math.max(cur.end, w.end!);
        cur.wordCount += 1;
        cur.text += (cur.text ? " " : "") + w.word.trim();
      } else {
        cur = { speaker, start: w.start!, end: w.end!, wordCount: 1, text: w.word.trim() };
        out.push(cur);
      }
    }
  }
  out.sort((a, b) => (a.start - b.start) || (a.end - b.end));
  return out;
}

// ── overlap analysis (pure) ───────────────────────────────────────────────

export interface OverlapEvent {
  at: number; // when the interrupter started
  interrupter: string; // the speaker who began while another was talking
  interruptee: string; // the speaker who was already talking
  overlapSec: number; // duration of acoustic collision
  yielded: string; // who stopped first (interruptee = classic interruption; interrupter = false start / backchannel)
  interrupterText: string;
}

export interface SpeakerStat {
  speaker: string;
  speakingSec: number;
  utterances: number;
  words: number;
  startedOverOthers: number; // times this speaker began while another was talking
  wasStartedOver: number; // times another began while this speaker was talking
  medianTurnGapSec: number | null; // median gap when THIS speaker takes the floor after someone else (negative = tends to come in hot)
}

export interface OverlapReport {
  speakers: SpeakerStat[];
  events: OverlapEvent[];
  pairCounts: { pair: string; count: number; totalSec: number }[];
  totalOverlapSec: number;
  clocked: number; // total clocked speech seconds across speakers
  note: string;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The objective proxy the diarized transcript could never render: does speech
 * physically collide, who came in over whom, and does it cluster.
 *
 * `minOverlapSec` filters out sub-threshold collisions (alignment jitter,
 * short backchannels like "yeah"/"mm"). Default 0.30s.
 */
export function computeOverlap(utterances: Utterance[], minOverlapSec = 0.3): OverlapReport {
  const us = [...utterances].sort((a, b) => a.start - b.start);

  // Per-speaker aggregate.
  const stat = new Map<string, SpeakerStat>();
  const turnGaps = new Map<string, number[]>();
  const ensure = (sp: string): SpeakerStat => {
    let s = stat.get(sp);
    if (!s) {
      s = { speaker: sp, speakingSec: 0, utterances: 0, words: 0, startedOverOthers: 0, wasStartedOver: 0, medianTurnGapSec: null };
      stat.set(sp, s);
      turnGaps.set(sp, []);
    }
    return s;
  };
  for (const u of us) {
    const s = ensure(u.speaker);
    s.speakingSec += u.end - u.start;
    s.utterances += 1;
    s.words += u.wordCount;
  }

  // Overlap events: any later-starting utterance whose start falls inside an
  // earlier utterance's [start,end] from a DIFFERENT speaker. We scan a small
  // active window rather than all pairs (utterances are time-sorted).
  const events: OverlapEvent[] = [];
  const pair = new Map<string, { count: number; totalSec: number }>();
  for (let i = 0; i < us.length; i++) {
    const later = us[i];
    for (let j = i - 1; j >= 0; j--) {
      const earlier = us[j];
      if (earlier.end <= later.start) {
        // earlier ended before later began; since sorted by start, everything
        // further back is even more likely done, but gaps vary - bail after a
        // reasonable lookback window.
        if (later.start - earlier.end > 8) break;
        continue;
      }
      if (earlier.speaker === later.speaker) continue;
      const overlapSec = Math.min(earlier.end, later.end) - later.start;
      if (overlapSec < minOverlapSec) continue;
      const yielded = earlier.end <= later.end ? earlier.speaker : later.speaker;
      events.push({
        at: later.start,
        interrupter: later.speaker,
        interruptee: earlier.speaker,
        overlapSec: Math.round(overlapSec * 100) / 100,
        yielded,
        interrupterText: later.text.slice(0, 80),
      });
      ensure(later.speaker).startedOverOthers += 1;
      ensure(earlier.speaker).wasStartedOver += 1;
      const key = `${later.speaker} over ${earlier.speaker}`;
      const p = pair.get(key) ?? { count: 0, totalSec: 0 };
      p.count += 1;
      p.totalSec += overlapSec;
      pair.set(key, p);
      break; // one interruptee per interrupter-start is enough
    }
  }

  // Turn-taking gap: for each floor handoff to a new speaker, gap between the
  // previous (different) speaker's end and this speaker's start. Negative =
  // came in hot / overlapped.
  for (let i = 1; i < us.length; i++) {
    const prev = us[i - 1];
    const cur = us[i];
    if (prev.speaker === cur.speaker) continue;
    turnGaps.get(cur.speaker)!.push(Math.round((cur.start - prev.end) * 100) / 100);
  }
  for (const s of stat.values()) {
    s.speakingSec = Math.round(s.speakingSec * 100) / 100;
    s.medianTurnGapSec = median(turnGaps.get(s.speaker) ?? []);
  }

  const totalOverlapSec = Math.round(events.reduce((a, e) => a + e.overlapSec, 0) * 100) / 100;
  const clocked = Math.round([...stat.values()].reduce((a, s) => a + s.speakingSec, 0) * 100) / 100;
  const pairCounts = [...pair.entries()]
    .map(([k, v]) => ({ pair: k, count: v.count, totalSec: Math.round(v.totalSec * 100) / 100 }))
    .sort((a, b) => b.count - a.count);

  const note =
    "Overlap = another speaker's speech onset falls inside your still-active utterance. " +
    "`yielded` names who stopped first: interruptee stopping = classic talk-over; interrupter stopping = false-start / backchannel. " +
    "Cannot distinguish a steering question from an information-seeking one - that stays a human call.";

  return {
    speakers: [...stat.values()].sort((a, b) => b.speakingSec - a.speakingSec),
    events,
    pairCounts,
    totalOverlapSec,
    clocked,
    note,
  };
}

// ── speaking-metrics analysis (pure) ──────────────────────────────────────

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const s = [...sorted].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const v = s[lo] + (s[hi] - s[lo]) * (idx - lo);
  return Math.round(v * 100) / 100;
}

/** Filler/hedge lexicon. Multi-word entries matched as substrings on the
 * lowercased utterance text; single words with word boundaries. */
const FILLER_PATTERNS: RegExp[] = [
  /\bum+\b/i,
  /\buh+\b/i,
  /\byou know\b/i,
  /\bsort of\b/i,
  /\bkind of\b/i,
  /\bbasically\b/i,
  /\bactually\b/i,
  /\bi mean\b/i,
  /\bto some extent\b/i,
  /\beffectively\b/i,
];

export function countFillers(text: string): number {
  let n = 0;
  for (const re of FILLER_PATTERNS) {
    const m = text.match(new RegExp(re.source, "gi"));
    if (m) n += m.length;
  }
  return n;
}

/** Short acknowledgement lexicon: a response made of only these (<= 6 words)
 * is assent, not elaboration. Multi-word phrases are stripped greedily from
 * the front, so "yeah exactly" and "okay that makes sense" both qualify. */
const ASSENT_PHRASES = [
  "that makes sense", "makes sense", "sounds good", "fair enough", "of course", "no worries", "all right", "thank you", "got it", "i see", "uh-huh", "mm-hmm",
  "yeah", "yes", "yep", "yup", "okay", "ok", "sure", "right", "correct", "exactly", "indeed", "true", "cool", "nice", "perfect", "great", "good", "mm", "mhm", "agreed", "absolutely", "definitely", "interesting", "wow", "oh", "ah", "huh", "thanks", "alright",
];

export function isAssent(text: string, wordCount: number): boolean {
  if (wordCount > 6) return false;
  let t = text
    .trim()
    .toLowerCase()
    .replace(/[?!.,;:'"-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return false;
  let changed = true;
  while (changed && t) {
    changed = false;
    for (const p of ASSENT_PHRASES) {
      if (t === p) return true;
      if (t.startsWith(p + " ")) {
        t = t.slice(p.length).trim();
        changed = true;
        break;
      }
    }
  }
  return t === "";
}

export type QuestionOutcome = "self-answered" | "assent" | "elaboration" | "unanswered";

export interface QuestionEvent {
  at: number;
  asker: string;
  question: string;
  outcome: QuestionOutcome;
  responder?: string;
  responseSnippet?: string;
  responseGapSec?: number;
}

/**
 * Question-flow analysis over time-sorted utterances. For each utterance
 * containing '?', find what happened next:
 *  - a different speaker's substantive response within `windowSec` ->
 *    'assent' (short ack) or 'elaboration' (new information)
 *  - only backchannels from others, then the ASKER's own next utterance ->
 *    'self-answered' (the ask-then-self-answer move)
 *  - nothing within the window -> 'unanswered'
 * Backchannels (< 4 words matching the assent lexicon) are skipped over when
 * looking for a substantive response.
 */
export function analyzeQuestions(utterances: Utterance[], windowSec = 10): QuestionEvent[] {
  const us = [...utterances].sort((a, b) => a.start - b.start);
  const events: QuestionEvent[] = [];
  for (let i = 0; i < us.length; i++) {
    const u = us[i];
    if (!u.text.includes("?") || u.wordCount < 3) continue;
    let responder: Utterance | null = null;
    let firstAck: Utterance | null = null;
    let selfNext: Utterance | null = null;
    for (let j = i + 1; j < us.length; j++) {
      const v = us[j];
      if (v.start - u.end > windowSec) break;
      if (v.speaker === u.speaker) {
        if (!selfNext) selfNext = v;
        continue;
      }
      // backchannel from someone else: remember it but keep scanning for a
      // substantive response
      if (v.wordCount < 4 && isAssent(v.text, v.wordCount)) {
        if (!firstAck) firstAck = v;
        continue;
      }
      responder = v;
      break;
    }
    // A lone acknowledgement with nothing substantive behind it is normally
    // the response (assent). But when the asker's own continuation follows
    // and is NOT itself a new question, the asker answered despite the ack -
    // that's the self-answered move; the ack was just a backchannel.
    if (!responder && firstAck && (!selfNext || selfNext.text.includes("?"))) responder = firstAck;
    if (responder) {
      const assent = isAssent(responder.text, responder.wordCount);
      events.push({
        at: u.start,
        asker: u.speaker,
        question: u.text.slice(0, 120),
        outcome: assent ? "assent" : "elaboration",
        responder: responder.speaker,
        responseSnippet: responder.text.slice(0, 80),
        responseGapSec: Math.round((responder.start - u.end) * 100) / 100,
      });
    } else if (selfNext) {
      events.push({
        at: u.start,
        asker: u.speaker,
        question: u.text.slice(0, 120),
        outcome: "self-answered",
        responder: u.speaker,
        responseSnippet: selfNext.text.slice(0, 80),
        responseGapSec: Math.round((selfNext.start - u.end) * 100) / 100,
      });
    } else {
      events.push({ at: u.start, asker: u.speaker, question: u.text.slice(0, 120), outcome: "unanswered" });
    }
  }
  return events;
}

export interface MetricsSpeaker {
  speaker: string;
  speakingSec: number;
  sharePct: number;
  utterances: number;
  words: number;
  wordsPerTurn: number | null;
  wpm: number | null;
  gapP25: number | null;
  gapMedian: number | null;
  gapP75: number | null;
  cameInOver: number;
  wasCut: number;
  fillersPer100: number | null;
}

export interface PairGap {
  pair: string; // "B after A"
  medianGapSec: number | null;
  samples: number;
}

export interface QuestionSummary {
  asker: string;
  questions: number;
  selfAnswered: number;
  assent: number;
  elaboration: number;
  unanswered: number;
}

export interface MetricsReport {
  speakers: MetricsSpeaker[];
  pairGaps: PairGap[];
  questions: QuestionSummary[];
  questionEvents: QuestionEvent[];
  clocked: number;
}

/**
 * Full speaking-style metrics: delivery stats (rate, density, fillers),
 * turn-gap DISTRIBUTIONS (p25/median/p75 - the median alone hides the fast
 * tail), a per-pair gap matrix (who enters fast after WHOM), and the
 * question-flow classifier (self-answered vs assent vs elaboration).
 * Overlap counts reuse computeOverlap so both tools agree.
 */
export function computeMetrics(utterances: Utterance[], minOverlapSec = 0.3): MetricsReport {
  const us = [...utterances].sort((a, b) => a.start - b.start);
  const overlap = computeOverlap(us, minOverlapSec);
  const clocked = overlap.clocked;

  const gaps = new Map<string, number[]>();
  const pairGaps = new Map<string, number[]>();
  const fillers = new Map<string, number>();
  for (const u of us) {
    fillers.set(u.speaker, (fillers.get(u.speaker) ?? 0) + countFillers(u.text));
  }
  for (let i = 1; i < us.length; i++) {
    const prev = us[i - 1];
    const cur = us[i];
    if (prev.speaker === cur.speaker) continue;
    const gap = Math.round((cur.start - prev.end) * 100) / 100;
    let g = gaps.get(cur.speaker);
    if (!g) gaps.set(cur.speaker, (g = []));
    g.push(gap);
    const key = `${cur.speaker} after ${prev.speaker}`;
    let pg = pairGaps.get(key);
    if (!pg) pairGaps.set(key, (pg = []));
    pg.push(gap);
  }

  const speakers: MetricsSpeaker[] = overlap.speakers.map((s) => {
    const g = gaps.get(s.speaker) ?? [];
    const wpt = s.utterances ? Math.round((s.words / s.utterances) * 10) / 10 : null;
    const wpm = s.speakingSec > 0 ? Math.round(s.words / (s.speakingSec / 60)) : null;
    const f = fillers.get(s.speaker) ?? 0;
    return {
      speaker: s.speaker,
      speakingSec: s.speakingSec,
      sharePct: clocked ? Math.round((s.speakingSec / clocked) * 100) : 0,
      utterances: s.utterances,
      words: s.words,
      wordsPerTurn: wpt,
      wpm,
      gapP25: percentile(g, 25),
      gapMedian: percentile(g, 50),
      gapP75: percentile(g, 75),
      cameInOver: s.startedOverOthers,
      wasCut: s.wasStartedOver,
      fillersPer100: s.words ? Math.round((f / s.words) * 1000) / 10 : null,
    };
  });

  const pairGapList: PairGap[] = [...pairGaps.entries()]
    .filter(([, v]) => v.length >= 3)
    .map(([pair, v]) => ({ pair, medianGapSec: percentile(v, 50), samples: v.length }))
    .sort((a, b) => (a.medianGapSec ?? 99) - (b.medianGapSec ?? 99));

  const questionEvents = analyzeQuestions(us);
  const qsum = new Map<string, QuestionSummary>();
  for (const e of questionEvents) {
    let q = qsum.get(e.asker);
    if (!q) qsum.set(e.asker, (q = { asker: e.asker, questions: 0, selfAnswered: 0, assent: 0, elaboration: 0, unanswered: 0 }));
    q.questions += 1;
    if (e.outcome === "self-answered") q.selfAnswered += 1;
    else if (e.outcome === "assent") q.assent += 1;
    else if (e.outcome === "elaboration") q.elaboration += 1;
    else q.unanswered += 1;
  }

  return {
    speakers,
    pairGaps: pairGapList,
    questions: [...qsum.values()].sort((a, b) => b.questions - a.questions),
    questionEvents,
    clocked,
  };
}

// ── time formatting (pure) ────────────────────────────────────────────────

export function hhmmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

// ── HTTP helpers (side-effectful) ─────────────────────────────────────────

async function whisperGet(path: string, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(`${WHISPER_URL}${path}`, { signal });
  if (!res.ok) throw new Error(`whisper GET ${path} -> HTTP ${res.status}`);
  return res;
}

async function whisperPostJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${WHISPER_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`whisper POST ${path} -> HTTP ${res.status}${t ? `: ${t.slice(0, 240)}` : ""}`);
  }
  return (await res.json()) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface JobResult {
  status?: string;
  transcript?: string;
  subtitle_file?: string | null;
}
interface JobState {
  status: string;
  error?: string;
  result?: JobResult;
}

async function runTranscriptionJob(
  serverPath: string,
  opts: { diarize: boolean; minSpeakers: number; maxSpeakers: number; language: string; translate: boolean | "auto"; timeoutMs: number },
  onUpdate: ((m: string) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<{ segments: Segment[]; speakerEmbeddings?: Record<string, number[]>; names?: Record<string, string> }> {
  const submit = await whisperPostJson<{ job_id: string }>(
    "/api/jobs",
    {
      file_path: serverPath,
      model: "turbo",
      format: "json",
      diarize: opts.diarize,
      min_speakers: opts.minSpeakers,
      max_speakers: opts.maxSpeakers,
      language: opts.language,
      translate: opts.translate,
      return_file: true,
      refresh: true, // guarantee a word-level JSON artifact (cache stores text only)
    },
    signal,
  );
  const jobId = submit.job_id;
  const deadline = Date.now() + opts.timeoutMs;
  let last = "";
  for (;;) {
    if (Date.now() > deadline) throw new Error(`transcription job ${jobId} timed out after ${Math.round(opts.timeoutMs / 1000)}s`);
    await sleep(4000);
    const st = (await whisperGet(`/api/jobs/${jobId}`, signal).then((r) => r.json())) as JobState;
    if (st.status !== last) {
      onUpdate?.(`transcription: ${st.status}`);
      last = st.status;
    }
    if (st.status === "done") {
      const sub = st.result?.subtitle_file;
      if (!sub) throw new Error("job done but no subtitle_file (word-level JSON) was produced");
      const raw = await whisperGet(`/api/artifact?path=${encodeURIComponent(sub)}`, signal).then((r) => r.text());
      const parsed = JSON.parse(raw) as {
        segments: Segment[];
        speaker_embeddings?: Record<string, number[]>;
        speaker_names?: Record<string, string>;
      };
      return { segments: parsed.segments ?? [], speakerEmbeddings: parsed.speaker_embeddings, names: parsed.speaker_names };
    }
    if (st.status === "failed" || st.status === "cancelled") {
      throw new Error(`transcription ${st.status}${st.error ? `: ${st.error}` : ""}`);
    }
  }
}

interface DescribeResult {
  duration?: number;
  descriptions?: { timestamp: number; text: string }[];
}

async function runDescribe(
  serverPath: string,
  opts: { fpsInterval: number; maxFrames: number },
  onUpdate: ((m: string) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<Frame[]> {
  onUpdate?.("visual: describing frames (VLM)...");
  const res = await whisperPostJson<DescribeResult>(
    "/api/describe",
    { file_path: serverPath, fps_interval: opts.fpsInterval, max_frames: opts.maxFrames },
    signal,
  );
  return (res.descriptions ?? []).map((d) => ({ timestamp: d.timestamp, text: d.text }));
}

// ── bundle cache (side-effectful) ─────────────────────────────────────────

function cachePath(key: string): string {
  return join(CACHE_DIR, `${key}.json`);
}

function readBundle(key: string): Bundle | null {
  for (const dir of [CACHE_DIR, LEGACY_CACHE_DIR]) {
    const p = join(dir, `${key}.json`);
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf8")) as Bundle;
      } catch {
        return null;
      }
    }
  }
  return null;
}

interface IndexEntry {
  key: string;
  file: string;
  duration: number;
  speakers: string[];
  createdAt: string;
}

/** Maintain a lightweight index.json beside the bundles for cross-bundle
 * (longitudinal) lookups without parsing every bundle file. */
function updateIndex(key: string, b: Bundle): void {
  try {
    const p = join(CACHE_DIR, "index.json");
    let idx: Record<string, IndexEntry> = {};
    try {
      idx = JSON.parse(readFileSync(p, "utf8")) as Record<string, IndexEntry>;
    } catch {
      /* start fresh */
    }
    idx[key] = { key, file: b.file, duration: b.duration, speakers: b.speakers, createdAt: b.createdAt };
    writeFileSync(p, JSON.stringify(idx, null, 2));
  } catch {
    /* index is advisory - never fail a write over it */
  }
}

function writeBundle(key: string, b: Bundle): string {
  mkdirSync(CACHE_DIR, { recursive: true });
  const p = cachePath(key);
  writeFileSync(p, JSON.stringify(b));
  updateIndex(key, b);
  return p;
}

async function resolveToServerPath(fileRef: string, signal: AbortSignal | undefined): Promise<string> {
  const q = fileRef.trim();
  if (q.startsWith("/media/") || q.startsWith("/tmp/")) return q;
  const media = (await whisperGet("/api/media", signal).then((r) => r.json())) as { files: MediaFile[] };
  const resolved = resolveMediaPath(q, media.files ?? []);
  if (!resolved) {
    const names = (media.files ?? []).slice(0, 8).map((f) => f.name).join(", ");
    throw new Error(`could not resolve "${fileRef}" to a server-side media file. Recent files: ${names || "(none)"}`);
  }
  return resolved;
}

/**
 * Produce (or reuse) a cached bundle for the given file + extract options.
 * Returns the bundle and its on-disk cache path.
 */
async function ensureBundle(
  fileRef: string,
  opts: {
    diarize: boolean;
    frames: boolean;
    minSpeakers: number;
    maxSpeakers: number;
    language: string;
    translate: boolean | "auto";
    fpsInterval: number;
    maxFrames: number;
    timeoutMs: number;
    refresh: boolean;
  },
  onUpdate: ((m: string) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<{ bundle: Bundle; path: string; key: string; fromCache: boolean }> {
  const serverPath = await resolveToServerPath(fileRef, signal);
  const params = {
    diarize: opts.diarize,
    frames: opts.frames,
    minSpeakers: opts.minSpeakers,
    maxSpeakers: opts.maxSpeakers,
    language: opts.language,
    translate: opts.translate,
    fpsInterval: opts.frames ? opts.fpsInterval : undefined,
    maxFrames: opts.frames ? opts.maxFrames : undefined,
  };
  const key = bundleCacheKey(serverPath, params);
  if (!opts.refresh) {
    const cached = readBundle(key);
    if (cached) return { bundle: cached, path: cachePath(key), key, fromCache: true };
  }

  const { segments, speakerEmbeddings, names } = await runTranscriptionJob(
    serverPath,
    { diarize: opts.diarize, minSpeakers: opts.minSpeakers, maxSpeakers: opts.maxSpeakers, language: opts.language, translate: opts.translate, timeoutMs: opts.timeoutMs },
    onUpdate,
    signal,
  );
  let frames: Frame[] | undefined;
  if (opts.frames) {
    frames = await runDescribe(serverPath, { fpsInterval: opts.fpsInterval, maxFrames: opts.maxFrames }, onUpdate, signal);
  }

  const speakers = [...new Set(segments.map((s) => s.speaker).filter((x): x is string => !!x))].sort();
  const hasWordSpeakers = segments.some((s) => (s.words ?? []).some((w) => !!w.speaker));
  const duration = segments.length ? Math.max(...segments.map((s) => s.end)) : 0;

  const bundle: Bundle = {
    file: serverPath,
    language: "",
    duration,
    segments,
    frames,
    speakers,
    hasWordSpeakers,
    speakerEmbeddings,
    names: names && Object.keys(names).length ? names : undefined,
    createdAt: new Date().toISOString(),
    params,
  };
  const path = writeBundle(key, bundle);
  return { bundle, path, key, fromCache: false };
}

// ── shared option parsing ─────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractOpts(p: any) {
  return {
    diarize: p.diarize ?? true,
    frames: p.frames ?? false,
    minSpeakers: p.min_speakers ?? 0,
    maxSpeakers: p.max_speakers ?? 0,
    language: p.language ?? "Auto-detect",
    translate: (p.translate ?? "auto") as boolean | "auto",
    fpsInterval: p.fps_interval ?? 10,
    maxFrames: p.max_frames ?? 60,
    timeoutMs: (p.timeout_sec ?? 1800) * 1000,
    refresh: p.refresh ?? false,
  };
}

// ── tool: video_extract ───────────────────────────────────────────────────

const videoExtract = defineTool({
  name: "video_extract",
  promptSnippet: "video_extract - transcribe+diarize (optionally VLM frames) a video via the whisper stack; caches a bundle, returns a compact summary.",
  promptGuidelines: [
    "This is the SLOW step (transcription + diarization run on the GPU; a 60-min call is minutes). It caches a bundle to disk so video_overlap / video_doc are then instant.",
    "`file` accepts a /media or /tmp server path, 'latest'/'newest', or a filename substring (resolved via /api/media).",
    "Set frames:true only when the visual track matters (screen-shares, slides, whiteboard) - it adds a VLM pass.",
    "Diarization is on by default and is REQUIRED for video_overlap.",
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
  }),
  async execute(_id, params, signal, onUpdate) {
    const opts = extractOpts(params);
    const emit = (m: string) => onUpdate?.({ content: [{ type: "text", text: m }] });
    const { bundle, path, fromCache } = await ensureBundle(params.file, opts, emit, signal);

    const utts = bundle.hasWordSpeakers ? mergeUtterances(bundle.segments) : [];
    const lines: string[] = [];
    lines.push(`file: ${bundle.file}`);
    lines.push(`duration: ${hhmmss(bundle.duration)}  |  segments: ${bundle.segments.length}  |  speakers: ${bundle.speakers.length ? bundle.speakers.join(", ") : "(none / diarize off)"}`);
    if (bundle.frames) lines.push(`frames described: ${bundle.frames.length}`);
    if (bundle.names && Object.keys(bundle.names).length) {
      lines.push(`auto-identified: ${Object.values(bundle.names).join(", ")} (server voice prints)`);
    } else if (bundle.hasWordSpeakers) {
      lines.push(`names: none matched - enroll with video_enroll, or label via video_name`);
    }
    lines.push(`word-level speaker timing: ${bundle.hasWordSpeakers ? "yes (overlap analysis available)" : "NO (re-run with diarize:true for overlap)"}`);
    lines.push(fromCache ? "(served from local bundle cache)" : "(fresh run)");
    lines.push("");
    lines.push(`bundle: ${path}`);
    lines.push("Next: video_overlap for conversation review, video_doc for meeting-notes source.");
    if (utts.length) {
      const total = utts.reduce((a, u) => a + (u.end - u.start), 0) || 1;
      lines.push("");
      lines.push("speaking time:");
      const per = new Map<string, number>();
      for (const u of utts) per.set(u.speaker, (per.get(u.speaker) ?? 0) + (u.end - u.start));
      for (const [sp, sec] of [...per.entries()].sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${sp}: ${hhmmss(sec)} (${Math.round((sec / total) * 100)}%)`);
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") }], details: { bundle: path, speakers: bundle.speakers, duration: bundle.duration, fromCache } };
  },
});

// ── tool: video_overlap ───────────────────────────────────────────────────

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
    const emit = (m: string) => onUpdate?.({ content: [{ type: "text", text: m }] });
    let bundle: Bundle | null = null;
    if (params.bundle) bundle = readBundleByPath(params.bundle);
    if (!bundle && params.file) {
      const opts = extractOpts({ diarize: true });
      bundle = (await ensureBundle(params.file, opts, emit, signal)).bundle;
    }
    if (!bundle) throw new Error("provide `bundle` (from video_extract) or `file`");
    if (!bundle.hasWordSpeakers) throw new Error("bundle has no word-level speaker timing; re-run video_extract with diarize:true");

    const minOv = params.min_overlap_sec ?? 0.3;
    const maxEv = params.max_events ?? 40;
    const report = computeOverlap(mergeUtterances(bundle.segments), minOv);

    const lines: string[] = [];
    lines.push(`speaking time & turn-taking (clocked ${hhmmss(report.clocked)}):`);
    for (const s of report.speakers) {
      const pct = report.clocked ? Math.round((s.speakingSec / report.clocked) * 100) : 0;
      const gap = s.medianTurnGapSec == null ? "n/a" : `${s.medianTurnGapSec >= 0 ? "+" : ""}${s.medianTurnGapSec.toFixed(2)}s`;
      lines.push(`  ${s.speaker}: ${hhmmss(s.speakingSec)} (${pct}%)  utt=${s.utterances}  words=${s.words}  came-in-over=${s.startedOverOthers}  was-cut=${s.wasStartedOver}  median-entry-gap=${gap}`);
    }
    lines.push("");
    lines.push(`overlap events: ${report.events.length}  |  total collision: ${hhmmss(report.totalOverlapSec)}`);
    if (report.pairCounts.length) {
      lines.push("who-over-whom:");
      for (const p of report.pairCounts) lines.push(`  ${p.pair}: ${p.count}x (${p.totalSec.toFixed(1)}s)`);
    }
    lines.push("");
    lines.push(`events (first ${Math.min(maxEv, report.events.length)}):`);
    for (const e of report.events.slice(0, maxEv)) {
      const tag = e.yielded === e.interruptee ? "talk-over" : "false-start/backchannel";
      lines.push(`  [${hhmmss(e.at)}] ${e.interrupter} over ${e.interruptee} (${e.overlapSec}s, ${tag}) "${e.interrupterText}"`);
    }
    lines.push("");
    lines.push(`note: ${report.note}`);
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { speakers: report.speakers, pairCounts: report.pairCounts, totalOverlapSec: report.totalOverlapSec, eventCount: report.events.length },
    };
  },
});

// ── tool: video_metrics ───────────────────────────────────────────────────

const videoMetrics = defineTool({
  name: "video_metrics",
  promptSnippet: "video_metrics - speaking-style metrics over a cached bundle: rate/density/fillers, turn-gap distributions, per-pair gap matrix, and question-flow classification (self-answered vs assent vs elaboration).",
  promptGuidelines: [
    "Pass `bundle` (from video_extract) OR `file`.",
    "Gap percentiles matter more than the median: p25 exposes the fast tail that a median hides.",
    "Question outcomes are heuristic: 'self-answered' = no substantive other-speaker response within the window. Verify flagged instances against the transcript before asserting them.",
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
  }),
  async execute(_id, params, signal, onUpdate) {
    const emit = (m: string) => onUpdate?.({ content: [{ type: "text", text: m }] });
    let bundle: Bundle | null = null;
    if (params.bundle) bundle = readBundleByPath(params.bundle);
    if (!bundle && params.file) {
      const opts = extractOpts({ diarize: true });
      bundle = (await ensureBundle(params.file, opts, emit, signal)).bundle;
    }
    if (!bundle) throw new Error("provide `bundle` (from video_extract) or `file`");
    if (!bundle.hasWordSpeakers) throw new Error("bundle has no word-level speaker timing; re-run video_extract with diarize:true");

    const report = computeMetrics(mergeUtterances(bundle.segments), params.min_overlap_sec ?? 0.3);
    // re-run question analysis with a custom window when requested
    const events = params.question_window_sec != null ? analyzeQuestions(mergeUtterances(bundle.segments), params.question_window_sec) : report.questionEvents;
    const maxEv = params.max_events ?? 30;

    const fmtGap = (v: number | null) => (v == null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}s`);
    const lines: string[] = [];
    lines.push(`speaking-style metrics (clocked ${hhmmss(report.clocked)}):`);
    for (const s of report.speakers) {
      lines.push(
        `  ${s.speaker}: ${hhmmss(s.speakingSec)} (${s.sharePct}%)  utt=${s.utterances}  words=${s.words}  words/turn=${s.wordsPerTurn ?? "n/a"}  wpm=${s.wpm ?? "n/a"}  fillers/100w=${s.fillersPer100 ?? "n/a"}`,
      );
      lines.push(
        `    gap p25=${fmtGap(s.gapP25)} median=${fmtGap(s.gapMedian)} p75=${fmtGap(s.gapP75)}  came-in-over=${s.cameInOver}  was-cut=${s.wasCut}`,
      );
    }
    if (report.pairGaps.length) {
      lines.push("");
      lines.push("pair gap matrix (median, fastest first; >=3 samples):");
      for (const p of report.pairGaps) lines.push(`  ${p.pair}: ${fmtGap(p.medianGapSec)} (n=${p.samples})`);
    }
    if (report.questions.length) {
      lines.push("");
      lines.push("question flow:");
      for (const q of report.questions) {
        lines.push(
          `  ${q.asker}: ${q.questions} questions -> ${q.elaboration} elaborated, ${q.assent} assent, ${q.selfAnswered} self-answered, ${q.unanswered} unanswered`,
        );
      }
    }
    const selfAnswered = events.filter((e) => e.outcome === "self-answered");
    lines.push("");
    lines.push(`question events (first ${Math.min(maxEv, events.length)} of ${events.length}; ${selfAnswered.length} self-answered):`);
    for (const e of events.slice(0, maxEv)) {
      const resp = e.responder ? ` -> ${e.responder}${e.responseGapSec != null ? ` (${e.responseGapSec >= 0 ? "+" : ""}${e.responseGapSec}s)` : ""}: \"${e.responseSnippet}\"` : "";
      lines.push(`  [${hhmmss(e.at)}] ${e.asker} [${e.outcome}] \"${e.question}\"${resp}`);
    }
    lines.push("");
    lines.push(
      "note: gap p25 exposes the fast-entry tail the median hides. 'self-answered' means no substantive other-speaker response within the window - verify flagged instances against the transcript before asserting intent.",
    );
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { speakers: report.speakers, pairGaps: report.pairGaps, questions: report.questions, selfAnsweredCount: selfAnswered.length },
    };
  },
});

// ── tool: video_doc ───────────────────────────────────────────────────────

const videoDoc = defineTool({
  name: "video_doc",
  promptSnippet: "video_doc - assemble markdown-ready evidence (diarized transcript + visual timeline + overlap summary) from a cached bundle for you to write the doc.",
  promptGuidelines: [
    "Pass `bundle` (from video_extract) OR `file`.",
    "Returns SECTIONS for you to synthesise the final doc - it does not write prose itself.",
    "`include_transcript` can be large; it is timestamp+speaker prefixed. Use include_frames when frames were extracted.",
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
  }),
  async execute(_id, params, signal, onUpdate) {
    const emit = (m: string) => onUpdate?.({ content: [{ type: "text", text: m }] });
    let bundle: Bundle | null = null;
    if (params.bundle) bundle = readBundleByPath(params.bundle);
    if (!bundle && params.file) {
      const opts = extractOpts({ diarize: true, frames: params.include_frames ?? false });
      bundle = (await ensureBundle(params.file, opts, emit, signal)).bundle;
    }
    if (!bundle) throw new Error("provide `bundle` (from video_extract) or `file`");

    const wantTranscript = params.include_transcript ?? true;
    const wantFrames = (params.include_frames ?? true) && !!bundle.frames?.length;
    const wantOverlap = (params.include_overlap ?? true) && bundle.hasWordSpeakers;

    const md: string[] = [];
    md.push(`## Source`);
    md.push(`- file: \`${bundle.file}\``);
    md.push(`- duration: ${hhmmss(bundle.duration)}`);
    md.push(`- speakers: ${bundle.speakers.join(", ") || "(none)"}`);
    md.push("");

    if (wantOverlap) {
      const report = computeOverlap(mergeUtterances(bundle.segments));
      md.push(`## Speaking time`);
      for (const s of report.speakers) {
        const pct = report.clocked ? Math.round((s.speakingSec / report.clocked) * 100) : 0;
        md.push(`- ${s.speaker}: ${hhmmss(s.speakingSec)} (${pct}%), ${s.utterances} turns`);
      }
      md.push("");
      md.push(`## Overlaps (objective)`);
      md.push(`- total collision: ${hhmmss(report.totalOverlapSec)} across ${report.events.length} events`);
      for (const p of report.pairCounts.slice(0, 10)) md.push(`- ${p.pair}: ${p.count}x`);
      md.push("");
    }

    if (wantFrames) {
      md.push(`## Visual timeline`);
      for (const f of bundle.frames!) md.push(`- [${hhmmss(f.timestamp)}] ${f.text.replace(/\s+/g, " ").trim()}`);
      md.push("");
    }

    if (wantTranscript) {
      const speakerFilter = params.speaker ? new Set(params.speaker.split(",").map((s) => s.trim()).filter(Boolean)) : null;
      const startS = params.start ?? -Infinity;
      const endS = params.end ?? Infinity;
      const tsegs = bundle.segments.filter(
        (s) => s.end >= startS && s.start <= endS && (!speakerFilter || (s.speaker != null && speakerFilter.has(s.speaker))),
      );
      md.push(`## Transcript`);
      if (speakerFilter || params.start != null || params.end != null) {
        md.push(`(filtered${speakerFilter ? ` speakers: ${[...speakerFilter].join(", ")}` : ""}${params.start != null ? ` from ${hhmmss(params.start)}` : ""}${params.end != null ? ` to ${hhmmss(params.end)}` : ""} - ${tsegs.length} of ${bundle.segments.length} segments)`);
      }
      for (const seg of tsegs) {
        const sp = seg.speaker ? `[${seg.speaker}] ` : "";
        md.push(`[${hhmmss(seg.start)}] ${sp}${seg.text.trim()}`);
      }
      md.push("");
    }

    return { content: [{ type: "text", text: md.join("\n") }], details: { file: bundle.file, duration: bundle.duration, speakers: bundle.speakers } };
  },
});

// ── name-map parsing (pure) ───────────────────────────────────────────────

/**
 * Parse a name map from either JSON ({"SPEAKER_00":"Erfi"}) or a compact
 * comma/newline-separated k=v form ("SPEAKER_00=Erfi, M-SPEAKER_01=Alice").
 * Returns {} on empty / unparseable input.
 */
export function parseNameMap(input: string): Record<string, string> {
  const s = (input ?? "").trim();
  if (!s) return {};
  if (s.startsWith("{")) {
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(o)) if (v != null) out[k] = String(v);
      return out;
    } catch {
      return {};
    }
  }
  const out: Record<string, string> = {};
  for (const pair of s.split(/[,\n]/)) {
    const m = pair.split("=");
    if (m.length >= 2) {
      const k = m[0].trim();
      const v = m.slice(1).join("=").trim();
      if (k && v) out[k] = v;
    }
  }
  return out;
}

// ── voice-print HTTP (server-side store) ──────────────────────────────────

interface VoicePrintInfo {
  name: string;
  count: number;
}
async function listVoiceprints(signal: AbortSignal | undefined): Promise<VoicePrintInfo[]> {
  const r = (await whisperGet("/api/voiceprints", signal).then((x) => x.json())) as { voiceprints?: VoicePrintInfo[] };
  return r.voiceprints ?? [];
}

// ── tool: video_enroll ────────────────────────────────────────────────────

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
  async execute(_id, params, signal) {
    const action = params.action ?? "add";
    if (action === "list") {
      const vps = await listVoiceprints(signal);
      const text = vps.length ? vps.map((v) => `  ${v.name} (${v.count} print${v.count === 1 ? "" : "s"})`).join("\n") : "(no voice prints enrolled)";
      return { content: [{ type: "text", text: `enrolled voice prints:\n${text}` }], details: { voiceprints: vps } };
    }
    if (action === "remove") {
      if (!params.name) throw new Error("remove requires `name`");
      const r = await fetch(`${WHISPER_URL}/api/voiceprints/${encodeURIComponent(params.name)}`, { method: "DELETE", signal });
      if (!r.ok) throw new Error(`remove failed: HTTP ${r.status}`);
      return { content: [{ type: "text", text: `removed voice print: ${params.name}` }], details: { removed: params.name } };
    }
    // add
    if (!params.name) throw new Error("add requires `name`");
    let body: Record<string, unknown>;
    if (params.bundle) {
      const b = readBundleByPath(params.bundle);
      if (!b) throw new Error(`bundle not found: ${params.bundle}`);
      if (!params.speaker) throw new Error("add-from-bundle requires `speaker` (a diarized label or display name)");
      const hit = resolveEmbedding(b, params.speaker);
      if (!hit) {
        const labels = Object.keys(b.speakerEmbeddings ?? {});
        const names = Object.entries(b.names ?? {}).map(([l, n]) => `${n} (label ${l})`);
        const avail = [...labels, ...names].join(", ") || "(none - was the bundle diarized?)";
        throw new Error(`no embedding for speaker "${params.speaker}". Available: ${avail}`);
      }
      body = { name: params.name, embedding: hit.vec, source: `${b.file}#${hit.label}` };
    } else if (params.file) {
      const serverPath = await resolveToServerPath(params.file, signal);
      body = { name: params.name, file_path: serverPath, start: params.start, end: params.end };
    } else {
      throw new Error("add requires either `bundle`+`speaker` or `file`");
    }
    const res = await whisperPostJson<{ name: string; count: number; dim?: number }>("/api/voiceprints", body, signal);
    return {
      content: [{ type: "text", text: `enrolled "${res.name}" (now ${res.count} reference print${res.count === 1 ? "" : "s"}). Future diarized transcripts will auto-name this speaker.` }],
      details: res,
    };
  },
});

// ── tool: video_name ──────────────────────────────────────────────────────

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
  async execute(_id, params, signal) {
    const b = readBundleByPath(params.bundle);
    if (!b) throw new Error(`bundle not found: ${params.bundle}`);
    const map = parseNameMap(params.map);
    if (!Object.keys(map).length) throw new Error("empty/unparseable map - use JSON or 'LABEL=Name, ...'");
    const before = [...b.speakers];
    applyNameMap(b, map);
    // persist back to the same cache file
    const key = bundleKeyFromPath(params.bundle);
    writeBundle(key, b);
    const lines = [`relabeled: ${Object.entries(map).map(([k, v]) => `${k} -> ${v}`).join(", ")}`, `speakers now: ${b.speakers.join(", ")}`, `(was: ${before.join(", ")})`];
    if (params.enroll) {
      const names = [...new Set(Object.values(map))];
      for (const name of names) {
        const hit = resolveEmbedding(b, name);
        if (!hit) {
          lines.push(`enroll ${name}: FAILED (no embedding for that speaker)`);
          continue;
        }
        try {
          const res = await whisperPostJson<{ name: string; count: number }>("/api/voiceprints", { name, embedding: hit.vec, source: `${b.file}#${hit.label}` }, signal);
          lines.push(`enroll ${name}: ok (${res.count} print${res.count === 1 ? "" : "s"})`);
        } catch (e) {
          lines.push(`enroll ${name}: FAILED (${e instanceof Error ? e.message : String(e)})`);
        }
      }
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { map, speakers: b.speakers },
    };
  },
});

// ── bundle-path helpers ───────────────────────────────────────────────────

// A bundle arg may be a full cache path or a bare key; support both.
function bundleKeyFromPath(p: string): string {
  const base = p.split("/").pop() ?? p;
  return base.replace(/\.json$/, "");
}
function readBundleByPath(p: string): Bundle | null {
  try {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as Bundle;
  } catch {
    /* fall through */
  }
  return readBundle(bundleKeyFromPath(p));
}

// ── register ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool(videoExtract);
  pi.registerTool(videoOverlap);
  pi.registerTool(videoMetrics);
  pi.registerTool(videoDoc);
  pi.registerTool(videoEnroll);
  pi.registerTool(videoName);
}
