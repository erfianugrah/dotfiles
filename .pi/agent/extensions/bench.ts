/**
 * bench — wrap `hyperfine` for token-efficient command benchmarking.
 *
 * Hyperfine produces a nice table for humans but a verbose JSON for agents.
 * This wrapper takes a list of commands, runs hyperfine with sensible
 * defaults (3 warmups, 10 runs, --shell=none for short commands), and
 * returns a compact comparison: mean, stddev, range, winner.
 *
 * Common usage:
 *   bench commands=["bun test", "npm test"]
 *   bench commands=["./old", "./new"] runs=20 warmup=5
 *
 * Requires the `hyperfine` binary (pacman -S hyperfine).
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TIMEOUT_MS = 30 * 60_000; // hyperfine controls its own; outer cap 30 min

// ── result type ───────────────────────────────────────────────────────────

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

// Exported for unit tests.
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

// ── format helpers ────────────────────────────────────────────────────────

function fmtSeconds(s: number): string {
  if (s < 0.001) return `${(s * 1_000_000).toFixed(0)}\u00b5s`;
  if (s < 1) return `${(s * 1000).toFixed(1)} ms`;
  if (s < 60) return `${s.toFixed(3)} s`;
  return `${(s / 60).toFixed(2)} min`;
}

// ── spawn ─────────────────────────────────────────────────────────────────

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

// ── tool definition ───────────────────────────────────────────────────────

const benchTool = defineTool({
  name: "bench",
  label: "Bench",
  promptSnippet: "bench \u2014 statistical command benchmarking via hyperfine. Returns mean/stddev/winner.",
  promptGuidelines: [
    "Provide 2+ commands to compare. Use shell quoting if a command contains spaces.",
    "Default 3 warmup runs + 10 measured runs. Bump runs for noisy environments.",
    "Use shell_none=true (default) for short commands that don't need shell features \u2014 reduces measurement noise.",
  ],
  description: [
    "Benchmark one or more commands with hyperfine and return a compact comparison.",
    "",
    "Returns per-command: mean, stddev, min/max/median, run count, exit codes. Plus the winner and the speedup factor (slowest_mean / fastest_mean).",
    "",
    "Use this when you need statistical confidence that change X is faster than Y, not just a one-off `time` measurement.",
  ].join("\n"),
  parameters: Type.Object({
    commands: Type.Array(Type.String(), {
      description: "Commands to benchmark. At least 1, ideally 2+ for comparison.",
    }),
    warmup: Type.Optional(Type.Number({ description: "Warmup runs before measurement. Default 3." })),
    runs: Type.Optional(Type.Number({ description: "Measured runs per command. Default 10. Bump for noisy hosts." })),
    shell_none: Type.Optional(
      Type.Boolean({
        description: "Use --shell=none (no shell wrapper) for short commands; reduces shell startup noise. Default: true. Set false if you need pipes/globs.",
      }),
    ),
    cwd: Type.Optional(Type.String({ description: "Working directory (default: pi cwd)." })),
    prepare: Type.Optional(
      Type.String({ description: "Shell command run BEFORE each measured run (--prepare). E.g. 'rm -rf /tmp/build'." }),
    ),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    if (!Array.isArray(params.commands) || params.commands.length === 0) {
      return {
        isError: true,
        content: [{ type: "text", text: "bench: provide at least one command in `commands`." }],
        details: { error: "missing-commands" },
      };
    }

    const tmpDir = mkdtempSync(join(tmpdir(), "bench-"));
    const exportPath = join(tmpDir, "bench.json");
    try {
      const args: string[] = [
        "--warmup",
        String(params.warmup ?? 3),
        "--runs",
        String(params.runs ?? 10),
        "--export-json",
        exportPath,
      ];
      if (params.shell_none !== false) args.push("--shell=none");
      if (params.prepare) args.push("--prepare", params.prepare);
      for (const cmd of params.commands) args.push(cmd);

      const cwd = params.cwd ?? ctx.cwd;
      const run = await runHyperfine(args, cwd);

      if (run.binaryMissing) {
        return {
          isError: true,
          content: [{ type: "text", text: "hyperfine not on PATH. Install with `sudo pacman -S hyperfine`." }],
          details: { error: "binary-missing" },
        };
      }
      if (!run.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `hyperfine failed (exit ${run.code}):\n${run.stderr.slice(0, 800)}` }],
          details: { error: "hyperfine-failed", code: run.code, stderr: run.stderr.slice(0, 1000) },
        };
      }

      let raw: string;
      try {
        raw = readFileSync(exportPath, "utf-8");
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: "hyperfine completed but produced no export JSON" }],
          details: { error: "no-export" },
        };
      }

      const out = parseHyperfineJson(raw);
      if (out.results.length === 0) {
        return {
          content: [{ type: "text", text: "No benchmark results parsed" }],
          details: { error: "parse-empty" },
        };
      }

      // Compact table
      const rows = out.results.map((r) => {
        const isWinner = r.command === out.winner;
        return `${isWinner ? "* " : "  "}${r.command}\n    mean=${fmtSeconds(r.meanS)} \u00b1 ${fmtSeconds(r.stddevS)}  min=${fmtSeconds(r.minS)}  max=${fmtSeconds(r.maxS)}  (${r.runs} runs)`;
      });
      const speedupLine =
        out.speedupX && out.speedupX > 1.01
          ? `\n\nWinner: ${out.winner} (${out.speedupX.toFixed(2)}\u00d7 faster than slowest)`
          : out.results.length > 1
            ? `\n\nResults are statistically tied (\u22641% difference)`
            : "";

      return {
        content: [{ type: "text", text: `Benchmark results:\n\n${rows.join("\n\n")}${speedupLine}` }],
        details: { ...out, warmup: params.warmup ?? 3, runs: params.runs ?? 10 },
      };
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(benchTool);
}
