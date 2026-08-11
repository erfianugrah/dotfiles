/**
 * bench - wrap `hyperfine` for token-efficient command benchmarking.
 *
 * Hyperfine produces a nice table for humans but verbose JSON for agents. This
 * wrapper takes a list of commands, runs hyperfine with sensible defaults (3
 * warmups, 10 runs, --shell=none for short commands), and returns a compact
 * comparison: mean, stddev, range, winner, speedup.
 *
 * Requires the `hyperfine` binary (pacman -S hyperfine).
 *
 * Pure logic (parse/args/format/run) lives in ./lib/bench-core.ts (shared with
 * the Claude Code MCP toolkit); this file is the thin pi adapter and re-exports
 * parseHyperfineJson for the existing suite.
 * See also: ~/.pi/agent/TOOLKIT.md (workflows, canonical invocations)
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runBench } from "./lib/bench-core.ts";

export { parseHyperfineJson, type BenchResult, type BenchOutput } from "./lib/bench-core.ts";

const benchTool = defineTool({
  name: "bench",
  label: "Bench",
  promptSnippet: "bench - statistical command benchmarking via hyperfine. Returns mean/stddev/winner.",
  promptGuidelines: [
    "Provide 2+ commands to compare. Use shell quoting if a command contains spaces.",
    "Default 3 warmup runs + 10 measured runs. Bump runs for noisy environments.",
    "Use shell_none=true (default) for short commands that don't need shell features - reduces measurement noise.",
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
    const { text, details, isError } = await runBench({
      commands: params.commands,
      warmup: params.warmup,
      runs: params.runs,
      shellNone: params.shell_none,
      prepare: params.prepare,
      cwd: params.cwd ?? ctx.cwd,
    });
    return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }], details };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(benchTool);
}
