/**
 * go-test-core - pure `go test -json` projection, arg-building, rendering, and
 * a spawn orchestrator. ZERO harness imports. Source of truth for the pi
 * adapter (../go-test.ts) and the Claude Code MCP toolkit
 * (../../../.claude/mcp/toolkit.ts).
 *
 * Extracted from go-test.ts (2026-08-11); see
 * .pi/agent/docs/pi-to-claude-code-port.md.
 */

import { spawn } from "node:child_process";
import { isAbsolute, resolve as pathResolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 min hard cap on the child process
const MAX_OUTPUT_LINES_PER_TEST = 30;

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
  Action?: "start" | "run" | "pause" | "cont" | "pass" | "bench" | "fail" | "output" | "skip";
  Package?: string;
  Test?: string;
  Elapsed?: number;
  Output?: string;
}

// Pure function over `go test -json` output. Exported for unit tests.
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

export interface GoTestOpts {
  pattern?: string;
  run?: string;
  timeout?: string;
  race?: boolean;
  count?: number;
  short?: boolean;
}

// Pure: build the `go` argv. Exported for unit tests.
export function buildGoTestArgs(opts: GoTestOpts): string[] {
  const args = ["test", "-json", "-timeout", opts.timeout ?? "5m"];
  if (opts.race) args.push("-race");
  if (opts.short) args.push("-short");
  if (opts.count && opts.count > 1) args.push(`-count=${Math.floor(opts.count)}`);
  if (opts.run) args.push("-run", opts.run);
  args.push(opts.pattern ?? "./...");
  return args;
}

// Pure: render a summary to { text, isError }. Exported for unit tests.
export function renderGoTest(
  summary: TestSummary,
  ctx: { pattern: string; cwd: string; exitCode: number },
): { text: string; isError: boolean } {
  const isPass = summary.failed === 0 && summary.buildErrors.length === 0 && ctx.exitCode === 0;
  if (isPass) {
    return {
      isError: false,
      text: `${summary.passed} passed, ${summary.skipped} skipped (${summary.totalTests} tests) in ${ctx.cwd} - ${ctx.pattern}`,
    };
  }
  const buildBlock = summary.buildErrors.length > 0 ? `Build errors:\n${summary.buildErrors.slice(0, 10).join("\n")}\n\n` : "";
  const failureBlocks = summary.failures.map(
    (f) => `--- FAIL ${f.package} :: ${f.test} (${f.elapsed?.toFixed(2) ?? "?"}s)\n${f.outputExcerpt}`,
  );
  const text =
    `${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped (${summary.totalTests} total). Exit ${ctx.exitCode}.\n\n` +
    buildBlock +
    failureBlocks.join("\n\n");
  return { isError: true, text };
}

// -- spawn -------------------------------------------------------------------

async function runGoTest(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number; binaryMissing: boolean }> {
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
      resolve({ stdout: "", stderr: "go not on PATH", code: 127, binaryMissing: true });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        code: code ?? 1,
        binaryMissing: false,
      });
    });
  });
}

// -- harness-agnostic orchestrator -------------------------------------------

export interface GoTestResult {
  text: string;
  details: Record<string, unknown>;
  isError?: boolean;
}

export async function runGoTests(opts: GoTestOpts & { cwd: string }): Promise<GoTestResult> {
  const workCwd = isAbsolute(opts.cwd) ? opts.cwd : pathResolve(process.cwd(), opts.cwd);
  const pattern = opts.pattern ?? "./...";

  const run = await runGoTest(buildGoTestArgs(opts), workCwd);
  if (run.binaryMissing) {
    return { isError: true, text: "`go` not on PATH. Install the Go toolchain.", details: { error: "binary-missing" } };
  }

  const summary = parseGoTestJson(run.stdout);
  const { text, isError } = renderGoTest(summary, { pattern, cwd: workCwd, exitCode: run.code });
  return {
    ...(isError ? { isError: true } : {}),
    text,
    details: { ...summary, ok: !isError, pattern, cwd: workCwd, exitCode: run.code },
  };
}
