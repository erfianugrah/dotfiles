/**
 * grep — content search via ripgrep (opencode parity).
 *
 * Port of the opencode fork's tools/grep.ts. Same semantics:
 *   - Regex content search
 *   - Optional include pattern for file filter (e.g. "*.ts", "*.{ts,tsx}")
 *   - Returns file paths + line numbers sorted by mtime
 *   - Use this for "find files containing pattern X", NOT for counting matches
 *     (use bash + rg directly for counting)
 *
 * Why a tool instead of `bash rg <pattern>`:
 *   - LLM picks it more reliably for content search
 *   - Structured output (file:line:match)
 *   - Permission-gated separately
 *   - Consistent flags (case-insensitive opt-in, line numbers, etc.)
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve as pathResolve, relative as pathRelative } from "node:path";

const LIMIT = 100;

type RgFileMatch = {
  path: string;
  line: number;
  text: string;
};

async function rgSearch(
  cwd: string,
  pattern: string,
  include: string | undefined,
  ignoreCase: boolean,
  signal?: AbortSignal,
): Promise<RgFileMatch[]> {
  return new Promise((resolve, reject) => {
    const args = ["--no-config", "-n", "--no-heading", "--column=false", "-H"];
    if (ignoreCase) args.push("-i");
    if (include) args.push("-g", include);
    args.push("--", pattern, ".");

    const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const t = setTimeout(() => child.kill("SIGKILL"), 60_000);
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
        return reject(new Error(`rg exit ${code}: ${err.trim()}`));
      }
      const hits: RgFileMatch[] = [];
      for (const line of out.split("\n")) {
        if (!line) continue;
        // Format: path:line:text
        const colon1 = line.indexOf(":");
        const colon2 = line.indexOf(":", colon1 + 1);
        if (colon1 === -1 || colon2 === -1) continue;
        const path = line.slice(0, colon1);
        const lineNum = parseInt(line.slice(colon1 + 1, colon2), 10);
        const text = line.slice(colon2 + 1);
        if (!Number.isFinite(lineNum)) continue;
        hits.push({ path, line: lineNum, text });
      }
      resolve(hits);
    });
  });
}

const grepTool = defineTool({
  name: "grep",
  label: "Grep",
  promptSnippet:
    "grep — fast regex content search (ripgrep). Returns file:line:text. Filter files via `include` glob.",
  promptGuidelines: [
    "Use grep to find files containing a regex pattern. Faster + structured vs `bash rg ...`.",
    "Pair with `include` (e.g. `*.ts`) to scope to a file type. Default is all files (respecting .gitignore).",
    "For counting matches or complex pipelines, use bash + rg directly. grep is for 'find files matching X'.",
  ],
  description: [
    "Fast content search tool that works with any codebase size.",
    "",
    "- Searches file contents using regular expressions (Rust regex syntax)",
    '- Supports full regex (e.g. "log.*Error", "function\\s+\\w+")',
    '- Filter files by pattern via `include` (e.g. "*.ts", "*.{ts,tsx}")',
    "- Returns file:line:text triples sorted by mtime (newest files first)",
    "- Use this when you need to find files containing specific patterns.",
    "- Capped at 100 hits — narrow the pattern or `include` if you hit the cap.",
    "- If you need to count matches across files, use bash + rg directly.",
  ].join("\n"),
  parameters: Type.Object({
    pattern: Type.String({
      description: "Regex pattern to search for (Rust regex syntax — same as ripgrep)",
    }),
    path: Type.Optional(
      Type.String({
        description: "Directory to search in (default: cwd). Omit for cwd.",
      }),
    ),
    include: Type.Optional(
      Type.String({
        description: "Glob pattern to filter files (e.g. '*.ts', '*.{ts,tsx}'). Omit for all files.",
      }),
    ),
    ignoreCase: Type.Optional(
      Type.Boolean({
        description: "Case-insensitive match (default: false — regex is case-sensitive by default)",
      }),
    ),
  }),
  async execute(_id, params, signal, _onUpdate, ctx) {
    const search = params.path
      ? isAbsolute(params.path)
        ? params.path
        : pathResolve(ctx.cwd, params.path)
      : ctx.cwd;

    try {
      const s = await stat(search);
      if (!s.isDirectory()) {
        return {
          isError: true,
          content: [{ type: "text", text: `grep path must be a directory: ${search}` }],
          details: { pattern: params.pattern, path: search },
        };
      }
    } catch {
      return {
        isError: true,
        content: [{ type: "text", text: `grep path does not exist: ${search}` }],
        details: { pattern: params.pattern, path: search },
      };
    }

    let hits: RgFileMatch[];
    try {
      hits = await rgSearch(search, params.pattern, params.include, params.ignoreCase ?? false, signal);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `grep failed: ${(err as Error).message}` }],
        details: { pattern: params.pattern, path: search },
      };
    }

    if (hits.length === 0) {
      return {
        content: [{ type: "text", text: "No matches found" }],
        details: { count: 0, pattern: params.pattern, path: search },
      };
    }

    // Sort by file mtime desc (collect unique paths, stat them, then re-sort)
    const uniquePaths = Array.from(new Set(hits.map((h) => h.path)));
    const mtimes = new Map<string, number>();
    await Promise.all(
      uniquePaths.map(async (p) => {
        try {
          const s = await stat(pathResolve(search, p));
          mtimes.set(p, s.mtimeMs);
        } catch {
          mtimes.set(p, 0);
        }
      }),
    );
    hits.sort((a, b) => {
      const am = mtimes.get(a.path) ?? 0;
      const bm = mtimes.get(b.path) ?? 0;
      if (am !== bm) return bm - am;
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.line - b.line;
    });

    const truncated = hits.length > LIMIT;
    const shown = truncated ? hits.slice(0, LIMIT) : hits;

    const lines = shown.map((h) => `${h.path}:${h.line}:${h.text}`);
    if (truncated) {
      lines.push(
        "",
        `(${hits.length - LIMIT} additional matches truncated. Narrow the pattern or add an include filter.)`,
      );
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: {
        count: hits.length,
        shown: shown.length,
        truncated,
        pattern: params.pattern,
        path: pathRelative(ctx.cwd, search) || ".",
        include: params.include,
      },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(grepTool);
}
