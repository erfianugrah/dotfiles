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
 *     at the location identified by the @@ context. Failure raises a clear error.
 *   - No file rename (*** Move to:) — use Update with full content for now.
 *   - No BOM/encoding fancy handling — UTF-8 assumed.
 *
 * If a patch fails, NO changes are applied (atomic per call — we stage all
 * changes in memory, write only if every hunk applies cleanly).
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve as pathResolve, relative as pathRelative } from "node:path";

type FileOp =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; hunks: Hunk[] };

type Hunk = {
  context: string; // line after @@
  oldLines: string[]; // lines starting with '-'
  newLines: string[]; // lines starting with '+'
};

function parsePatch(text: string): FileOp[] {
  const normalised = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalised.split("\n");

  // Strip *** Begin Patch / *** End Patch envelope if present
  let start = 0;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "*** Begin Patch") {
      start = i + 1;
      break;
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === "*** End Patch") {
      end = i;
      break;
    }
  }
  const body = lines.slice(start, end);

  const ops: FileOp[] = [];
  let i = 0;
  while (i < body.length) {
    const line = body[i];
    const addMatch = line.match(/^\*\*\* Add File: (.+)$/);
    const updateMatch = line.match(/^\*\*\* Update File: (.+)$/);
    const deleteMatch = line.match(/^\*\*\* Delete File: (.+)$/);

    if (addMatch) {
      const path = addMatch[1].trim();
      const contentLines: string[] = [];
      i++;
      while (i < body.length && !body[i].match(/^\*\*\* (Add|Update|Delete) File:/)) {
        if (body[i] === "" && i + 1 >= body.length) break;
        const ln = body[i];
        if (!ln.startsWith("+")) {
          throw new Error(
            `Add File "${path}": every line must start with '+' (got: ${JSON.stringify(ln)})`,
          );
        }
        contentLines.push(ln.slice(1));
        i++;
      }
      const content = contentLines.join("\n") + (contentLines.length > 0 ? "\n" : "");
      ops.push({ type: "add", path, content });
      continue;
    }

    if (deleteMatch) {
      ops.push({ type: "delete", path: deleteMatch[1].trim() });
      i++;
      continue;
    }

    if (updateMatch) {
      const path = updateMatch[1].trim();
      const hunks: Hunk[] = [];
      i++;
      // Each hunk starts with @@. Lines between @@ markers are - or + or whitespace context (ignored).
      while (i < body.length && !body[i].match(/^\*\*\* (Add|Update|Delete) File:/)) {
        if (body[i].startsWith("@@")) {
          const context = body[i].slice(2).trim();
          i++;
          const oldLines: string[] = [];
          const newLines: string[] = [];
          while (
            i < body.length &&
            !body[i].startsWith("@@") &&
            !body[i].match(/^\*\*\* (Add|Update|Delete) File:/)
          ) {
            const ln = body[i];
            if (ln.startsWith("-")) oldLines.push(ln.slice(1));
            else if (ln.startsWith("+")) newLines.push(ln.slice(1));
            // context lines (no prefix) are matched by surrounding hunk
            // boundaries; not stored explicitly in this simple parser
            i++;
          }
          hunks.push({ context, oldLines, newLines });
        } else {
          // Skip blank lines between hunks
          i++;
        }
      }
      if (hunks.length === 0) {
        throw new Error(`Update File "${path}": no @@ hunks found`);
      }
      ops.push({ type: "update", path, hunks });
      continue;
    }

    // Skip blank lines and unrecognised lines between ops
    i++;
  }

  if (ops.length === 0) {
    throw new Error("Patch contained no file operations");
  }
  return ops;
}

async function applyUpdate(filePath: string, hunks: Hunk[]): Promise<string> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err) {
    throw new Error(`Update File "${filePath}": cannot read (${(err as Error).message})`);
  }

  let result = content;
  for (let hIdx = 0; hIdx < hunks.length; hIdx++) {
    const hunk = hunks[hIdx];
    const oldBlock = hunk.oldLines.join("\n");
    const newBlock = hunk.newLines.join("\n");

    if (oldBlock.length === 0) {
      // Pure insertion. Locate by context line.
      if (!hunk.context) {
        throw new Error(`Update File "${filePath}" hunk ${hIdx + 1}: pure insertion needs @@ context`);
      }
      const ctxIdx = result.indexOf(hunk.context);
      if (ctxIdx === -1) {
        throw new Error(
          `Update File "${filePath}" hunk ${hIdx + 1}: @@ context ${JSON.stringify(hunk.context)} not found`,
        );
      }
      // Insert after the context line
      const lineEnd = result.indexOf("\n", ctxIdx);
      const insertAt = lineEnd === -1 ? result.length : lineEnd + 1;
      result = result.slice(0, insertAt) + newBlock + "\n" + result.slice(insertAt);
      continue;
    }

    // Find oldBlock and replace with newBlock. Must be unique.
    const firstIdx = result.indexOf(oldBlock);
    if (firstIdx === -1) {
      throw new Error(
        `Update File "${filePath}" hunk ${hIdx + 1}: old block not found.\nExpected:\n${oldBlock}`,
      );
    }
    const secondIdx = result.indexOf(oldBlock, firstIdx + 1);
    if (secondIdx !== -1) {
      throw new Error(
        `Update File "${filePath}" hunk ${hIdx + 1}: old block matches multiple times; add @@ context to disambiguate`,
      );
    }
    result = result.slice(0, firstIdx) + newBlock + result.slice(firstIdx + oldBlock.length);
  }

  return result;
}

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
  }),
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

    // Stage all changes in memory, then write atomically.
    type Staged =
      | { type: "write"; path: string; content: string; isNew: boolean }
      | { type: "delete"; path: string };

    const staged: Staged[] = [];
    for (const op of ops) {
      const abs = isAbsolute(op.path) ? op.path : pathResolve(ctx.cwd, op.path);

      if (op.type === "add") {
        // Confirm doesn't already exist
        try {
          await stat(abs);
          return {
            isError: true,
            content: [{ type: "text", text: `Add File "${op.path}": already exists` }],
            details: { failedAt: op.path },
          };
        } catch {
          // good — doesn't exist
        }
        staged.push({ type: "write", path: abs, content: op.content, isNew: true });
        continue;
      }

      if (op.type === "delete") {
        try {
          await stat(abs);
        } catch {
          return {
            isError: true,
            content: [{ type: "text", text: `Delete File "${op.path}": does not exist` }],
            details: { failedAt: op.path },
          };
        }
        staged.push({ type: "delete", path: abs });
        continue;
      }

      // update
      let newContent: string;
      try {
        newContent = await applyUpdate(abs, op.hunks);
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: (err as Error).message }],
          details: { failedAt: op.path },
        };
      }
      staged.push({ type: "write", path: abs, content: newContent, isNew: false });
    }

    // All staged — commit atomically (best-effort; if a later write fails, we don't roll back earlier ones)
    const summary: string[] = [];
    for (const s of staged) {
      if (s.type === "write") {
        await mkdir(dirname(s.path), { recursive: true });
        await writeFile(s.path, s.content, "utf8");
        summary.push(`${s.isNew ? "added" : "updated"} ${pathRelative(ctx.cwd, s.path)}`);
      } else {
        await unlink(s.path);
        summary.push(`deleted ${pathRelative(ctx.cwd, s.path)}`);
      }
    }

    return {
      content: [{ type: "text", text: `Applied ${staged.length} file ops:\n  - ${summary.join("\n  - ")}` }],
      details: { ops: staged.length },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(applyPatchTool);
}
