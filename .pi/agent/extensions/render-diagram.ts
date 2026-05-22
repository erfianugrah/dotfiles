/**
 * render_diagram — validate + render mermaid / d2 diagrams to SVG or PNG.
 *
 * The agent is best at writing diagram source (text). Local CLIs (mmdc for
 * mermaid, d2 for d2) handle the rendering deterministically. This tool
 * wraps both so the agent can:
 *
 *   1. Validate syntax before committing diagrams to docs (catch typos that
 *      would silently produce broken renders).
 *   2. Render to SVG for embedding in markdown / docs.
 *   3. Render to PNG for slides / social / docs where SVG isn't supported.
 *
 * Both CLIs are pre-installed:
 *   - mmdc (mermaid-cli): /usr/sbin/mmdc — uses puppeteer, ~3-5s per render
 *   - d2: ~/.local/bin/d2 — single Go binary, instant
 *
 * The agent writes diagram source inline (no separate "generate" step) and
 * passes it here. If output path is omitted, the SVG content is returned in
 * the tool result so the agent can inspect / iterate before saving.
 *
 * For diagram syntax guidance see the `mermaid-d2` skill.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "child_process";
import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import { dirname, isAbsolute, resolve } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

const RENDER_TIMEOUT_MS = 30_000;

// ── helpers ───────────────────────────────────────────────────────────────

async function runCmd(
  cmd: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, opts.timeoutMs ?? RENDER_TIMEOUT_MS);
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      res({ code: 1, stdout, stderr: `${stderr}\n${err.message}` });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      res({ code: code ?? 1, stdout, stderr });
    });
    if (opts.input !== undefined) {
      proc.stdin.write(opts.input);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }
  });
}

function tmpFile(ext: string): string {
  return resolve(tmpdir(), `pi-diagram-${randomBytes(6).toString("hex")}.${ext}`);
}

function resolveOutput(cwd: string, outPath: string): string {
  return isAbsolute(outPath) ? outPath : resolve(cwd, outPath);
}

// ── mermaid renderer ──────────────────────────────────────────────────────

async function renderMermaid(
  source: string,
  format: "svg" | "png",
  theme: string | undefined,
): Promise<{ ok: boolean; content?: string; bytes?: Buffer; error?: string }> {
  const inputFile = tmpFile("mmd");
  const outputFile = tmpFile(format);
  try {
    await writeFile(inputFile, source, "utf8");
    const args = ["-i", inputFile, "-o", outputFile, "-q"];
    if (theme) args.push("-t", theme);
    const r = await runCmd("mmdc", args);
    if (r.code !== 0) {
      return {
        ok: false,
        error: `mmdc exit ${r.code}: ${r.stderr.trim() || r.stdout.trim() || "unknown error"}`,
      };
    }
    if (format === "svg") {
      const content = await readFile(outputFile, "utf8");
      return { ok: true, content };
    }
    const bytes = await readFile(outputFile);
    return { ok: true, bytes };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    await unlink(inputFile).catch(() => {});
    await unlink(outputFile).catch(() => {});
  }
}

// ── d2 renderer ───────────────────────────────────────────────────────────

async function renderD2(
  source: string,
  format: "svg" | "png",
  theme: string | undefined,
): Promise<{ ok: boolean; content?: string; bytes?: Buffer; error?: string }> {
  const outputFile = tmpFile(format);
  try {
    // d2 reads stdin with `-`. Writes to file path positional.
    const args = ["-", outputFile];
    if (theme) args.unshift("--theme", theme);
    const r = await runCmd("d2", args, { input: source });
    if (r.code !== 0) {
      return {
        ok: false,
        error: `d2 exit ${r.code}: ${r.stderr.trim() || r.stdout.trim() || "unknown error"}`,
      };
    }
    if (format === "svg") {
      const content = await readFile(outputFile, "utf8");
      return { ok: true, content };
    }
    const bytes = await readFile(outputFile);
    return { ok: true, bytes };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    await unlink(outputFile).catch(() => {});
  }
}

// ── tool ──────────────────────────────────────────────────────────────────

const renderDiagramTool = defineTool({
  name: "render_diagram",
  label: "Render Diagram",
  promptSnippet: "render_diagram — mermaid/d2 to SVG/PNG. Validates syntax.",
  promptGuidelines: [
    "d2 for system architecture (cleaner, faster); mermaid for sequence/gantt/ER.",
  ],
  description:
    "Render mermaid/d2 source to SVG (default) or PNG. PNG requires outputPath. Syntax errors returned as text.",

  parameters: Type.Object({
    language: Type.Union([Type.Literal("mermaid"), Type.Literal("d2")], {
      description: "Diagram language",
    }),
    source: Type.String({ description: "Diagram source code (mermaid or d2 syntax)" }),
    outputPath: Type.Optional(
      Type.String({
        description:
          "Where to write the rendered file (absolute or relative to cwd). Required for PNG. If omitted for SVG, content is returned in tool output.",
      }),
    ),
    format: Type.Optional(
      Type.Union([Type.Literal("svg"), Type.Literal("png")], {
        description: "Output format (default: svg)",
      }),
    ),
    theme: Type.Optional(
      Type.String({
        description:
          "Theme name. mermaid: 'default'|'dark'|'forest'|'neutral'. d2: theme id (e.g. '0' default, '100' dark, '300' terminal). Omit for default.",
      }),
    ),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const format = params.format ?? "svg";
    if (format === "png" && !params.outputPath) {
      return {
        isError: true,
        content: [
          { type: "text", text: "outputPath is required for PNG format (binary content can't be inlined)." },
        ],
        details: { language: params.language, format },
      };
    }

    const render = params.language === "mermaid" ? renderMermaid : renderD2;
    const r = await render(params.source, format, params.theme);
    if (!r.ok) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `${params.language} render failed:\n\n${r.error}\n\n(Check the source for syntax errors. Common mermaid pitfalls: unquoted labels with special chars, missing 'graph TD' header. Common d2 pitfalls: invalid shape name, dangling connection.)`,
          },
        ],
        details: { language: params.language, format, error: r.error },
      };
    }

    if (params.outputPath) {
      const out = resolveOutput(ctx.cwd, params.outputPath);
      await mkdir(dirname(out), { recursive: true });
      if (format === "svg") {
        await writeFile(out, r.content ?? "", "utf8");
        return {
          content: [
            {
              type: "text",
              text: `Rendered ${params.language} → ${out}\n(${(r.content ?? "").length} bytes SVG)`,
            },
          ],
          details: { language: params.language, format, path: out, bytes: (r.content ?? "").length },
        };
      } else {
        await writeFile(out, r.bytes ?? Buffer.alloc(0));
        return {
          content: [
            {
              type: "text",
              text: `Rendered ${params.language} → ${out}\n(${(r.bytes?.byteLength ?? 0)} bytes PNG)`,
            },
          ],
          details: { language: params.language, format, path: out, bytes: r.bytes?.byteLength ?? 0 },
        };
      }
    }

    // No outputPath, return SVG inline
    return {
      content: [
        {
          type: "text",
          text: `Rendered ${params.language} (${(r.content ?? "").length} bytes SVG):\n\n${r.content}`,
        },
      ],
      details: { language: params.language, format, bytes: (r.content ?? "").length },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(renderDiagramTool);
}
