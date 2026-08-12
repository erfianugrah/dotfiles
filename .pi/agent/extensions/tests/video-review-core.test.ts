/**
 * video-review-core unit tests - pure request/arg building, transcript+segment
 * projection, conversation math, and the compact-summary rendering path via the
 * orchestrator over a FIXTURE bundle written to a temp dir. No network / no
 * whisper server: the live extract + voice-print HTTP paths are covered by the
 * pi e2e suite / marked [blocked: needs whisper :7860] in the port doc.
 *
 *   bun test extensions/tests/video-review-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveMediaPath,
  bundleCacheKey,
  extractOpts,
  isExternalMedia,
  suggestFormat,
  hhmmss,
  mergeUtterances,
  computeOverlap,
  computeMetrics,
  parseNameMap,
  applyNameMap,
  resolveEmbedding,
  countFillers,
  isAssent,
  analyzeQuestions,
  runVideoReview,
  type Segment,
  type Bundle,
} from "../lib/video-review-core.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

function seg(speaker: string, words: [string, number, number][]): Segment {
  return {
    start: words[0][1],
    end: words[words.length - 1][2],
    text: words.map((w) => w[0]).join(" "),
    speaker,
    words: words.map(([word, start, end]) => ({ word, start, end, speaker })),
  };
}

/** A realistic diarized bundle: A talks, B comes in over A (talk-over), then
 * A asks a question B elaborates on. */
function fixtureBundle(): Bundle {
  const segments = [
    seg("Erfi", [["so", 0, 0.4], ["what", 0.4, 0.8], ["is", 0.8, 1.0], ["your", 1.0, 1.3], ["workflow", 1.3, 2.0]]),
    seg("M-SPEAKER_01", [["well", 2.2, 2.6], ["i", 2.6, 2.8], ["use", 2.8, 3.1], ["a", 3.1, 3.2], ["bunch", 3.2, 3.6], ["of", 3.6, 3.8], ["agents", 3.8, 4.4]]),
    seg("Erfi", [["right", 3.6, 4.0], ["got", 4.0, 4.4], ["it", 4.4, 5.1]]), // starts inside B's utterance (ends 4.4) -> >=0.3s overlap
  ];
  return {
    file: "/media/call.mkv",
    language: "",
    duration: 5.1,
    segments,
    speakers: ["Erfi", "M-SPEAKER_01"],
    hasWordSpeakers: true,
    speakerEmbeddings: { Erfi: [1, 0], "M-SPEAKER_01": [0, 1] },
    createdAt: "2026-08-12T00:00:00.000Z",
    params: {},
  };
}

function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "vr-core-test-"));
  const p = join(dir, "bundle.json");
  writeFileSync(p, JSON.stringify(fixtureBundle()));
  return p;
}

// ── request / arg building (pure) ─────────────────────────────────────────

describe("video-review-core.resolveMediaPath", () => {
  const files = [
    { name: "2026-standup.mkv", path: "/media/2026-standup.mkv" },
    { name: "demo-call.mp4", path: "/media/demo-call.mp4" },
  ];
  test("server paths pass through untouched", () => {
    expect(resolveMediaPath("/media/x.mkv", files)).toBe("/media/x.mkv");
    expect(resolveMediaPath("/tmp/yt-dlp-1/v.webm", files)).toBe("/tmp/yt-dlp-1/v.webm");
  });
  test("'latest'/'newest' -> first (newest-first) media entry", () => {
    expect(resolveMediaPath("latest", files)).toBe("/media/2026-standup.mkv");
    expect(resolveMediaPath("newest", files)).toBe("/media/2026-standup.mkv");
  });
  test("substring match, case-insensitive; null on miss / empty", () => {
    expect(resolveMediaPath("DEMO", files)).toBe("/media/demo-call.mp4");
    expect(resolveMediaPath("nope", files)).toBeNull();
    expect(resolveMediaPath("", files)).toBeNull();
  });
});

describe("video-review-core.bundleCacheKey", () => {
  test("stable + params-sensitive", () => {
    const a = bundleCacheKey("/media/x.mkv", { diarize: true });
    const b = bundleCacheKey("/media/x.mkv", { diarize: true });
    const c = bundleCacheKey("/media/x.mkv", { diarize: false });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("video-review-core.extractOpts", () => {
  test("applies defaults", () => {
    const o = extractOpts({});
    expect(o.diarize).toBe(true);
    expect(o.frames).toBe(false);
    expect(o.language).toBe("Auto-detect");
    expect(o.translate).toBe("auto");
    expect(o.timeoutMs).toBe(1800 * 1000);
  });
  test("honours overrides incl. timeout_sec -> ms", () => {
    const o = extractOpts({ diarize: false, frames: true, timeout_sec: 30, format: "review" });
    expect(o.diarize).toBe(false);
    expect(o.frames).toBe(true);
    expect(o.timeoutMs).toBe(30_000);
    expect(o.format).toBe("review");
  });
});

describe("video-review-core.isExternalMedia / suggestFormat / hhmmss", () => {
  test("isExternalMedia flags yt-dlp temp downloads only", () => {
    expect(isExternalMedia("/tmp/yt-dlp-abc/v.webm")).toBe(true);
    expect(isExternalMedia("/media/call.mkv")).toBe(false);
  });
  test("suggestFormat heuristics", () => {
    expect(suggestFormat(new Map([["Erfi", 100], ["Alice", 100]]), 200)).toBe("1:1");
    expect(suggestFormat(new Map([["Erfi", 180], ["SPEAKER_01", 20]]), 200)).toBe("customer");
    expect(suggestFormat(new Map(), 0)).toBeNull();
  });
  test("hhmmss formats with/without hours", () => {
    expect(hhmmss(65)).toBe("1:05");
    expect(hhmmss(3661)).toBe("1:01:01");
    expect(hhmmss(-5)).toBe("0:00");
  });
});

// ── transcript / segment projection (pure) ────────────────────────────────

describe("video-review-core.mergeUtterances + computeOverlap", () => {
  test("merges words to utterances and detects the talk-over", () => {
    const b = fixtureBundle();
    const utts = mergeUtterances(b.segments);
    expect(utts.map((u) => u.speaker)).toEqual(["Erfi", "M-SPEAKER_01", "Erfi"]);
    const r = computeOverlap(utts, 0.3);
    // Erfi's 3rd utterance (4.2) starts inside M-SPEAKER_01's utterance ending 4.4
    const ev = r.events.find((e) => e.interrupter === "Erfi" && e.interruptee === "M-SPEAKER_01");
    expect(ev).toBeTruthy();
    expect(r.clocked).toBeGreaterThan(0);
  });
});

describe("video-review-core.computeMetrics", () => {
  test("projects per-speaker delivery + question flow over the fixture", () => {
    const utts = mergeUtterances(fixtureBundle().segments);
    const m = computeMetrics(utts, 0.3);
    expect(m.speakers.length).toBe(2);
    const erfi = m.speakers.find((s) => s.speaker === "Erfi")!;
    expect(erfi.words).toBeGreaterThan(0);
    expect(erfi.sharePct).toBeGreaterThanOrEqual(0);
  });
});

describe("video-review-core question helpers", () => {
  test("countFillers counts single + multi-word", () => {
    expect(countFillers("um so basically I mean you know it's fine")).toBe(4);
  });
  test("isAssent short-ack vs substantive", () => {
    expect(isAssent("yeah exactly", 2)).toBe(true);
    expect(isAssent("yeah but we actually query it a lot", 8)).toBe(false);
  });
  test("analyzeQuestions elaboration outcome", () => {
    const ev = analyzeQuestions([
      { speaker: "A", start: 0, end: 1, wordCount: 6, text: "what is your workflow right now?" },
      { speaker: "B", start: 2, end: 6, wordCount: 11, text: "well I use a bunch of agents and a runbook for everything" },
    ]);
    expect(ev[0].outcome).toBe("elaboration");
    expect(ev[0].responder).toBe("B");
  });
});

// ── name-map projection (pure) ────────────────────────────────────────────

describe("video-review-core name mapping", () => {
  test("parseNameMap JSON + compact forms", () => {
    expect(parseNameMap('{"A":"Erfi"}')).toEqual({ A: "Erfi" });
    expect(parseNameMap("A=Erfi, B=Bob")).toEqual({ A: "Erfi", B: "Bob" });
  });
  test("applyNameMap rewrites speakers but keeps embedding keys stable", () => {
    const b = fixtureBundle();
    applyNameMap(b, { "M-SPEAKER_01": "Alice" });
    expect(b.speakers).toContain("Alice");
    expect(b.speakerEmbeddings!["M-SPEAKER_01"]).toEqual([0, 1]);
    expect(resolveEmbedding(b, "Alice")).toEqual({ label: "M-SPEAKER_01", vec: [0, 1] });
  });
});

// ── orchestrator: compact-summary rendering over a fixture bundle ──────────
// These exercise the doc/overlap/metrics/name dispatch WITHOUT the whisper
// server, by pointing `bundle` at an on-disk fixture. The extract + enroll
// actions require whisper :7860 and are marked needs-credentials.

describe("video-review-core.runVideoReview (bundle-backed, no network)", () => {
  test("action:doc assembles a markdown evidence bundle", async () => {
    const p = writeFixture();
    const r = await runVideoReview({ action: "doc", bundle: p });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("## Source");
    expect(r.text).toContain("## Speaking time");
    expect(r.text).toContain("## Overlaps (objective)");
    expect(r.text).toContain("## Transcript");
    expect(r.text).toContain("[Erfi]");
  });

  test("action:overlap renders the compact conversation report", async () => {
    const p = writeFixture();
    const r = await runVideoReview({ action: "overlap", bundle: p });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("speaking time & turn-taking");
    expect(r.text).toContain("overlap events:");
    expect((r.details as { eventCount: number }).eventCount).toBeGreaterThanOrEqual(1);
  });

  test("action:metrics renders speaking-style metrics", async () => {
    const p = writeFixture();
    const r = await runVideoReview({ action: "metrics", bundle: p });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("speaking-style metrics");
    expect((r.details as { speakers: unknown[] }).speakers.length).toBe(2);
  });

  test("action:name relabels the cached bundle in place", async () => {
    const p = writeFixture();
    const r = await runVideoReview({ action: "name", bundle: p, map: "M-SPEAKER_01=Alice" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("M-SPEAKER_01 -> Alice");
    expect((r.details as { speakers: string[] }).speakers).toContain("Alice");
    expect(r.text).toContain("speakers now: Alice, Erfi");
  });

  test("missing bundle / unknown action produce isError results (no throw)", async () => {
    expect((await runVideoReview({ action: "doc", bundle: "/nope/missing.json" })).isError).toBe(true);
    expect((await runVideoReview({ action: "name", bundle: "/x" })).isError).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((await runVideoReview({ action: "bogus" as any })).isError).toBe(true);
  });
});
