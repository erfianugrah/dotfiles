/**
 * apply_patch — multi-file diff format (opencode parity).
 *
 * Port of the opencode fork's apply_patch tool, simplified. Some model
 * providers (GPT-5, Codex) emit multi-file patches in this envelope
 * format more naturally than calling edit/write repeatedly.
 *
 * Envelope format:
 *
 *   *** Begin Patch
 *   *** Add File: path/to/new.ts
 *   +line 1
 *   +line 2
 *   *** Update File: path/to/existing.ts
 *   @@ context line
 *   -old line
 *   +new line
 *   *** Delete File: path/to/old.ts
 *   *** End Patch
 *
 * Operations:
 *   - Add File: every following line must start with '+', joined as the file body.
 *   - Delete File: removes the file. No body.
 *   - Update File: one or more @@-prefixed hunks, each with - (remove) and + (add) lines.
 *
 * Simplifications vs opencode's version:
 *   - No fuzzy hunk matching. Each '-' line must match the file content EXACTLY
 *     and UNIQUELY. Unprefixed @@ context lines are NOT used to locate a
 *     replacement, only to anchor a pure insertion. Failure raises a clear error.
 *   - No file rename (*** Move to:) - use Update with full content for now.
 *   - No BOM/encoding fancy handling - UTF-8 assumed.
 *
 * Same-path ops:
 *   Staging is keyed by absolute path, so several Update ops on one file chain
 *   (each applies to the previous result) instead of racing on a shared tmp
 *   file. Add/Delete on a path already touched in the same patch is rejected.
 *
 * Atomicity:
 *   1. Parse + apply all hunks in memory. If any hunk fails, NO file IO.
 *   2. Two-phase commit: write every new/updated file to <path>.applypatch-<rand>
 *      first; if all tmps succeed, rename each tmp over its target and run
 *      deletes. Rename within a single filesystem is POSIX-atomic. Roll
 *      back tmps on a write-phase failure.
 *
 * The only window where partial state is possible is mid-promote (rename
 * over target) — which on a healthy filesystem essentially can't fail
 * once the tmp is on disk.
 *
 * Success output:
 *   After a clean apply, the result text lists the file ops and then appends
 *   an edit-style diff (line-numbered +/-/space gutters via pi's exported
 *   `generateDiffString`, matching the native edit tool — pi colorizes by
 *   prefix at render). Only Update ops are diffed; Add ops are skipped (the
 *   model authored the new content, so a from-empty diff is pure token bloat)
 *   and Delete ops carry no diff. See `renderApplyDiffs`.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, generateDiffString, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve as pathResolve, relative as pathRelative } from "node:path";
import { randomBytes } from "node:crypto";
import {
  applyHunks,
  parsePatch,
  renderApplyDiffs,
  type FileOp,
} from "./lib/apply-patch-core";

// Pure core (parser + hunk application + diff rendering) lives in
// ./lib/apply-patch-core so it can be unit-tested without pi's runtime
// modules. Re-exported here to keep the public surface unchanged.
export type { FileOp, Hunk } from "./lib/apply-patch-core";
export { applyHunks, parsePatch, renderApplyDiffs } from "./lib/apply-patch-core";

const applyPatchTool = defineTool({
  name: "apply_patch",
  label: "Apply Patch",
  promptSnippet: "apply_patch — atomic multi-file Add/Update/Delete patch. Prefer for 3+ files.",
  promptGuidelines: [
    "Atomic: if any hunk fails, NO writes. Old block must match exactly + be unique.",
  ],
  description: [
    "Multi-file patch in one atomic op. Envelope:",
    "```",
    "*** Begin Patch",
    "*** Add File: path/new.ts",
    "+line 1",
    "*** Update File: path/old.ts",
    "@@ context line",
    "-old line",
    "+new line",
    "*** Delete File: path/gone.ts",
    "*** End Patch",
    "```",
    "Add: lines prefixed '+'. Update: @@-hunks with - matching exactly + unique. Delete: no body.",
  ].join("\n"),
  parameters: Type.Object({
    patchText: Type.String({
      description: "Full patch text within the *** Begin Patch / *** End Patch envelope",
    }),
  }, { additionalProperties: false }),
  constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /.+/s" } },
  async execute(_id, params, _signal, _onUpdate, ctx) {
    let ops: FileOp[];
    try {
      ops = parsePatch(params.patchText);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `apply_patch parse error: ${(err as Error).message}` }],
        details: { ops: 0 },
      };
    }

    // Stage all changes in memory, then write atomically. Keyed by absolute
    // path: the tmp filename is derived from the path, so two staged writes to
    // one path would share a tmp and silently drop the first. Chaining them
    // through the map instead makes repeat Update ops on a file compose.
    type StagedWrite = {
      kind: "write";
      abs: string;
      content: string;
      oldContent: string;
      isNew: boolean;
    };
    type Staged = StagedWrite | { kind: "delete"; abs: string };

    const stagedByPath = new Map<string, Staged>();

    for (const op of ops) {
      const abs = isAbsolute(op.path) ? op.path : pathResolve(ctx.cwd, op.path);
      const prior = stagedByPath.get(abs);

      if (op.type === "add") {
        if (prior) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Add File "${op.path}": path is already touched earlier in this patch`,
              },
            ],
            details: { failedAt: op.path },
          };
        }
        // Confirm doesn't already exist
        try {
          await stat(abs);
          return {
            isError: true,
            content: [{ type: "text", text: `Add File "${op.path}": already exists` }],
            details: { failedAt: op.path },
          };
        } catch {
          // good - doesn't exist
        }
        stagedByPath.set(abs, {
          kind: "write",
          abs,
          content: op.content,
          oldContent: "",
          isNew: true,
        });
        continue;
      }

      if (op.type === "delete") {
        if (prior) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Delete File "${op.path}": path is already touched earlier in this patch`,
              },
            ],
            details: { failedAt: op.path },
          };
        }
        let st: Awaited<ReturnType<typeof stat>>;
        try {
          st = await stat(abs);
        } catch {
          return {
            isError: true,
            content: [{ type: "text", text: `Delete File "${op.path}": does not exist` }],
            details: { failedAt: op.path },
          };
        }
        if (st.isDirectory()) {
          return {
            isError: true,
            content: [
              { type: "text", text: `Delete File "${op.path}": is a directory, not a file` },
            ],
            details: { failedAt: op.path },
          };
        }
        stagedByPath.set(abs, { kind: "delete", abs });
        continue;
      }

      // update
      if (prior?.kind === "delete") {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Update File "${op.path}": file is deleted earlier in this patch`,
            },
          ],
          details: { failedAt: op.path },
        };
      }

      let base: string;
      let oldContent: string;
      let isNew: boolean;
      if (prior) {
        // Chain onto the in-memory result of the earlier op on this path.
        base = prior.content;
        oldContent = prior.oldContent;
        isNew = prior.isNew;
      } else {
        try {
          base = await readFile(abs, "utf8");
        } catch (err) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Update File "${op.path}": cannot read (${(err as Error).message})`,
              },
            ],
            details: { failedAt: op.path },
          };
        }
        oldContent = base;
        isNew = false;
      }

      let next: string;
      try {
        next = applyHunks(op.path, base, op.hunks);
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: (err as Error).message }],
          details: { failedAt: op.path },
        };
      }
      stagedByPath.set(abs, { kind: "write", abs, content: next, oldContent, isNew });
    }

    const staged = [...stagedByPath.values()];
    // Diff inputs for the success path. Add ops are excluded: the model
    // authored that content, so a from-empty diff is pure token bloat.
    const diffInputs = staged
      .filter((s): s is StagedWrite => s.kind === "write" && !s.isNew)
      .map((s) => ({
        relPath: pathRelative(ctx.cwd, s.abs),
        oldContent: s.oldContent,
        newContent: s.content,
        isNew: false,
      }));

    // Two-phase commit so a mid-batch failure rolls every change back:
    //   1. WRITE phase: each new/updated path goes to a <path>.tmp-<rand>.
    //      Deletes are noted but not yet performed. If any tmp-write fails,
    //      unlink the tmps we've made so far and abort.
    //   2. PROMOTE phase: rename tmps over their targets, then unlink the
    //      to-be-deleted files. Rename within a single filesystem is atomic
    //      per the POSIX guarantee, so a crash leaves either old or new.
    //
    // This is stronger than the previous "sequential await writeFile" loop
    // that left half-applied state on partial failure.
    const tmpSuffix = `.applypatch-${randomBytes(4).toString("hex")}`;
    const tmpFiles: Array<{ tmp: string; final: string; isNew: boolean }> = [];
    const deletes: string[] = [];

    try {
      // Phase 1: write all tmps
      for (const s of staged) {
        if (s.kind === "write") {
          await mkdir(dirname(s.abs), { recursive: true });
          const tmp = `${s.abs}${tmpSuffix}`;
          await writeFile(tmp, s.content, "utf8");
          tmpFiles.push({ tmp, final: s.abs, isNew: s.isNew });
        } else {
          deletes.push(s.abs);
        }
      }
    } catch (err) {
      // Roll back any tmps we wrote
      for (const { tmp } of tmpFiles) {
        await unlink(tmp).catch(() => {});
      }
      return {
        isError: true,
        content: [{ type: "text", text: `apply_patch write phase failed (no changes applied): ${(err as Error).message}` }],
        details: { failedAt: "write-phase", ops: staged.length },
      };
    }

    // Phase 2: promote tmps, then run deletes. If a promote fails partway,
    // we DO have partial state for the files already renamed — but renames
    // within the same filesystem very rarely fail after the tmp is on disk
    // (no ENOSPC, no permission issues that weren't caught in phase 1). On
    // failure we still clean up the remaining unpromoted tmps so they don't
    // leak on disk.
    const summary: string[] = [];
    let promoted = 0;
    try {
      for (let i = 0; i < tmpFiles.length; i++) {
        const { tmp, final, isNew } = tmpFiles[i];
        await rename(tmp, final);
        summary.push(`${isNew ? "added" : "updated"} ${pathRelative(ctx.cwd, final)}`);
        promoted = i + 1;
      }
      for (const p of deletes) {
        await unlink(p);
        summary.push(`deleted ${pathRelative(ctx.cwd, p)}`);
      }
    } catch (err) {
      // Partial-promote failure — surface what we did and what was left.
      // Don't try to roll back already-renamed files (we'd need a backup).
      // Clean up unpromoted tmps so they don't leak as `*.applypatch-XXXX`.
      for (let i = promoted; i < tmpFiles.length; i++) {
        await unlink(tmpFiles[i].tmp).catch(() => {});
      }
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `apply_patch promote phase failed: ${(err as Error).message}\n` +
              `Applied before failure:\n  - ${summary.join("\n  - ") || "(none)"}\n` +
              `${tmpFiles.length - promoted} pending tmp file(s) cleaned up. You may need to recover the partially-applied changes manually.`,
          },
        ],
        details: { failedAt: "promote-phase", ops: staged.length },
      };
    }

    let text = `Applied ${staged.length} file ops:\n  - ${summary.join("\n  - ")}`;
    const diffs = renderApplyDiffs(diffInputs, generateDiffString);
    if (diffs.length > 0) {
      text += `\n\nDiffs:\n\n${diffs}`;
    }
    return {
      content: [{ type: "text", text }],
      details: { ops: staged.length },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(applyPatchTool);
}
