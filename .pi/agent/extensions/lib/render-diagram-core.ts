/**
 * render-diagram-core - pure mermaid/d2 arg-building, validation, output-path
 * resolution, result rendering, and a spawn orchestrator. ZERO harness imports
 * (node stdlib + global only). Source of truth for the pi adapter
 * (../render-diagram.ts) and the Claude Code MCP toolkit
 * (../../../.claude/mcp/toolkit.ts).
 *
 * The agent writes diagram source (text); local CLIs render it deterministically:
 *   - mmdc (mermaid-cli): uses puppeteer, ~3-5s per render
 *   - d2: single Go binary, instant
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve as pathResolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const RENDER_TIMEOUT_MS = 30_000;

export type DiagramLanguage = "mermaid" | "d2";
export type DiagramFormat = "svg" | "png";

// -- pure: temp/output path helpers ------------------------------------------

export function tmpFile(ext: string): string {
  return pathResolve(tmpdir(), `pi-diagram-${randomBytes(6).toString("hex")}.${ext}`);
}

export function resolveOutput(cwd: string, outPath: string): string {
  return isAbsolute(outPath) ? outPath : pathResolve(cwd, outPath);
}

// -- pure: argv building -----------------------------------------------------

// mmdc reads an input file and writes an output file. Optional theme.
export function buildMermaidArgs(
  inputFile: string,
  outputFile: string,
  theme?: string,
): string[] {
  const args = ["-i", inputFile, "-o", outputFile, "-q"];
  if (theme) args.push("-t", theme);
  return args;
}

// d2 reads stdin with `-` and writes to the positional output file. Theme is a
// leading `--theme <id>` flag.
export function buildD2Args(outputFile: string, theme?: string): string[] {
  const args = ["-", outputFile];
  if (theme) args.unshift("--theme", theme);
  return args;
}

// -- pure: validation --------------------------------------------------------

export interface ValidateResult {
  ok: boolean;
  error?: string;
}

// PNG is binary; it can't be inlined into a text tool result, so it requires an
// outputPath. Everything else is valid.
export function validateRenderRequest(opts: {
  format: DiagramFormat;
  outputPath?: string;
  source?: string;
}): ValidateResult {
  if (!opts.source || opts.source.trim().length === 0) {
    return { ok: false, error: "source is empty; provide mermaid or d2 diagram source." };
  }
  if (opts.format === "png" && !opts.outputPath) {
    return {
      ok: false,
      error: "outputPath is required for PNG format (binary content can't be inlined).",
    };
  }
  return { ok: true };
}

// -- pure: rendering the render error hint -----------------------------------

export function renderFailureText(language: DiagramLanguage, error: string): string {
  return (
    `${language} render failed:\n\n${error}\n\n` +
    "(Check the source for syntax errors. Common mermaid pitfalls: unquoted labels " +
    "with special chars, missing 'graph TD' header. Common d2 pitfalls: invalid " +
    "shape name, dangling connection.)"
  );
}

// -- spawn helper ------------------------------------------------------------

export async function runCmd(
  cmd: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      res({ code: 127, stdout: "", stderr: (err as Error).message });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, opts.timeoutMs ?? RENDER_TIMEOUT_MS);
    proc.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      res({ code: 127, stdout, stderr: `${stderr}\n${err.message}` });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      res({ code: code ?? 1, stdout, stderr });
    });
    if (opts.input !== undefined) {
      proc.stdin?.write(opts.input);
      proc.stdin?.end();
    } else {
      proc.stdin?.end();
    }
  });
}

// -- renderers (spawn + read output) -----------------------------------------

export interface RenderOutput {
  ok: boolean;
  content?: string;
  bytes?: Buffer;
  error?: string;
}

export async function renderMermaid(
  source: string,
  format: DiagramFormat,
  theme: string | undefined,
): Promise<RenderOutput> {
  const inputFile = tmpFile("mmd");
  const outputFile = tmpFile(format);
  try {
    await writeFile(inputFile, source, "utf8");
    const r = await runCmd("mmdc", buildMermaidArgs(inputFile, outputFile, theme));
    if (r.code !== 0) {
      return {
        ok: false,
        error: `mmdc exit ${r.code}: ${r.stderr.trim() || r.stdout.trim() || "unknown error"}`,
      };
    }
    if (format === "svg") {
      return { ok: true, content: await readFile(outputFile, "utf8") };
    }
    return { ok: true, bytes: await readFile(outputFile) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    await unlink(inputFile).catch(() => {});
    await unlink(outputFile).catch(() => {});
  }
}

export async function renderD2(
  source: string,
  format: DiagramFormat,
  theme: string | undefined,
): Promise<RenderOutput> {
  const outputFile = tmpFile(format);
  try {
    const r = await runCmd("d2", buildD2Args(outputFile, theme), { input: source });
    if (r.code !== 0) {
      return {
        ok: false,
        error: `d2 exit ${r.code}: ${r.stderr.trim() || r.stdout.trim() || "unknown error"}`,
      };
    }
    if (format === "svg") {
      return { ok: true, content: await readFile(outputFile, "utf8") };
    }
    return { ok: true, bytes: await readFile(outputFile) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    await unlink(outputFile).catch(() => {});
  }
}

// -- harness-agnostic orchestrator -------------------------------------------

export interface RenderResult {
  text: string;
  details: Record<string, unknown>;
  isError?: boolean;
}

export async function renderDiagram(opts: {
  language: DiagramLanguage;
  source: string;
  cwd: string;
  outputPath?: string;
  format?: DiagramFormat;
  theme?: string;
}): Promise<RenderResult> {
  const format: DiagramFormat = opts.format ?? "svg";

  const valid = validateRenderRequest({
    format,
    outputPath: opts.outputPath,
    source: opts.source,
  });
  if (!valid.ok) {
    return {
      isError: true,
      text: valid.error ?? "invalid request",
      details: { language: opts.language, format },
    };
  }

  const render = opts.language === "mermaid" ? renderMermaid : renderD2;
  const r = await render(opts.source, format, opts.theme);
  if (!r.ok) {
    return {
      isError: true,
      text: renderFailureText(opts.language, r.error ?? "unknown error"),
      details: { language: opts.language, format, error: r.error },
    };
  }

  if (opts.outputPath) {
    const out = resolveOutput(opts.cwd, opts.outputPath);
    await mkdir(dirname(out), { recursive: true });
    if (format === "svg") {
      const content = r.content ?? "";
      await writeFile(out, content, "utf8");
      return {
        text: `Rendered ${opts.language} -> ${out}\n(${content.length} bytes SVG)`,
        details: { language: opts.language, format, path: out, bytes: content.length },
      };
    }
    const bytes = r.bytes ?? Buffer.alloc(0);
    await writeFile(out, bytes);
    return {
      text: `Rendered ${opts.language} -> ${out}\n(${bytes.byteLength} bytes PNG)`,
      details: { language: opts.language, format, path: out, bytes: bytes.byteLength },
    };
  }

  // No outputPath, return SVG inline.
  const content = r.content ?? "";
  return {
    text: `Rendered ${opts.language} (${content.length} bytes SVG):\n\n${content}`,
    details: { language: opts.language, format, bytes: content.length },
  };
}
