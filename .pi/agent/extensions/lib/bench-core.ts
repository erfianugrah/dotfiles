/**
 * bench-core - pure hyperfine JSON projection, arg-building, formatting, and a
 * spawn orchestrator. ZERO harness imports. Source of truth for the pi adapter
 * (../bench.ts) and the Claude Code MCP toolkit (../../../.claude/mcp/toolkit.ts).
 *
 * Extracted from bench.ts (2026-08-11); see
 * .pi/agent/docs/pi-to-claude-code-port.md.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 30 * 60_000; // outer cap 30 min; hyperfine controls its own

export interface BenchResult {
  command: string;
  meanS: number;
  stddevS: number;
  minS: number;
  maxS: number;
  medianS: number;
  runs: number;
  exitCodes: number[];
}

export interface BenchOutput {
  results: BenchResult[];
  winner: string | null;
  speedupX: number | null; // (slowest.mean / fastest.mean)
}

// Pure function over hyperfine --export-json output. Exported for unit tests.
export function parseHyperfineJson(raw: string): BenchOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { results: [], winner: null, speedupX: null };
  }
  const data = parsed as {
    results?: Array<{
      command?: string;
      mean?: number;
      stddev?: number;
      min?: number;
      max?: number;
      median?: number;
      times?: number[];
      exit_codes?: number[];
    }>;
  };
  const results: BenchResult[] = (data.results ?? []).map((r) => ({
    command: r.command ?? "(unknown)",
    meanS: r.mean ?? 0,
    stddevS: r.stddev ?? 0,
    minS: r.min ?? 0,
    maxS: r.max ?? 0,
    medianS: r.median ?? r.mean ?? 0,
    runs: r.times?.length ?? 0,
    exitCodes: r.exit_codes ?? [],
  }));
  if (results.length === 0) return { results: [], winner: null, speedupX: null };
  const fastest = results.reduce((a, b) => (a.meanS < b.meanS ? a : b));
  const slowest = results.reduce((a, b) => (a.meanS > b.meanS ? a : b));
  return {
    results,
    winner: fastest.command,
    speedupX: fastest.meanS > 0 ? slowest.meanS / fastest.meanS : null,
  };
}

// Pure. Exported for unit tests.
export function fmtSeconds(s: number): string {
  if (s < 0.001) return `${(s * 1_000_000).toFixed(0)}µs`;
  if (s < 1) return `${(s * 1000).toFixed(1)} ms`;
  if (s < 60) return `${s.toFixed(3)} s`;
  return `${(s / 60).toFixed(2)} min`;
}

export interface BenchOpts {
  commands: string[];
  warmup?: number;
  runs?: number;
  shellNone?: boolean;
  prepare?: string;
}

// Pure: build the hyperfine argv (export path injected by the orchestrator).
export function buildBenchArgs(opts: BenchOpts, exportPath: string): string[] {
  const args = ["--warmup", String(opts.warmup ?? 3), "--runs", String(opts.runs ?? 10), "--export-json", exportPath];
  if (opts.shellNone !== false) args.push("--shell=none");
  if (opts.prepare) args.push("--prepare", opts.prepare);
  for (const cmd of opts.commands) args.push(cmd);
  return args;
}

// Pure: render a BenchOutput to a compact table. Exported for unit tests.
export function renderBench(out: BenchOutput): string {
  const rows = out.results.map((r) => {
    const isWinner = r.command === out.winner;
    return `${isWinner ? "* " : "  "}${r.command}\n    mean=${fmtSeconds(r.meanS)} ± ${fmtSeconds(r.stddevS)}  min=${fmtSeconds(r.minS)}  max=${fmtSeconds(r.maxS)}  (${r.runs} runs)`;
  });
  const speedupLine =
    out.speedupX && out.speedupX > 1.01
      ? `\n\nWinner: ${out.winner} (${out.speedupX.toFixed(2)}× faster than slowest)`
      : out.results.length > 1
        ? "\n\nResults are statistically tied (<=1% difference)"
        : "";
  return `Benchmark results:\n\n${rows.join("\n\n")}${speedupLine}`;
}

// -- spawn -------------------------------------------------------------------

async function runHyperfine(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string; code: number; binaryMissing: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn("hyperfine", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
      resolve({ ok: false, stdout: "", stderr: "hyperfine not on PATH", code: 127, binaryMissing: true });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: (code ?? 1) === 0,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        code: code ?? 1,
        binaryMissing: false,
      });
    });
  });
}

// -- harness-agnostic orchestrator -------------------------------------------

export interface BenchToolResult {
  text: string;
  details: Record<string, unknown>;
  isError?: boolean;
}

export async function runBench(opts: BenchOpts & { cwd: string }): Promise<BenchToolResult> {
  if (!Array.isArray(opts.commands) || opts.commands.length === 0) {
    return { isError: true, text: "bench: provide at least one command in `commands`.", details: { error: "missing-commands" } };
  }
  const tmpDir = mkdtempSync(join(tmpdir(), "bench-"));
  const exportPath = join(tmpDir, "bench.json");
  try {
    const run = await runHyperfine(buildBenchArgs(opts, exportPath), opts.cwd);
    if (run.binaryMissing) {
      return {
        isError: true,
        text: "hyperfine not on PATH. Install with `sudo pacman -S hyperfine` (or `brew install hyperfine`).",
        details: { error: "binary-missing" },
      };
    }
    if (!run.ok) {
      return {
        isError: true,
        text: `hyperfine failed (exit ${run.code}):\n${run.stderr.slice(0, 800)}`,
        details: { error: "hyperfine-failed", code: run.code, stderr: run.stderr.slice(0, 1000) },
      };
    }
    let raw: string;
    try {
      raw = readFileSync(exportPath, "utf-8");
    } catch {
      return { isError: true, text: "hyperfine completed but produced no export JSON", details: { error: "no-export" } };
    }
    const out = parseHyperfineJson(raw);
    if (out.results.length === 0) {
      return { text: "No benchmark results parsed", details: { error: "parse-empty" } };
    }
    return {
      text: renderBench(out),
      details: { ...out, warmup: opts.warmup ?? 3, runs: opts.runs ?? 10 },
    };
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
