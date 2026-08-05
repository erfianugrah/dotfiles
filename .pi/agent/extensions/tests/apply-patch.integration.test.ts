/**
 * Integration tests for the apply_patch tool's execute() path: staging,
 * same-path chaining, and the two-phase (tmp-write then rename) commit.
 *
 * pi's runtime modules are mocked so the extension can be imported outside the
 * harness; everything below the mock boundary is the real code.
 *
 * Run: bun test ./.pi/agent/extensions/tests/apply-patch.integration.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stubType = new Proxy({}, { get: () => (...args: unknown[]) => args }) as Record<
  string,
  unknown
>;

mock.module("@earendil-works/pi-ai", () => ({ Type: stubType }));
mock.module("@earendil-works/pi-coding-agent", () => ({
  defineTool: (def: unknown) => def,
  generateDiffString: (oldContent: string, newContent: string) =>
    oldContent === newContent ? "" : `--- old\n+++ new\n`,
}));

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
};

// The module registers the tool via its default export; grab the definition by
// running that export against a capturing ExtensionAPI stub.
const mod = await import("../apply-patch.ts");
let captured: { execute: (...a: unknown[]) => Promise<ToolResult> } | undefined;
(mod.default as (pi: { registerTool: (t: unknown) => void }) => void)({
  registerTool: (t) => {
    captured = t as typeof captured;
  },
});
const tool = captured!;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "apply-patch-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = (patchText: string): Promise<ToolResult> =>
  tool.execute("id", { patchText }, undefined, undefined, { cwd: dir });

const envelope = (body: string) => `*** Begin Patch\n${body}\n*** End Patch\n`;
const read = (rel: string) => readFile(join(dir, rel), "utf8");

describe("apply_patch execute", () => {
  test("registers under the expected tool name", () => {
    expect((tool as unknown as { name: string }).name).toBe("apply_patch");
  });

  test("adds, updates and deletes in one call", async () => {
    await writeFile(join(dir, "b.ts"), "keep\nold\n");
    await writeFile(join(dir, "c.ts"), "bye\n");

    const res = await run(
      envelope(
        [
          "*** Add File: a.ts",
          "+fresh",
          "*** Update File: b.ts",
          "@@",
          "-old",
          "+new",
          "*** Delete File: c.ts",
        ].join("\n"),
      ),
    );

    expect(res.isError).toBeFalsy();
    expect(await read("a.ts")).toBe("fresh\n");
    expect(await read("b.ts")).toBe("keep\nnew\n");
    expect(readFile(join(dir, "c.ts"), "utf8")).rejects.toThrow();
    expect(res.content[0].text).toContain("Applied 3 file ops");
  });

  test("creates missing parent directories for an Add", async () => {
    const res = await run(envelope(["*** Add File: deep/nested/a.ts", "+x"].join("\n")));
    expect(res.isError).toBeFalsy();
    expect(await read("deep/nested/a.ts")).toBe("x\n");
  });

  // Regression: both writes used one tmp name derived from the path, so the
  // first Update was silently dropped and the second rename hit ENOENT during
  // the unrecoverable promote phase.
  test("chains two Update ops on the same file", async () => {
    await writeFile(join(dir, "f.ts"), "one\ntwo\n");

    const res = await run(
      envelope(
        [
          "*** Update File: f.ts",
          "@@",
          "-one",
          "+ONE",
          "*** Update File: f.ts",
          "@@",
          "-two",
          "+TWO",
        ].join("\n"),
      ),
    );

    expect(res.isError).toBeFalsy();
    expect(await read("f.ts")).toBe("ONE\nTWO\n");
  });

  test("rejects a second op on a path already added", async () => {
    const res = await run(
      envelope(["*** Add File: a.ts", "+x", "*** Add File: a.ts", "+y"].join("\n")),
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("already touched earlier in this patch");
    expect(readFile(join(dir, "a.ts"), "utf8")).rejects.toThrow();
  });

  test("rejects an Update of a file deleted earlier in the same patch", async () => {
    await writeFile(join(dir, "f.ts"), "x\n");
    const res = await run(
      envelope(["*** Delete File: f.ts", "*** Update File: f.ts", "@@", "-x", "+y"].join("\n")),
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("deleted earlier in this patch");
    expect(await read("f.ts")).toBe("x\n");
  });

  test("refuses to Add over an existing file", async () => {
    await writeFile(join(dir, "a.ts"), "existing\n");
    const res = await run(envelope(["*** Add File: a.ts", "+new"].join("\n")));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("already exists");
    expect(await read("a.ts")).toBe("existing\n");
  });

  test("refuses to Delete a directory", async () => {
    await mkdir(join(dir, "subdir"));
    const res = await run(envelope("*** Delete File: subdir"));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("is a directory");
  });

  test("refuses to Delete a missing file", async () => {
    const res = await run(envelope("*** Delete File: nope.ts"));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("does not exist");
  });

  test("reports a readable error for an Update of a missing file", async () => {
    const res = await run(envelope(["*** Update File: nope.ts", "@@", "-a", "+b"].join("\n")));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("cannot read");
  });

  // The atomicity claim in the module header: a failing hunk anywhere means no
  // file on disk is touched, including ops that were valid.
  test("a failing hunk aborts the whole patch with zero writes", async () => {
    await writeFile(join(dir, "b.ts"), "real\n");

    const res = await run(
      envelope(
        [
          "*** Add File: a.ts",
          "+fresh",
          "*** Update File: b.ts",
          "@@",
          "-missing",
          "+x",
        ].join("\n"),
      ),
    );

    expect(res.isError).toBe(true);
    expect(res.details?.failedAt).toBe("b.ts");
    expect(readFile(join(dir, "a.ts"), "utf8")).rejects.toThrow();
    expect(await read("b.ts")).toBe("real\n");
  });

  test("leaves no .applypatch- tmp files behind on success or failure", async () => {
    await writeFile(join(dir, "b.ts"), "real\n");
    await run(envelope(["*** Add File: a.ts", "+x"].join("\n")));
    await run(envelope(["*** Update File: b.ts", "@@", "-missing", "+x"].join("\n")));
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.includes(".applypatch-"))).toEqual([]);
  });

  test("returns a parse error without touching the filesystem", async () => {
    const res = await run(envelope("no operations here"));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("parse error");
    expect(await readdir(dir)).toEqual([]);
  });

  test("appends diffs for Update ops but not Add ops", async () => {
    await writeFile(join(dir, "b.ts"), "old\n");
    const res = await run(
      envelope(["*** Add File: a.ts", "+x", "*** Update File: b.ts", "@@", "-old", "+new"].join("\n")),
    );
    const text = res.content[0].text;
    expect(text).toContain("### b.ts");
    expect(text).not.toContain("### a.ts");
  });

  test("resolves relative paths against ctx.cwd and accepts absolute paths", async () => {
    const abs = join(dir, "abs.ts");
    const res = await run(envelope([`*** Add File: ${abs}`, "+x"].join("\n")));
    expect(res.isError).toBeFalsy();
    expect(await read("abs.ts")).toBe("x\n");
  });
});
