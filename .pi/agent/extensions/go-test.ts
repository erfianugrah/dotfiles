/**
 * go-test — wrap `go test -json ./...` for token-efficient test triage.
 *
 * `go test -json` streams one JSON object per test event (start, output,
 * pass, fail, skip). For agent workflows we only need: which tests failed,
 * the last N lines of their output, and the overall pass count.
 *
 * This wrapper buffers the stream, extracts only fail events with their
 * accumulated output lines, and returns a compact summary.
 *
 * Common usage:
 *   go_test                                    # whole repo
 *   go_test pattern="./internal/..."           # subdir
 *   go_test pattern="./..." run="TestRoomWS"   # filter by name regex
 *
 * Requires Go on PATH (you already have it for bonkled).
 * See also: ~/.pi/agent/TOOLKIT.md (workflows, canonical invocations)
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { isAbsolute, resolve as pathResolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 min hard cap; --timeout passed to go test
const MAX_OUTPUT_LINES_PER_TEST = 30;

// ── flattened test event types ────────────────────────────────────────────

export interface TestFailure {
  package: string;
  test: string;
  outputExcerpt: string; // last N lines of accumulated output
  elapsed?: number;
}

export interface TestSummary {
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  packagesWithFailures: string[];
  failures: TestFailure[];
  buildErrors: string[];
}

interface GoTestEvent {
  Time?: string;
  Action?: "start" | "run" | "pause" | "cont" | "pass" | "bench" | "fail" | "output" | "skip";
  Package?: string;
  Test?: string;
  Elapsed?: number;
  Output?: string;
}

// Exported for unit tests.
export function parseGoTestJson(jsonl: string): TestSummary {
  const outputByKey = new Map<string, string[]>();
  let totalTests = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const packagesWithFailures = new Set<string>();
  const failures: TestFailure[] = [];
  const buildErrors: string[] = [];

  for (const line of jsonl.split("\n")) {
    if (!line.trim() || !line.startsWith("{")) continue;
    let ev: GoTestEvent;
    try {
      ev = JSON.parse(line) as GoTestEvent;
    } catch {
      continue;
    }
    const pkg = ev.Package ?? "(unknown)";
    const test = ev.Test ?? "";
    const key = `${pkg}::${test}`;

    if (ev.Action === "output" && ev.Output) {
      const buf = outputByKey.get(key) ?? [];
      buf.push(ev.Output);
      outputByKey.set(key, buf);

      // Capture build errors (test == "" with FAIL or build failed in output)
      if (test === "" && /FAIL\s+|build failed|cannot find|undefined:|undeclared/i.test(ev.Output)) {
        buildErrors.push(`${pkg}: ${ev.Output.trim()}`);
      }
      continue;
    }

    if (!test) {
      // package-level event
      if (ev.Action === "fail") packagesWithFailures.add(pkg);
      continue;
    }

    if (ev.Action === "run") {
      totalTests++;
    } else if (ev.Action === "pass") {
      passed++;
    } else if (ev.Action === "skip") {
      skipped++;
    } else if (ev.Action === "fail") {
      failed++;
      packagesWithFailures.add(pkg);
      const outputLines = outputByKey.get(key) ?? [];
      const trimmed = outputLines
        .filter((l) => !/^=== RUN\b|^=== PAUSE\b|^=== CONT\b|^--- FAIL: \w+/.test(l.trim()))
        .slice(-MAX_OUTPUT_LINES_PER_TEST)
        .map((l) => l.replace(/\n$/, ""))
        .join("\n");
      failures.push({ package: pkg, test, outputExcerpt: trimmed, elapsed: ev.Elapsed });
    }
  }

  return {
    totalTests,
    passed,
    failed,
    skipped,
    packagesWithFailures: [...packagesWithFailures].sort(),
    failures,
    buildErrors: [...new Set(buildErrors)],
  };
}

// ── spawn ─────────────────────────────────────────────────────────────────

async function runGoTest(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string; code: number; binaryMissing: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn("go", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, DEFAULT_TIMEOUT_MS);
    proc.stdout.on("data", (b: Buffer) => stdoutChunks.push(b));
    proc.stderr.on("data", (b: Buffer) => stderrChunks.push(b));
    proc.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: "", stderr: "go not on PATH", code: 127, binaryMissing: true });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
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

// ── tool definition ───────────────────────────────────────────────────────

const goTestTool = defineTool({
  name: "go_test",
  label: "Go Test",
  promptSnippet: "go_test \u2014 run `go test -json` and return only failures + summary. Token-efficient triage.",
  promptGuidelines: [
    "Default pattern='./...' runs whole module. Use pattern='./internal/foo/...' to narrow.",
    "Use run='TestPattern' to filter by test name regex (go test -run flag).",
    "If failures exceed token budget, use shorter run= regex or scope pattern= further.",
  ],
  description: [
    "Run `go test -json <pattern>` and return ONLY the failures + summary, not the full stream.",
    "",
    "Returns: total/passed/failed/skipped counts, list of failures with the last 30 output lines per test, and any build errors.",
    "",
    "Hint: the default `pattern` of `./...` runs the whole module. Most agent loops want a narrower pattern + the `run` regex to focus on the test under investigation.",
  ].join("\n"),
  parameters: Type.Object({
    pattern: Type.Optional(
      Type.String({ description: "Package pattern, default './...'. Examples: './internal/foo', './pkg/x/...'." }),
    ),
    run: Type.Optional(
      Type.String({ description: "Regex passed to `go test -run`. Filters tests by name. Examples: 'TestFoo', 'TestParse_.*JSON'." }),
    ),
    timeout: Type.Optional(
      Type.String({ description: "Per-test timeout (passed to go test -timeout). Default '5m'." }),
    ),
    race: Type.Optional(
      Type.Boolean({ description: "Pass -race for race detector. Default false (slower)." }),
    ),
    count: Type.Optional(
      Type.Number({ description: "Run each test N times (-count=N). Default 1." }),
    ),
    short: Type.Optional(
      Type.Boolean({ description: "Pass -short to skip long tests. Default false." }),
    ),
    cwd: Type.Optional(
      Type.String({ description: "Working directory (default: pi cwd). Relative or absolute." }),
    ),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const rawCwd = params.cwd ?? ctx.cwd;
    const workCwd = isAbsolute(rawCwd) ? rawCwd : pathResolve(ctx.cwd, rawCwd);

    const args = ["test", "-json"];
    args.push("-timeout", params.timeout ?? "5m");
    if (params.race) args.push("-race");
    if (params.short) args.push("-short");
    if (params.count && params.count > 1) args.push(`-count=${Math.floor(params.count)}`);
    if (params.run) args.push("-run", params.run);
    args.push(params.pattern ?? "./...");

    const run = await runGoTest(args, workCwd);
    if (run.binaryMissing) {
      return {
        isError: true,
        content: [{ type: "text", text: "`go` not on PATH. Install Go toolchain." }],
        details: { error: "binary-missing" },
      };
    }

    const summary = parseGoTestJson(run.stdout);
    const isPass = summary.failed === 0 && summary.buildErrors.length === 0 && run.code === 0;

    if (isPass) {
      return {
        content: [
          {
            type: "text",
            text: `${summary.passed} passed, ${summary.skipped} skipped (${summary.totalTests} tests) in ${workCwd} \u2014 ${params.pattern ?? "./..."}`,
          },
        ],
        details: { ...summary, ok: true, pattern: params.pattern ?? "./...", cwd: workCwd, exitCode: run.code },
      };
    }

    // Failure path: render compact failure block
    const buildBlock = summary.buildErrors.length > 0 ? `Build errors:\n${summary.buildErrors.slice(0, 10).join("\n")}\n\n` : "";
    const failureBlocks = summary.failures.map((f) => {
      return `--- FAIL ${f.package} :: ${f.test} (${f.elapsed?.toFixed(2) ?? "?"}s)\n${f.outputExcerpt}`;
    });
    const text =
      `${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped (${summary.totalTests} total). Exit ${run.code}.\n\n` +
      buildBlock +
      failureBlocks.join("\n\n");

    return {
      isError: true,
      content: [{ type: "text", text }],
      details: { ...summary, ok: false, pattern: params.pattern ?? "./...", cwd: workCwd, exitCode: run.code },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(goTestTool);
}
