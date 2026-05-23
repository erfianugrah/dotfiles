/**
 * hurl-test — run a .hurl file and return only the failing entries.
 *
 * `hurl --test --json` returns a full execution log including request,
 * response, captures, asserts, and timing for every entry. For agent
 * workflows we usually only care about: did it pass, and if not, why.
 * This wrapper returns the failing entries with the request line,
 * response status, and the assertions that failed.
 *
 * On success: a compact "N/N passed" line.
 * On failure: structured per-entry breakdown with first failing assert.
 *
 * Requires the `hurl` binary (pacman -S hurl).
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { isAbsolute, resolve as pathResolve, basename } from "node:path";
import { existsSync } from "node:fs";

const TIMEOUT_MS = 120_000;

// ── flattened result type ─────────────────────────────────────────────────

export interface HurlEntryResult {
  index: number; // 1-based
  url: string;
  method: string;
  status: number | null;
  success: boolean;
  durationMs: number;
  failedAsserts: Array<{ kind: string; message: string }>;
  curlCmd?: string;
}

// Exported for unit tests. Pure function over hurl --json output.
export function parseHurlJson(raw: string): { entries: HurlEntryResult[]; allSuccess: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], allSuccess: false };
  }
  // hurl --json outputs one object per file run. We accept either the
  // object itself or an array (for multiple files).
  const runs = Array.isArray(parsed) ? parsed : [parsed];
  const entries: HurlEntryResult[] = [];
  let allSuccess = true;

  for (const run of runs) {
    const r = run as {
      success?: boolean;
      entries?: Array<{
        index?: number;
        request?: { method?: string; url?: string };
        response?: { status?: number };
        time?: number; // ms
        curl_cmd?: string;
        asserts?: Array<{ success?: boolean; line?: number; query?: string; predicate?: { kind?: string }; expected?: unknown; actual?: unknown; message?: string }>;
        captures?: Array<unknown>;
      }>;
    };
    if (r.success === false) allSuccess = false;
    for (const e of r.entries ?? []) {
      const asserts = e.asserts ?? [];
      const failedAsserts = asserts
        .filter((a) => a.success === false)
        .map((a) => ({
          kind: a.predicate?.kind ?? "assert",
          message: a.message ?? `expected ${JSON.stringify(a.expected)}, got ${JSON.stringify(a.actual)}`,
        }));
      entries.push({
        index: e.index ?? entries.length + 1,
        url: e.request?.url ?? "(unknown)",
        method: e.request?.method ?? "GET",
        status: e.response?.status ?? null,
        success: failedAsserts.length === 0 && (e.response?.status ?? 0) < 400,
        durationMs: e.time ?? 0,
        failedAsserts,
        curlCmd: failedAsserts.length > 0 ? e.curl_cmd : undefined,
      });
    }
  }
  return { entries, allSuccess };
}

// ── spawn ─────────────────────────────────────────────────────────────────

async function runHurl(filePath: string, variables: Record<string, string>): Promise<{ ok: boolean; stdout: string; stderr: string; code: number; binaryMissing: boolean }> {
  const args = ["--test", "--json", filePath];
  for (const [k, v] of Object.entries(variables)) {
    args.push("--variable", `${k}=${v}`);
  }
  return new Promise((resolve) => {
    const proc = spawn("hurl", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, TIMEOUT_MS);
    proc.stdout.on("data", (b: Buffer) => stdoutChunks.push(b));
    proc.stderr.on("data", (b: Buffer) => stderrChunks.push(b));
    proc.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: "", stderr: "hurl not on PATH", code: 127, binaryMissing: true });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      // hurl exits non-zero when tests fail; that's still a successful run for us
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      resolve({ ok: code !== 127, stdout, stderr, code: code ?? 1, binaryMissing: false });
    });
  });
}

// ── tool definition ───────────────────────────────────────────────────────

const hurlTestTool = defineTool({
  name: "hurl_test",
  label: "Hurl Test",
  promptSnippet: "hurl_test — run a .hurl file, return failures only. Declarative HTTP integration testing.",
  promptGuidelines: [
    "Pass `variables` as an object to substitute {{ var }} placeholders in the .hurl file (e.g. base_url, api_key).",
    "On success returns a one-line summary. On failure returns per-entry breakdown with the failing assert.",
  ],
  description: [
    "Execute a .hurl test file and return the result.",
    "",
    "On full success: '{passed}/{total} entries passed (N ms total)'.",
    "On any failure: structured list of failed entries with method/URL/status/failedAsserts.",
    "",
    "Hurl files are declarative HTTP scripts \u2014 see https://hurl.dev/ for syntax. They support assertions, captures, JSON path, and variable substitution.",
  ].join("\n"),
  parameters: Type.Object({
    file: Type.String({
      description: "Path to the .hurl file (relative to cwd or absolute).",
    }),
    variables: Type.Optional(
      Type.Object(
        {},
        {
          description:
            "Object of {name: value} variables substituted into {{ name }} in the .hurl file. Strings only.",
          additionalProperties: true,
        },
      ),
    ),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const filePath = isAbsolute(params.file) ? params.file : pathResolve(ctx.cwd, params.file);
    if (!existsSync(filePath)) {
      return {
        isError: true,
        content: [{ type: "text", text: `Hurl file not found: ${filePath}` }],
        details: { error: "file-not-found", file: filePath },
      };
    }

    const vars: Record<string, string> = {};
    if (params.variables && typeof params.variables === "object") {
      for (const [k, v] of Object.entries(params.variables as Record<string, unknown>)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") vars[k] = String(v);
      }
    }

    const run = await runHurl(filePath, vars);
    if (run.binaryMissing) {
      return {
        isError: true,
        content: [{ type: "text", text: "hurl not on PATH. Install with `sudo pacman -S hurl`." }],
        details: { error: "binary-missing" },
      };
    }
    if (!run.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: `hurl spawn failed: ${run.stderr.slice(0, 500)}` }],
        details: { error: "spawn-failed", stderr: run.stderr.slice(0, 1000) },
      };
    }

    const { entries, allSuccess } = parseHurlJson(run.stdout);

    if (entries.length === 0) {
      return {
        content: [{ type: "text", text: `hurl produced no entries for ${basename(filePath)}` }],
        details: { count: 0, file: filePath, stderr: run.stderr.slice(0, 500) },
      };
    }

    const totalTimeMs = entries.reduce((a, e) => a + e.durationMs, 0);
    const passed = entries.filter((e) => e.success).length;

    if (allSuccess && passed === entries.length) {
      return {
        content: [
          {
            type: "text",
            text: `${passed}/${entries.length} entries passed (${totalTimeMs} ms total)`,
          },
        ],
        details: { passed, total: entries.length, totalTimeMs, file: filePath, entries },
      };
    }

    // Render failures
    const failedEntries = entries.filter((e) => !e.success);
    const lines = failedEntries.map((e) => {
      const failHeader = `[${e.index}] ${e.method} ${e.url} → ${e.status ?? "no-response"} (${e.durationMs} ms)`;
      if (e.failedAsserts.length === 0) {
        return `${failHeader}\n  (no failing asserts but entry marked failed — likely network/connection error)`;
      }
      const asserts = e.failedAsserts.map((a) => `  - ${a.kind}: ${a.message}`).join("\n");
      return `${failHeader}\n${asserts}`;
    });

    const summary = `${passed}/${entries.length} passed, ${failedEntries.length} failed (${totalTimeMs} ms total)`;
    return {
      isError: failedEntries.length > 0,
      content: [{ type: "text", text: `${summary}\n\nFailing entries:\n\n${lines.join("\n\n")}` }],
      details: { passed, failed: failedEntries.length, total: entries.length, totalTimeMs, file: filePath, entries },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(hurlTestTool);
}
