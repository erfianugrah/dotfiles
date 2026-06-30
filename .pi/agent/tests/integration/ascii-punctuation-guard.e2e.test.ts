/**
 * ascii-punctuation-guard END-TO-END: drives the REAL tool_call hook through a
 * fake pi runtime to verify each tool surface blocks/passes correctly.
 *
 * Regression focus: pi's `edit` tool uses the `edits: [{ oldText, newText }]`
 * schema (top-level newText is legacy). An earlier version of the guard read
 * input.newText only, so every modern edit slipped through unguarded. These
 * tests assert the edits[] path is scanned.
 *
 * Run: ./.pi/agent/tests/run.sh   (separate bun process from the unit suite)
 */
import { beforeAll, describe, expect, test } from "bun:test";

// ExtensionAPI is a type-only import in the extension (erased at runtime), and
// the module only otherwise uses node:path, so no SDK runtime mock is needed.
import guard from "../../extensions/ascii-punctuation-guard.ts";

type HookFn = (e: unknown, c: unknown) => Promise<unknown> | unknown;
const hooks: Record<string, HookFn[]> = {};
const pi = {
  on: (evt: string, fn: HookFn) => {
    (hooks[evt] ||= []).push(fn);
  },
  registerTool: () => {},
  registerCommand: () => {},
} as never;

async function toolCall(toolName: string, input: unknown): Promise<{ block?: boolean; reason?: string } | undefined> {
  let last: { block?: boolean; reason?: string } | undefined;
  for (const fn of hooks["tool_call"] ?? []) {
    const r = (await fn({ toolName, input }, {})) as { block?: boolean; reason?: string } | undefined;
    if (r) last = r;
  }
  return last;
}

const EM = "\u2014";
const EN = "\u2013";
const ELLIPSIS = "\u2026";

beforeAll(() => {
  // ensure guard is active regardless of ambient env
  delete process.env.PI_ASCII_GUARD_OFF;
  delete process.env.PI_ASCII_GUARD_SCOPE;
  guard(pi);
});

describe("ascii-punctuation-guard e2e / edit (edits[] schema)", () => {
  test("BLOCKS an edit whose edits[].newText contains an em dash", async () => {
    const r = await toolCall("edit", {
      path: "/tmp/foo.md",
      edits: [{ oldText: "old", newText: `new text with ${EM} dash` }],
    });
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("em dash");
  });

  test("BLOCKS when only a later edit in the array has smart punctuation", async () => {
    const r = await toolCall("edit", {
      path: "/tmp/foo.ts",
      edits: [
        { oldText: "a", newText: "clean ascii" },
        { oldText: "b", newText: `range 1${EN}5` },
      ],
    });
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("en dash");
  });

  test("PASSES an edit with clean ASCII edits[]", async () => {
    const r = await toolCall("edit", {
      path: "/tmp/foo.md",
      edits: [{ oldText: "old", newText: "ascii only -- quotes \"ok\" ellipsis..." }],
    });
    expect(r).toBeUndefined();
  });

  test("still catches legacy top-level newText (old-session shape)", async () => {
    const r = await toolCall("edit", { path: "/tmp/foo.md", newText: `legacy ${EM} here` });
    expect(r?.block).toBe(true);
  });
});

describe("ascii-punctuation-guard e2e / write + write_stream", () => {
  test("BLOCKS write content with ellipsis", async () => {
    const r = await toolCall("write", { path: "/tmp/foo.txt", content: `done${ELLIPSIS}` });
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("ellipsis");
  });

  test("PASSES clean write content", async () => {
    const r = await toolCall("write", { path: "/tmp/foo.txt", content: "all ascii here" });
    expect(r).toBeUndefined();
  });

  test("BLOCKS write_stream content with em dash", async () => {
    const r = await toolCall("write_stream", { path: "/tmp/foo.txt", content: `chunk ${EM} x` });
    expect(r?.block).toBe(true);
  });
});

describe("ascii-punctuation-guard e2e / apply_patch", () => {
  test("BLOCKS added (+) lines with an en dash", async () => {
    const patch = ["*** Begin Patch", "*** Add File: /tmp/x.txt", `+text with ${EN} dash`, "*** End Patch"].join("\n");
    const r = await toolCall("apply_patch", { patchText: patch });
    expect(r?.block).toBe(true);
  });

  test("ignores context lines (only + lines scanned)", async () => {
    // an em dash on a non-+ line must NOT trigger
    const patch = ["*** Begin Patch", "*** Update File: /tmp/x.txt", `@@ context ${EM} here`, "+clean ascii add", "*** End Patch"].join("\n");
    const r = await toolCall("apply_patch", { patchText: patch });
    expect(r).toBeUndefined();
  });
});

describe("ascii-punctuation-guard e2e / bash", () => {
  test("BLOCKS git commit with em dash in message", async () => {
    const r = await toolCall("bash", { command: `git commit -m "subject ${EM} body"` });
    expect(r?.block).toBe(true);
  });

  test("PASSES read-only bash even with em dash (not a write/commit)", async () => {
    const r = await toolCall("bash", { command: `echo "just printing ${EM} not persisting"` });
    expect(r).toBeUndefined();
  });
});
