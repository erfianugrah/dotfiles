/**
 * apply-patch-core - the pure, IO-free core of the apply_patch extension.
 *
 * Split out of apply-patch.ts so it can be unit-tested with plain `bun test`:
 * the extension module itself imports @earendil-works/pi-* , which only
 * resolves inside the pi runtime.
 *
 * Envelope format and semantics are documented in apply-patch.ts.
 */

export type FileOp =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; hunks: Hunk[] };

export type Hunk = {
  context: string; // line after @@
  oldLines: string[]; // lines starting with '-'
  newLines: string[]; // lines starting with '+'
};

// Exported for unit tests. Pure function: input string → list of file ops.
export function parsePatch(text: string): FileOp[] {
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
      // Unprefixed empty lines are held back rather than rejected: models
      // routinely emit one as a separator before the next *** header. If more
      // '+' content follows they were genuine blank lines and get flushed; if
      // the block ends they were separators and get dropped.
      let pendingBlanks = 0;
      i++;
      while (i < body.length && !body[i].match(/^\*\*\* (Add|Update|Delete) File:/)) {
        const ln = body[i];
        if (ln === "") {
          pendingBlanks++;
          i++;
          continue;
        }
        if (!ln.startsWith("+")) {
          throw new Error(
            `Add File "${path}": every line must start with '+' (got: ${JSON.stringify(ln)})`,
          );
        }
        for (let b = 0; b < pendingBlanks; b++) contentLines.push("");
        pendingBlanks = 0;
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

/**
 * Apply a hunk list to file content. Pure (no IO) so that several Update ops
 * on the same path can chain in memory, and so it is unit-testable.
 * `filePath` is display-only, used in error messages.
 */
export function applyHunks(filePath: string, content: string, hunks: Hunk[]): string {
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
      if (result.indexOf(hunk.context, ctxIdx + 1) !== -1) {
        throw new Error(
          `Update File "${filePath}" hunk ${hIdx + 1}: @@ context ${JSON.stringify(hunk.context)} matches multiple times; use a longer unique context line`,
        );
      }
      // Insert after the context line. When the context sits on an
      // unterminated final line, insertAt is EOF and the new block would be
      // concatenated onto it - so add the missing separator first.
      const lineEnd = result.indexOf("\n", ctxIdx);
      const insertAt = lineEnd === -1 ? result.length : lineEnd + 1;
      const separator = lineEnd === -1 && result.length > 0 ? "\n" : "";
      result =
        result.slice(0, insertAt) + separator + newBlock + "\n" + result.slice(insertAt);
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
        `Update File "${filePath}" hunk ${hIdx + 1}: old block matches multiple times; extend the '-' block with more surrounding lines to make it unique (unprefixed @@ context lines are ignored for replacements)`,
      );
    }
    result = result.slice(0, firstIdx) + newBlock + result.slice(firstIdx + oldBlock.length);
  }

  return result;
}

/**
 * Build an edit-style diff block for the applied changes, matching pi's native
 * edit tool output (line-numbered `+`/`-`/` ` gutters — pi colorizes by prefix
 * at render time). Pure + dependency-injected so it's unit-testable without
 * pi's bundled `generateDiffString`.
 *
 * `add` ops are skipped: the model authored the new file content, so a diff
 * from empty adds nothing but tokens. `delete` ops never reach here. Only
 * `update` ops (where the on-disk result may differ from what the model
 * pictured) get a diff.
 */
export function renderApplyDiffs(
  files: Array<{ relPath: string; oldContent: string; newContent: string; isNew: boolean }>,
  diffFn: (oldContent: string, newContent: string) => string,
): string {
  const blocks: string[] = [];
  for (const f of files) {
    if (f.isNew) continue;
    const diff = diffFn(f.oldContent, f.newContent);
    if (diff.trim().length === 0) continue;
    blocks.push(`### ${f.relPath}\n${diff}`);
  }
  return blocks.join("\n\n");
}
