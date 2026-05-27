/**
 * clipboard-image-shrink — auto-downscale pasted clipboard images before
 * they enter the model context.
 *
 * Why this exists
 * ───────────────
 * When you paste an image into pi's TUI, the binary writes the full bytes
 * to `/tmp/pi-clipboard-<uuid>.<ext>` and inserts that path into the
 * editor. A typical screenshot off a 2560×1400 panel is ~4.8 megapixels,
 * which costs ~6× more image tokens than the 1280×700 the model actually
 * needs to read the contents. Worse, when pi later prunes the image bytes
 * from history to save context, the agent's only recovery is to re-read
 * the file — and a huge file re-read just gets pruned again, triggering a
 * manual `magick` resize dance in the agent's bash:
 *
 *     $ magick pi-clipboard-...png -resize 1280x700 -quality 75 clip-small.jpg
 *     $ read /tmp/clip-small.jpg
 *
 * This extension fires that dance once, automatically, on the *original*
 * paste, before the LLM ever sees the image. The agent reads a sensible
 * 1280-edge file from the start.
 *
 * How it works
 * ────────────
 * Hooks the `input` event, scans `event.text` for `/tmp/pi-clipboard-*`
 * paths, stats each one. If it's over the size or resolution threshold,
 * runs `magick <orig> -resize 1568x1568>` into a sibling `<orig>-small.<ext>`
 * file (the `>` flag means "only shrink if larger than target"). Rewrites
 * the path in `event.text` to point at the shrunk file and emits a brief
 * `ctx.ui.notify` so the user knows what happened.
 *
 * Why 1568? Anthropic's vision pipeline downscales any image to ~1568px on
 * the longest edge (~1.15 MP cap) before the visual encoder runs. Matching
 * that ceiling client-side means the LLM sees the EXACT same pixels it
 * would have from a full-res paste — zero accuracy loss — while the file
 * on disk is small enough to survive image-prune+reread cycles.
 *
 * Tunables (constants below):
 *   - MAX_EDGE_PX     trip threshold: shrink if width OR height >  this
 *   - MAX_BYTES       trip threshold: shrink if filesize        >  this
 *   - TARGET_EDGE_PX  output cap: longest edge after resize
 *
 * Preserves the source PNG/JPG extension — no JPG conversion on PNG
 * screenshots (text aliasing suffers when re-encoded to JPG). Most of the
 * size win is from the resolution drop alone.
 *
 * Safe behavior:
 *   - File missing → silently skip (path looked clipboard-shaped but isn't)
 *   - magick missing → one-time warn, then no-op forever
 *   - magick error → notify + leave original path in place
 *   - Already-shrunk file exists (idempotent rerun) → skip magick, just
 *     rewrite path
 *   - Multiple references to the same path in one message → dedupe
 *   - source !== "interactive" → skip (extension-injected paths shouldn't
 *     be rewritten under the user's feet)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

// ── tunables ──────────────────────────────────────────────────────────────

// Anthropic's vision pipeline already downscales any image to ~1568px on the
// longest edge (~1.15 MP cap) before the visual encoder sees it. Targeting
// 1568 here means the LLM sees the SAME pixels it would have seen from a
// full-res paste — we're just moving Claude's own resize client-side so the
// file on disk stays small for re-reads after image-prune. Zero accuracy
// cost vs the full-res paste; ~30% image-token savings still apply because
// the upstream raw bytes never enter context.
const MAX_EDGE_PX = 1700;        // shrink trip: >1700 on either edge
const MAX_BYTES = 400 * 1024;    // shrink trip: >400KB on disk
const TARGET_EDGE_PX = 1568;     // output cap: longest edge after resize (matches Claude's native ceiling)
const SUFFIX = "-small";         // sibling filename suffix

// Regex: `/tmp/pi-clipboard-<UUID>.<ext>`. UUID = 8-4-4-4-12 hex with dashes.
// Extension list mirrors what pi can paste (see pi binary: extensionForImageMimeType).
const CLIP_PATH_RE =
  /\/tmp\/pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|jpeg|webp|gif)/gi;

// ── magick wrappers ───────────────────────────────────────────────────────

let magickWarned = false;

/** Resolve path to `magick` once. Cached for the session. */
let magickPath: string | null | undefined;
function findMagick(): string | null {
  if (magickPath !== undefined) return magickPath;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = `${dir}/magick`;
    if (existsSync(p)) {
      magickPath = p;
      return p;
    }
  }
  magickPath = null;
  return null;
}

interface Dimensions {
  w: number;
  h: number;
}

/** Probe a file's pixel dimensions via `magick identify`. Null on failure. */
export function probeDimensions(file: string, magick: string): Dimensions | null {
  const r = spawnSync(magick, ["identify", "-format", "%w %h", file], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (r.status !== 0 || !r.stdout) return null;
  const m = r.stdout.trim().match(/^(\d+)\s+(\d+)/);
  if (!m) return null;
  return { w: Number.parseInt(m[1], 10), h: Number.parseInt(m[2], 10) };
}

/** Run `magick <src> -resize TARGETxTARGET> <dst>`. Returns true on success. */
function runShrink(src: string, dst: string, magick: string): boolean {
  // `>` modifier = only shrink if larger than target on either axis. Aspect
  // ratio preserved by default.
  const geom = `${TARGET_EDGE_PX}x${TARGET_EDGE_PX}>`;
  const r = spawnSync(magick, [src, "-resize", geom, dst], {
    timeout: 15_000,
  });
  return r.status === 0;
}

// ── decision logic ────────────────────────────────────────────────────────

export interface ShrinkDecision {
  /** Path to feed the LLM. Same as input if no shrink applied. */
  outPath: string;
  /** True if a magick run happened OR a sibling already existed. */
  shrunk: boolean;
  /** Bytes before, bytes after (for the toast). 0 if no shrink. */
  before: number;
  after: number;
  /** Original WxH before shrink. null if probe failed. */
  origDims: Dimensions | null;
  /** Warning / error to surface, if any. */
  warn?: string;
}

/** Compute the sibling shrunk path: `/tmp/pi-clipboard-X.png` → `…-small.png`. */
export function shrunkSibling(p: string): string {
  const ext = path.extname(p);
  const stem = p.slice(0, -ext.length);
  return `${stem}${SUFFIX}${ext}`;
}

/**
 * Inspect one clipboard path, shrink if oversized, return what to use.
 * Pure-ish: side effects are only the magick subprocess and disk write.
 */
export function shrinkOne(srcPath: string, magick: string | null): ShrinkDecision {
  const noop: ShrinkDecision = {
    outPath: srcPath,
    shrunk: false,
    before: 0,
    after: 0,
    origDims: null,
  };

  if (!existsSync(srcPath)) return noop;

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(srcPath);
  } catch {
    return noop;
  }
  if (!st.isFile()) return noop;

  // Cheap byte threshold first — avoids magick on small files.
  const oversizeByBytes = st.size > MAX_BYTES;

  if (!magick) {
    if (oversizeByBytes) {
      return { ...noop, warn: "magick not on PATH — install imagemagick to auto-shrink" };
    }
    return noop;
  }

  const dims = probeDimensions(srcPath, magick);
  const oversizeByEdge = dims !== null && (dims.w > MAX_EDGE_PX || dims.h > MAX_EDGE_PX);

  if (!oversizeByBytes && !oversizeByEdge) return noop;

  const dst = shrunkSibling(srcPath);

  // Idempotency: if the sibling already exists and is newer than the source,
  // reuse it — paste-then-edit-then-resend produces the same path.
  if (existsSync(dst)) {
    try {
      const dstSt = statSync(dst);
      if (dstSt.mtimeMs >= st.mtimeMs) {
        return {
          outPath: dst,
          shrunk: true,
          before: st.size,
          after: dstSt.size,
          origDims: dims,
        };
      }
    } catch {
      // fall through and re-shrink
    }
  }

  const ok = runShrink(srcPath, dst, magick);
  if (!ok) {
    return { ...noop, warn: `magick failed on ${path.basename(srcPath)}` };
  }

  let afterSize = 0;
  try {
    afterSize = statSync(dst).size;
  } catch {
    /* shouldn't happen, but no-op */
  }

  return {
    outPath: dst,
    shrunk: true,
    before: st.size,
    after: afterSize,
    origDims: dims,
  };
}

// ── text rewrite ──────────────────────────────────────────────────────────

export interface RewriteResult {
  /** Rewritten message text (same as input if nothing shrunk). */
  text: string;
  /** Per-path decisions, in encounter order. */
  decisions: Array<{ src: string; decision: ShrinkDecision }>;
}

/**
 * Find every clipboard path in `text`, shrink oversized ones, and produce
 * rewritten text. Deduplicates paths so each unique file runs magick at
 * most once per message.
 */
export function rewriteClipboardPaths(text: string, magick: string | null): RewriteResult {
  const seen = new Map<string, ShrinkDecision>();
  // Iterate matches first to collect uniques (so we shrink each once).
  for (const m of text.matchAll(CLIP_PATH_RE)) {
    const src = m[0];
    if (seen.has(src)) continue;
    seen.set(src, shrinkOne(src, magick));
  }

  let out = text;
  const decisions: RewriteResult["decisions"] = [];
  for (const [src, decision] of seen.entries()) {
    decisions.push({ src, decision });
    if (decision.shrunk && decision.outPath !== src) {
      // Replace every occurrence. The path is UUID-unique so global replace
      // is safe — no substring collisions with other clipboard files.
      out = out.split(src).join(decision.outPath);
    }
  }
  return { text: out, decisions };
}

// ── toast formatting ──────────────────────────────────────────────────────

function fmtKB(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return `${n}B`;
}

function summarize(decisions: RewriteResult["decisions"]): {
  msg: string;
  level: "info" | "warning";
} | null {
  const shrunk = decisions.filter((d) => d.decision.shrunk);
  const warns = decisions
    .map((d) => d.decision.warn)
    .filter((w): w is string => Boolean(w));

  if (shrunk.length === 0 && warns.length === 0) return null;

  const parts: string[] = [];
  for (const { decision } of shrunk) {
    const dims = decision.origDims;
    const dimPart = dims ? `${dims.w}×${dims.h} ` : "";
    parts.push(
      `shrunk ${dimPart}${fmtKB(decision.before)} → ${TARGET_EDGE_PX}px ${fmtKB(decision.after)}`,
    );
  }
  for (const w of warns) parts.push(`⚠ ${w}`);

  return {
    msg: `clipboard-image-shrink: ${parts.join("; ")}`,
    level: warns.length > 0 ? "warning" : "info",
  };
}

// ── extension entry ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    // Don't rewrite paths inside extension-injected messages — could be a
    // round-tripped path the injecting extension wants intact.
    if (event.source === "extension") return { action: "continue" };

    // Fast path: no clipboard path → nothing to do. Cheap regex pre-check.
    if (!event.text.includes("/tmp/pi-clipboard-")) return { action: "continue" };

    const magick = findMagick();
    if (!magick && !magickWarned) {
      magickWarned = true;
      ctx.ui.notify(
        "clipboard-image-shrink: `magick` not on PATH — pasted images won't be auto-shrunk. apt install imagemagick.",
        "warning",
      );
    }

    const { text, decisions } = rewriteClipboardPaths(event.text, magick);
    const summary = summarize(decisions);
    if (summary) ctx.ui.notify(summary.msg, summary.level);

    if (text === event.text) return { action: "continue" };
    return { action: "transform", text };
  });
}
