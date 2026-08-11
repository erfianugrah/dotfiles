/**
 * secret-scan - wrap `gitleaks` (default) or `noseyparker` for token-efficient
 * secret detection.
 *
 * Token economy: gitleaks JSON is one object per finding with ~15 fields.
 * This wrapper returns just the essentials: rule, file, line, secret prefix
 * (first 12 chars + length, never the full secret), commit if available.
 *
 * Two backends:
 *   - gitleaks  (default) - fast, regex-based, covers most known secret formats
 *   - noseyparker         - entropy-based + provenance tracking, smarter
 *
 * Requires gitleaks (pacman -S gitleaks) and/or noseyparker (paru -S noseyparker).
 *
 * Pure logic (parsers with the 12-char truncation, runners, orchestrator) lives
 * in ./lib/secret-scan-core.ts (shared with the Claude Code MCP toolkit); this
 * file is the thin pi adapter and re-exports the parsers for the existing suite.
 * See also: ~/.pi/agent/TOOLKIT.md (workflows, canonical invocations)
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scanSecrets } from "./lib/secret-scan-core.ts";

export { parseGitleaksJson, parseNoseyparkerJsonl, type SecretFinding } from "./lib/secret-scan-core.ts";

const secretScanTool = defineTool({
  name: "secret_scan",
  label: "Secret Scan",
  promptSnippet: "secret_scan - find leaked secrets in code. Run before commits, in pre-commit hooks, or during PR review.",
  promptGuidelines: [
    "Default backend is gitleaks (fast). Use backend='noseyparker' for smarter dedup or when gitleaks misses entropy-based secrets.",
    "Defaults to working-tree only (no git history). Set scan_history=true to also scan commits.",
    "Secret values are TRUNCATED to first 12 chars in output - the full value never appears in the agent's context.",
  ],
  description: [
    "Scan a directory for leaked secrets using gitleaks (default) or noseyparker.",
    "",
    "Returns a list of findings: rule (which detector fired), file, line, secret prefix (first 12 chars + total length), commit (if scanning git history).",
    "",
    "Secret values are intentionally truncated so the full secret never enters the agent's context window.",
  ].join("\n"),
  parameters: Type.Object({
    path: Type.Optional(
      Type.String({
        description: "Directory or repo path to scan (default: cwd). Relative resolved against cwd.",
      }),
    ),
    backend: Type.Optional(
      Type.Union([Type.Literal("gitleaks"), Type.Literal("noseyparker")], {
        description: "Scanner to use. Default: gitleaks (fast, regex). noseyparker is entropy+provenance-based.",
      }),
    ),
    scan_history: Type.Optional(
      Type.Boolean({
        description: "If true, scan git history too. Only meaningful for gitleaks. Default: false (working tree only).",
      }),
    ),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const { text, details, isError } = await scanSecrets({
      path: params.path,
      cwd: ctx.cwd,
      backend: params.backend,
      scanHistory: params.scan_history,
    });
    return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }], details };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(secretScanTool);
}
