/**
 * hurl-core - pure hurl --json projection + rendering + a spawn orchestrator.
 * ZERO harness imports. Source of truth for the pi adapter (../hurl-test.ts)
 * and the Claude Code MCP toolkit (../../../.claude/mcp/toolkit.ts).
 *
 * Extracted from hurl-test.ts (2026-08-11); see
 * .pi/agent/docs/pi-to-claude-code-port.md.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, isAbsolute, resolve as pathResolve } from "node:path";

const TIMEOUT_MS = 120_000;

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

// Pure function over hurl --json output. Exported for unit tests.
export function parseHurlJson(raw: string): { entries: HurlEntryResult[]; allSuccess: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], allSuccess: false };
  }
  // hurl --json outputs one object per file run. Accept the object or an array.
  const runs = Array.isArray(parsed) ? parsed : [parsed];
  const entries: HurlEntryResult[] = [];
  let allSuccess = true;

  for (const run of runs) {
    const r = run as {
      success?: boolean;
      entries?: Array<{
        index?: number;
        calls?: Array<{ request?: { method?: string; url?: string }; response?: { status?: number } }>;
        request?: { method?: string; url?: string };
        response?: { status?: number };
        time?: number;
        curl_cmd?: string;
        asserts?: Array<{ success?: boolean; predicate?: { kind?: string }; expected?: unknown; actual?: unknown; message?: string }>;
      }>;
    };
    if (r.success === false) allSuccess = false;
    for (const e of r.entries ?? []) {
      const failedAsserts = (e.asserts ?? [])
        .filter((a) => a.success === false)
        .map((a) => ({
          kind: a.predicate?.kind ?? "assert",
          message: a.message ?? `expected ${JSON.stringify(a.expected)}, got ${JSON.stringify(a.actual)}`,
        }));
      const firstCall = e.calls?.[0];
      const request = firstCall?.request ?? e.request;
      const response = firstCall?.response ?? e.response;
      entries.push({
        index: e.index ?? entries.length + 1,
        url: request?.url ?? "(unknown)",
        method: request?.method ?? "GET",
        status: response?.status ?? null,
        success: failedAsserts.length === 0 && (response?.status ?? 0) < 400,
        durationMs: e.time ?? 0,
        failedAsserts,
        curlCmd: failedAsserts.length > 0 ? e.curl_cmd : undefined,
      });
    }
  }
  return { entries, allSuccess };
}

// Pure: render the parsed entries to { text, isError }. Exported for tests.
export function renderHurl(
  entries: HurlEntryResult[],
  allSuccess: boolean,
  filePath: string,
): { text: string; isError: boolean } {
  if (entries.length === 0) {
    return { text: `hurl produced no entries for ${basename(filePath)}`, isError: false };
  }
  const totalTimeMs = entries.reduce((a, e) => a + e.durationMs, 0);
  const passed = entries.filter((e) => e.success).length;

  if (allSuccess && passed === entries.length) {
    return { text: `${passed}/${entries.length} entries passed (${totalTimeMs} ms total)`, isError: false };
  }

  const failedEntries = entries.filter((e) => !e.success);
  const lines = failedEntries.map((e) => {
    const failHeader = `[${e.index}] ${e.method} ${e.url} -> ${e.status ?? "no-response"} (${e.durationMs} ms)`;
    if (e.failedAsserts.length === 0) {
      return `${failHeader}\n  (no failing asserts but entry marked failed - likely network/connection error)`;
    }
    return `${failHeader}\n${e.failedAsserts.map((a) => `  - ${a.kind}: ${a.message}`).join("\n")}`;
  });
  const summary = `${passed}/${entries.length} passed, ${failedEntries.length} failed (${totalTimeMs} ms total)`;
  return { text: `${summary}\n\nFailing entries:\n\n${lines.join("\n\n")}`, isError: failedEntries.length > 0 };
}

// -- spawn -------------------------------------------------------------------

async function runHurl(
  filePath: string,
  variables: Record<string, string>,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number; binaryMissing: boolean }> {
  const args = ["--test", "--json", filePath];
  for (const [k, v] of Object.entries(variables)) args.push("--variable", `${k}=${v}`);
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
      resolve({
        ok: code !== 127,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        code: code ?? 1,
        binaryMissing: false,
      });
    });
  });
}

// -- harness-agnostic orchestrator -------------------------------------------

export interface HurlResult {
  text: string;
  details: Record<string, unknown>;
  isError?: boolean;
}

// Normalise a loose variables object to string values (drops non-scalars).
export function normalizeVars(input: unknown): Record<string, string> {
  const vars: Record<string, string> = {};
  if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") vars[k] = String(v);
    }
  }
  return vars;
}

export async function runHurlTest(opts: {
  file: string;
  cwd: string;
  variables?: unknown;
}): Promise<HurlResult> {
  const filePath = isAbsolute(opts.file) ? opts.file : pathResolve(opts.cwd, opts.file);
  if (!existsSync(filePath)) {
    return { isError: true, text: `Hurl file not found: ${filePath}`, details: { error: "file-not-found", file: filePath } };
  }

  const run = await runHurl(filePath, normalizeVars(opts.variables));
  if (run.binaryMissing) {
    return {
      isError: true,
      text: "hurl not on PATH. Install with `sudo pacman -S hurl` (or `brew install hurl`).",
      details: { error: "binary-missing" },
    };
  }
  if (!run.ok) {
    return { isError: true, text: `hurl spawn failed: ${run.stderr.slice(0, 500)}`, details: { error: "spawn-failed", stderr: run.stderr.slice(0, 1000) } };
  }

  const { entries, allSuccess } = parseHurlJson(run.stdout);
  const { text, isError } = renderHurl(entries, allSuccess, filePath);
  const totalTimeMs = entries.reduce((a, e) => a + e.durationMs, 0);
  const passed = entries.filter((e) => e.success).length;
  return {
    ...(isError ? { isError: true } : {}),
    text,
    details: { passed, failed: entries.length - passed, total: entries.length, totalTimeMs, file: filePath, entries },
  };
}
