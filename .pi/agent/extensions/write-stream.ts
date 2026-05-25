/**
 * write_stream — chunked file writes for content above the tool-call input
 * ceiling.
 *
 * Why this exists: Bedrock (and certain Claude proxies / Anthropic-direct
 * paths under load) return generic 500 "Internal server error" responses
 * when a single tool-use input exceeds ~80-100 KB. The standard `write`
 * tool packs the entire file content into one tool-call argument, so any
 * file above that ceiling silently fails — pi's relay swallows the
 * upstream 500 and the agent quietly moves on, leaving an empty / missing
 * file on disk. The same ceiling applies to `apply_patch` Add-File and
 * `edit` on big files; that's why AGENTS.md already says >1000 lines /
 * >100 KB go through sd/sed/ast-grep. This tool extends the same
 * principle to NEW-file writes.
 *
 * opencode parity: opencode has no equivalent. Its `write` is single-shot
 * and hits the same ceiling.
 *
 * Design:
 *   • One tool, one workflow. The agent passes `chunk: "first" | "middle"
 *     | "last" | "only"` to signal stream lifecycle. No stream-id, no
 *     in-memory state — the sidecar temp file IS the state, derived
 *     deterministically from the target path. Survives pi restarts.
 *   • Per-chunk size cap: 75_000 bytes (hard error above 80_000; warn
 *     above 60_000). Well below the observed Bedrock ceiling so even with
 *     a chatty surrounding turn the request never goes over.
 *   • Atomic finalize: chunks accumulate in `<path>.write-stream.tmp`;
 *     "last" appends then renames over the target. POSIX rename within
 *     a single filesystem is atomic — a crash leaves either old or new,
 *     never a partial.
 *   • "first" truncates any pre-existing sidecar (recovery from a prior
 *     aborted stream is automatic — just start again).
 *   • "only" is a single-call atomic write; equivalent to `write` but
 *     gated by the same size cap so the agent gets a clean error instead
 *     of an upstream 500 if it underestimates content size.
 *
 * Sequence for a 250 KB file:
 *   write_stream(path="/x.md", content=<60KB>, chunk="first")
 *   write_stream(path="/x.md", content=<60KB>, chunk="middle")
 *   write_stream(path="/x.md", content=<60KB>, chunk="middle")
 *   write_stream(path="/x.md", content=<70KB>, chunk="last")
 *
 * The result message after "last" tells the agent the final byte count
 * and line count so it can sanity-check vs. its mental model.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  appendFile,
  mkdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve as pathResolve } from "node:path";

// ── tunables ──────────────────────────────────────────────────────────────

/** Hard cap per chunk. Above this the tool errors and tells the agent to
 *  split further. Calibrated below the observed Bedrock ~80-100 KB
 *  failure threshold with margin for surrounding turn payload. */
export const HARD_CAP_BYTES = 80_000;

/** Soft warn threshold — included in the success message so the agent
 *  knows it's flirting with the limit and should consider smaller chunks. */
export const SOFT_WARN_BYTES = 60_000;

/** Sidecar suffix appended to the target path while streaming. */
export const SIDECAR_SUFFIX = ".write-stream.tmp";

// ── helpers ───────────────────────────────────────────────────────────────

export type ChunkMode = "only" | "first" | "middle" | "last";

export function sidecarPath(target: string): string {
  return `${target}${SIDECAR_SUFFIX}`;
}

function humanBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Pure validation helper. Returns an error string or null if OK. Exported
 *  for unit testing the state-machine rules without filesystem effects. */
export function validateChunk(
  chunk: ChunkMode,
  contentBytes: number,
  sidecarExists: boolean,
  targetExists: boolean,
): string | null {
  if (contentBytes > HARD_CAP_BYTES) {
    return (
      `chunk content is ${humanBytes(contentBytes)} — above the ${humanBytes(HARD_CAP_BYTES)} per-chunk cap. ` +
      `Split this chunk further (aim for ≤${humanBytes(SOFT_WARN_BYTES)} each) and resend.`
    );
  }

  if (chunk === "only") {
    // Single-shot. No stream state required. Target may or may not exist
    // (overwrite is fine — matches `write` semantics).
    if (sidecarExists) {
      return (
        `chunk="only" but a stream sidecar already exists for this path ` +
        `(${SIDECAR_SUFFIX}). Either finish the existing stream with chunk="last", ` +
        `or restart with chunk="first" to truncate.`
      );
    }
    return null;
  }

  if (chunk === "first") {
    // Pre-existing sidecar is fine — we'll truncate it. Pre-existing target
    // is also fine — final rename overwrites.
    return null;
  }

  // middle / last require a live sidecar
  if (!sidecarExists) {
    return (
      `chunk="${chunk}" but no stream sidecar exists for this path. ` +
      `Start the stream with chunk="first" before sending middle/last chunks.`
    );
  }
  // Acknowledge target existence isn't required for middle/last; suppress lint.
  void targetExists;
  return null;
}

// ── tool ──────────────────────────────────────────────────────────────────

const writeStreamTool = defineTool({
  name: "write_stream",
  label: "Write Stream",
  promptSnippet:
    "write_stream — chunked atomic file write. Use for any new-file content >60KB to avoid the upstream tool-call-input 500. " +
    "chunk: 'only' (single-shot) | 'first' | 'middle' | 'last'.",
  promptGuidelines: [
    "Each chunk MUST be ≤60KB. Hard cap is 80KB; above that returns an error.",
    "Use chunk='only' for single-shot writes <60KB. Otherwise: first → middle… → last.",
    "Atomic: content lands in <path>.write-stream.tmp until chunk='last' renames it over the target.",
    "If a stream is interrupted, restart with chunk='first' — it truncates any prior sidecar.",
  ],
  description: [
    "Atomic chunked file write. Solves the upstream tool-call-input 500 that hits `write` on files above ~80-100KB.",
    "",
    "Workflow:",
    "  chunk='only'   — single-shot write of all content in one call (equivalent to `write`, but size-capped).",
    "  chunk='first'  — start a stream. Creates `<path>.write-stream.tmp` and writes this chunk (truncating any prior sidecar).",
    "  chunk='middle' — append this chunk to the sidecar. Repeat as many times as needed.",
    "  chunk='last'   — append this final chunk, then atomically rename the sidecar over `path`.",
    "",
    "Per-chunk cap: 80KB hard error, 60KB soft warn. Final file size is unbounded (only chunk size is capped).",
    "Re-running chunk='first' on an in-progress stream truncates it — use this to recover after an aborted stream.",
  ].join("\n"),
  parameters: Type.Object({
    path: Type.String({
      description:
        "Target file path. Relative paths resolve against the session cwd. Parent directories are created on demand.",
    }),
    content: Type.String({
      description:
        "Content for THIS chunk only (not the whole file). Must be ≤80KB; aim for ≤60KB.",
    }),
    chunk: Type.Union(
      [
        Type.Literal("only"),
        Type.Literal("first"),
        Type.Literal("middle"),
        Type.Literal("last"),
      ],
      {
        description:
          "Stream lifecycle position. 'only' = single-call write. 'first'/'middle'/'last' = multi-call stream. Default 'only'.",
        default: "only",
      },
    ),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const targetAbs = isAbsolute(params.path)
      ? params.path
      : pathResolve(ctx.cwd, params.path);
    const tmp = sidecarPath(targetAbs);
    const chunkMode: ChunkMode = params.chunk ?? "only";
    const contentBytes = Buffer.byteLength(params.content, "utf-8");

    const sidecarExisted = await exists(tmp);
    const targetExisted = await exists(targetAbs);

    const validationErr = validateChunk(
      chunkMode,
      contentBytes,
      sidecarExisted,
      targetExisted,
    );
    if (validationErr) {
      return {
        isError: true,
        content: [{ type: "text", text: `write_stream: ${validationErr}` }],
        details: {
          path: targetAbs,
          chunk: chunkMode,
          contentBytes,
          sidecarExisted,
          targetExisted,
        },
      };
    }

    try {
      await mkdir(dirname(targetAbs), { recursive: true });
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `write_stream: failed to create parent directory: ${(err as Error).message}`,
          },
        ],
        details: { path: targetAbs, chunk: chunkMode },
      };
    }

    const warning =
      contentBytes > SOFT_WARN_BYTES
        ? ` ⚠ chunk size ${humanBytes(contentBytes)} is close to the ${humanBytes(HARD_CAP_BYTES)} cap — consider smaller chunks.`
        : "";

    try {
      if (chunkMode === "only") {
        // Atomic single-shot: write to sidecar, rename. Even though this
        // could just be a direct writeFile, going via sidecar gives us the
        // same crash-safety as the multi-chunk path with no extra cost.
        await writeFile(tmp, params.content, "utf-8");
        await rename(tmp, targetAbs);
        return {
          content: [
            {
              type: "text",
              text:
                `write_stream: wrote ${humanBytes(contentBytes)} to ${targetAbs} ` +
                `(single-shot, atomic).${warning}`,
            },
          ],
          details: {
            path: targetAbs,
            chunk: chunkMode,
            contentBytes,
            finalBytes: contentBytes,
            sidecarExisted,
            targetExisted,
            finalized: true,
          },
        };
      }

      if (chunkMode === "first") {
        // Truncate-create. Any prior sidecar gets overwritten — this is
        // the recovery path for aborted streams.
        await writeFile(tmp, params.content, "utf-8");
        const st = await stat(tmp);
        return {
          content: [
            {
              type: "text",
              text:
                `write_stream: started stream → ${tmp} ` +
                `(${humanBytes(contentBytes)} written, ${humanBytes(st.size)} accumulated).${warning} ` +
                `Send 'middle' / 'last' chunks to continue.`,
            },
          ],
          details: {
            path: targetAbs,
            chunk: chunkMode,
            contentBytes,
            accumulatedBytes: st.size,
            sidecarExisted,
            targetExisted,
            finalized: false,
          },
        };
      }

      // middle or last → append
      await appendFile(tmp, params.content, "utf-8");
      const stAfter = await stat(tmp);

      if (chunkMode === "middle") {
        return {
          content: [
            {
              type: "text",
              text:
                `write_stream: appended ${humanBytes(contentBytes)} (chunk='middle'). ` +
                `Accumulated ${humanBytes(stAfter.size)} so far.${warning} ` +
                `Send 'last' to finalize.`,
            },
          ],
          details: {
            path: targetAbs,
            chunk: chunkMode,
            contentBytes,
            accumulatedBytes: stAfter.size,
            sidecarExisted,
            targetExisted,
            finalized: false,
          },
        };
      }

      // chunk === "last": atomic finalize
      await rename(tmp, targetAbs);
      return {
        content: [
          {
            type: "text",
            text:
              `write_stream: finalized ${targetAbs} (${humanBytes(stAfter.size)} total, ` +
              `last chunk ${humanBytes(contentBytes)}).${warning}`,
          },
        ],
        details: {
          path: targetAbs,
          chunk: chunkMode,
          contentBytes,
          finalBytes: stAfter.size,
          sidecarExisted,
          targetExisted,
          finalized: true,
        },
      };
    } catch (err) {
      // On any IO failure we leave the sidecar in place so the agent can
      // inspect / retry. Cleaning it up here would force the agent to
      // restart from chunk='first' on transient ENOSPC etc.
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `write_stream: IO failure (${chunkMode}): ${(err as Error).message}`,
          },
        ],
        details: {
          path: targetAbs,
          chunk: chunkMode,
          contentBytes,
          sidecarPath: tmp,
        },
      };
    }
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(writeStreamTool);
}
