/**
 * osv-scan - wrap `osv-scanner` for token-efficient vuln lookups.
 *
 * The raw `osv-scanner` JSON output is nested 4 levels deep with a lot of
 * fields the agent doesn't need. This extension flattens to one line per
 * vulnerability with just the actionable bits: package, version, ecosystem,
 * vuln ID, severity, fixed version, summary.
 *
 * Use this when:
 *   - You want a CVE check on the current repo
 *   - Reviewing whether a dep bump is safe
 *   - Periodic security audit during refactors
 *
 * Requires the `osv-scanner` binary (pacman -S osv-scanner).
 *
 * Pure logic lives in ./lib/osv-core.ts (shared with the Claude Code MCP
 * toolkit); this file is the thin pi adapter and re-exports parseOsvJson so
 * existing importers (tests/extensions.test.ts) keep resolving it here.
 * See also: ~/.pi/agent/TOOLKIT.md (workflows, canonical invocations)
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scanOsv } from "./lib/osv-core.ts";

export { parseOsvJson, type FlatVuln } from "./lib/osv-core.ts";

const osvScanTool = defineTool({
  name: "osv_scan",
  label: "OSV Scan",
  promptSnippet: "osv_scan - vuln scan via osv-scanner. Use before deploys / dep bumps.",
  promptGuidelines: [
    "Default scans cwd. Pass `lockfile` to scan a specific lockfile only.",
    "Result is flattened - one entry per (package, vulnerability_id) pair.",
  ],
  description: [
    "Run osv-scanner against a directory or lockfile and return a flattened list of vulnerabilities.",
    "",
    "Each entry contains: package, version, ecosystem, id (e.g. GHSA-xxx / CVE-yyyy-N / GO-zzz), aliases, severity, fixed version, summary, source path.",
    "",
    "Covers all ecosystems osv-scanner supports (Go modules, npm/pnpm/yarn, Cargo, pip/poetry, Composer, Maven, NuGet, RubyGems, ...).",
  ].join("\n"),
  parameters: Type.Object({
    path: Type.Optional(
      Type.String({
        description: "Directory or lockfile to scan (default: cwd). Relative paths resolved against cwd.",
      }),
    ),
    lockfile_only: Type.Optional(
      Type.Boolean({
        description: "If true, treat `path` as a single lockfile via -L. Default: recursive directory scan via -r.",
      }),
    ),
    include_dev: Type.Optional(
      Type.Boolean({
        description: "Include dev dependencies (--include-dev). Default: false.",
      }),
    ),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const { text, details, isError } = await scanOsv({
      path: params.path,
      cwd: ctx.cwd,
      lockfileOnly: params.lockfile_only,
      includeDev: params.include_dev,
    });
    return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }], details };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(osvScanTool);
}
