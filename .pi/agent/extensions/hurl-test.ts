/**
 * hurl-test - run a .hurl file and return only the failing entries.
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
 *
 * Pure logic (parse/render/run) lives in ./lib/hurl-core.ts (shared with the
 * Claude Code MCP toolkit); this file is the thin pi adapter and re-exports
 * parseHurlJson for the existing suite.
 * See also: ~/.pi/agent/TOOLKIT.md (workflows, canonical invocations)
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runHurlTest } from "./lib/hurl-core.ts";

export { parseHurlJson, type HurlEntryResult } from "./lib/hurl-core.ts";

const hurlTestTool = defineTool({
  name: "hurl_test",
  label: "Hurl Test",
  promptSnippet: "hurl_test - run a .hurl file, return failures only. Declarative HTTP integration testing.",
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
    "Hurl files are declarative HTTP scripts - see https://hurl.dev/ for syntax. They support assertions, captures, JSON path, and variable substitution.",
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
    const { text, details, isError } = await runHurlTest({
      file: params.file,
      cwd: ctx.cwd,
      variables: params.variables,
    });
    return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }], details };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(hurlTestTool);
}
