/**
 * render-diagram-core unit tests - pure arg-building, output-path resolution,
 * validation, failure-text rendering, and the orchestrator against a fake CLI
 * shim on PATH (no real mmdc/d2 / puppeteer needed; the live render is covered
 * by the pi e2e suite / marked [blocked: needs binary] in the port doc).
 *
 *   bun test extensions/tests/render-diagram-core.test.ts
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildD2Args,
  buildMermaidArgs,
  renderDiagram,
  renderFailureText,
  resolveOutput,
  validateRenderRequest,
} from "../lib/render-diagram-core.ts";

describe("render-diagram-core.buildMermaidArgs", () => {
  test("default: -i/-o with quiet flag", () => {
    expect(buildMermaidArgs("/in.mmd", "/out.svg")).toEqual([
      "-i", "/in.mmd", "-o", "/out.svg", "-q",
    ]);
  });
  test("theme appends -t <theme>", () => {
    expect(buildMermaidArgs("/in.mmd", "/out.svg", "dark")).toEqual([
      "-i", "/in.mmd", "-o", "/out.svg", "-q", "-t", "dark",
    ]);
  });
});

describe("render-diagram-core.buildD2Args", () => {
  test("default: stdin dash + positional output", () => {
    expect(buildD2Args("/out.svg")).toEqual(["-", "/out.svg"]);
  });
  test("theme prepends --theme <id>", () => {
    expect(buildD2Args("/out.svg", "300")).toEqual(["--theme", "300", "-", "/out.svg"]);
  });
});

describe("render-diagram-core.resolveOutput", () => {
  test("absolute path passes through", () => {
    expect(resolveOutput("/cwd", "/abs/out.svg")).toBe("/abs/out.svg");
  });
  test("relative path resolves against cwd", () => {
    expect(resolveOutput("/cwd", "docs/out.svg")).toBe("/cwd/docs/out.svg");
  });
});

describe("render-diagram-core.validateRenderRequest", () => {
  test("png without outputPath is rejected", () => {
    const r = validateRenderRequest({ format: "png", source: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("outputPath is required for PNG");
  });
  test("png with outputPath is ok", () => {
    expect(validateRenderRequest({ format: "png", outputPath: "/o.png", source: "x" }).ok).toBe(true);
  });
  test("svg without outputPath is ok", () => {
    expect(validateRenderRequest({ format: "svg", source: "x" }).ok).toBe(true);
  });
  test("empty source is rejected", () => {
    const r = validateRenderRequest({ format: "svg", source: "   " });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("source is empty");
  });
});

describe("render-diagram-core.renderFailureText", () => {
  test("embeds language + error + pitfall hints", () => {
    const t = renderFailureText("mermaid", "boom");
    expect(t).toContain("mermaid render failed");
    expect(t).toContain("boom");
    expect(t).toContain("Common mermaid pitfalls");
  });
});

// -- orchestrator against a fake CLI shim ------------------------------------

const shimDir = mkdtempSync(join(tmpdir(), "render-diagram-shim-"));
const origPath = process.env.PATH ?? "";

/** Write a fake `d2` that echoes stdin into the positional output file. */
function installFakeD2Success() {
  const p = join(shimDir, "d2");
  // d2 args: [--theme X] - <outfile>. Output file is the last argv.
  writeFileSync(
    p,
    [
      "#!/usr/bin/env bash",
      "set -e",
      'for last; do :; done',              // last -> final positional (outfile)
      'cat > "$last"',                     // pipe stdin into the output file
      "exit 0",
    ].join("\n"),
    "utf8",
  );
  chmodSync(p, 0o755);
}

/** Write a fake `d2` that fails with a stderr message and nonzero exit. */
function installFakeD2Failure() {
  const p = join(shimDir, "d2");
  writeFileSync(
    p,
    ["#!/usr/bin/env bash", 'echo "syntax error: dangling connection" >&2', "exit 1"].join("\n"),
    "utf8",
  );
  chmodSync(p, 0o755);
}

afterAll(() => {
  process.env.PATH = origPath;
  rmSync(shimDir, { recursive: true, force: true });
});

describe("render-diagram-core.renderDiagram (orchestrator, fake d2)", () => {
  test("png without outputPath short-circuits to error before spawning", async () => {
    const r = await renderDiagram({ language: "d2", source: "a -> b", cwd: "/tmp", format: "png" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("outputPath is required for PNG");
  });

  test("empty source short-circuits to error", async () => {
    const r = await renderDiagram({ language: "d2", source: "", cwd: "/tmp" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("source is empty");
  });

  test("svg with outputPath writes file and reports byte count", async () => {
    process.env.PATH = `${shimDir}:${origPath}`;
    installFakeD2Success();
    const outDir = mkdtempSync(join(tmpdir(), "render-diagram-out-"));
    const out = join(outDir, "nested", "diagram.svg");
    const svgSource = "x -> y";
    const r = await renderDiagram({ language: "d2", source: svgSource, cwd: outDir, outputPath: out });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("Rendered d2 ->");
    expect(r.text).toContain(`${svgSource.length} bytes SVG`);
    expect(readFileSync(out, "utf8")).toBe(svgSource);
    expect(r.details.path).toBe(out);
    expect(r.details.bytes).toBe(svgSource.length);
    rmSync(outDir, { recursive: true, force: true });
  });

  test("svg without outputPath returns content inline", async () => {
    process.env.PATH = `${shimDir}:${origPath}`;
    installFakeD2Success();
    const src = "a -> b: label";
    const r = await renderDiagram({ language: "d2", source: src, cwd: shimDir });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain(`Rendered d2 (${src.length} bytes SVG)`);
    expect(r.text).toContain(src);
  });

  test("nonzero CLI exit surfaces stderr in a failure hint", async () => {
    process.env.PATH = `${shimDir}:${origPath}`;
    installFakeD2Failure();
    const r = await renderDiagram({ language: "d2", source: "a ->", cwd: shimDir });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("d2 render failed");
    expect(r.text).toContain("dangling connection");
    expect(r.text).toContain("Common d2 pitfalls");
  });
});
