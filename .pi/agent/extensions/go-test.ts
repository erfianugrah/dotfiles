/**
 * go-test - wrap `go test -json ./...` for token-efficient test triage.
 *
 * `go test -json` streams one JSON object per test event. For agent workflows
 * we only need: which tests failed, the last N lines of their output, and the
 * overall pass count. This wrapper buffers the stream, extracts only fail
 * events with their accumulated output, and returns a compact summary.
 *
 * Requires Go on PATH.
 *
 * Pure logic (parse/args/render/run) lives in ./lib/go-test-core.ts (shared
 * with the Claude Code MCP toolkit); this file is the thin pi adapter and
 * re-exports parseGoTestJson for the existing suite.
 * See also: ~/.pi/agent/TOOLKIT.md (workflows, canonical invocations)
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAbsolute, resolve as pathResolve } from "node:path";
import { runGoTests } from "./lib/go-test-core.ts";

export { parseGoTestJson, type TestFailure, type TestSummary } from "./lib/go-test-core.ts";

const goTestTool = defineTool({
  name: "go_test",
  label: "Go Test",
  promptSnippet: "go_test - run `go test -json` and return only failures + summary. Token-efficient triage.",
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
    race: Type.Optional(Type.Boolean({ description: "Pass -race for race detector. Default false (slower)." })),
    count: Type.Optional(Type.Number({ description: "Run each test N times (-count=N). Default 1." })),
    short: Type.Optional(Type.Boolean({ description: "Pass -short to skip long tests. Default false." })),
    cwd: Type.Optional(Type.String({ description: "Working directory (default: pi cwd). Relative or absolute." })),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const rawCwd = params.cwd ?? ctx.cwd;
    const workCwd = isAbsolute(rawCwd) ? rawCwd : pathResolve(ctx.cwd, rawCwd);
    const { text, details, isError } = await runGoTests({
      pattern: params.pattern,
      run: params.run,
      timeout: params.timeout,
      race: params.race,
      count: params.count,
      short: params.short,
      cwd: workCwd,
    });
    return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }], details };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(goTestTool);
}
