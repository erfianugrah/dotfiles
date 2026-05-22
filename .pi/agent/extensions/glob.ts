/**
 * glob — file pattern matching tool (opencode parity).
 *
 * Port of the opencode fork's tools/glob.ts. Same semantics:
 *   - Pattern like "**\/*.ts" or "src/**\/*.{ts,tsx}"
 *   - Returns up to 100 matching paths sorted by mtime (newest first)
 *   - "(Results are truncated...)" footer when capped
 *
 * Why a tool instead of `bash rg --files -g <pat>`:
 *   - LLM picks it more reliably than bash for "find files by name"
 *   - Permission-gated separately from arbitrary bash
 *   - Structured output (no shell escaping surprises)
 *
 * Uses ripgrep under the hood (`rg --files -g <pat>`) — ripgrep is the
 * fastest gitignore-aware filesystem walker. Falls back to a clear error
 * if rg isn't installed.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve as pathResolve, relative as pathRelative } from "node:path";

const LIMIT = 100;

async function rgFiles(cwd: string, pattern: string, signal?: AbortSignal): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "rg",
      ["--files", "--no-config", "-g", pattern, "."],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    const t = setTimeout(() => child.kill("SIGKILL"), 30_000);
    signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0 && code !== 1) {
        // 0 = matches, 1 = no matches (ok), other = error
        return reject(new Error(`rg exit ${code}: ${err.trim()}`));
      }
      resolve(out.split("\n").filter(Boolean));
    });
  });
}

const globTool = defineTool({
  name: "glob",
  label: "Glob",
  promptSnippet: "glob — fast file-by-pattern lookup. Wraps `rg --files -g`.",
  promptGuidelines: [],
  description:
    "Glob file patterns (e.g. `**/*.ts`). Returns up to 100 paths sorted by mtime. For content search use `grep`.",

  parameters: Type.Object({
    pattern: Type.String({ description: "Glob pattern (e.g. '**/*.ts', 'src/**/*.{ts,tsx}')" }),
    path: Type.Optional(
      Type.String({
        description:
          "Directory to search in (default: cwd). Must be an existing directory; omit for cwd.",
      }),
    ),
  }),
  async execute(_id, params, signal, _onUpdate, ctx) {
    const search = params.path
      ? isAbsolute(params.path)
        ? params.path
        : pathResolve(ctx.cwd, params.path)
      : ctx.cwd;

    let info;
    try {
      info = await stat(search);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `glob path does not exist: ${search}` }],
        details: { pattern: params.pattern, path: search },
      };
    }
    if (!info.isDirectory()) {
      return {
        isError: true,
        content: [{ type: "text", text: `glob path must be a directory: ${search}` }],
        details: { pattern: params.pattern, path: search },
      };
    }

    let files: string[];
    try {
      files = await rgFiles(search, params.pattern, signal);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `glob failed: ${(err as Error).message}` }],
        details: { pattern: params.pattern, path: search },
      };
    }

    // Resolve to absolute paths and attach mtime for sorting
    const withMtime = await Promise.all(
      files.slice(0, LIMIT + 1).map(async (rel) => {
        const full = pathResolve(search, rel);
        try {
          const s = await stat(full);
          return { path: full, mtime: s.mtimeMs };
        } catch {
          return { path: full, mtime: 0 };
        }
      }),
    );

    const truncated = withMtime.length > LIMIT;
    if (truncated) withMtime.length = LIMIT;
    withMtime.sort((a, b) => b.mtime - a.mtime);

    if (withMtime.length === 0) {
      return {
        content: [{ type: "text", text: "No files found" }],
        details: { count: 0, pattern: params.pattern, path: search },
      };
    }

    const lines = withMtime.map((f) => f.path);
    if (truncated) {
      lines.push(
        "",
        `(Results truncated: showing first ${LIMIT}. Narrow the pattern or pass a more specific path.)`,
      );
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: {
        count: withMtime.length,
        truncated,
        pattern: params.pattern,
        path: pathRelative(ctx.cwd, search) || ".",
      },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(globTool);
}
