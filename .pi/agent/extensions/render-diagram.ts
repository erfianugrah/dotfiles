/**
 * render_diagram — validate + render mermaid / d2 diagrams to SVG or PNG.
 *
 * The agent is best at writing diagram source (text). Local CLIs (mmdc for
 * mermaid, d2 for d2) handle the rendering deterministically. This tool
 * wraps both so the agent can:
 *
 *   1. Validate syntax before committing diagrams to docs (catch typos that
 *      would silently produce broken renders).
 *   2. Render to SVG for embedding in markdown / docs.
 *   3. Render to PNG for slides / social / docs where SVG isn't supported.
 *
 * Both CLIs are pre-installed:
 *   - mmdc (mermaid-cli): uses puppeteer, ~3-5s per render
 *   - d2: single Go binary, instant
 *
 * The agent writes diagram source inline (no separate "generate" step) and
 * passes it here. If output path is omitted, the SVG content is returned in
 * the tool result so the agent can inspect / iterate before saving.
 *
 * Pure logic lives in ./lib/render-diagram-core.ts (shared with the Claude
 * Code MCP toolkit); this file is the thin pi adapter.
 *
 * For diagram syntax guidance see the `mermaid-d2` skill.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderDiagram } from "./lib/render-diagram-core.ts";

const renderDiagramTool = defineTool({
  name: "render_diagram",
  label: "Render Diagram",
  promptSnippet: "render_diagram — mermaid/d2 to SVG/PNG. Validates syntax.",
  promptGuidelines: [
    "d2 for system architecture (cleaner, faster); mermaid for sequence/gantt/ER.",
  ],
  description:
    "Render mermaid/d2 source to SVG (default) or PNG. PNG requires outputPath. Syntax errors returned as text.",

  parameters: Type.Object({
    language: Type.Union([Type.Literal("mermaid"), Type.Literal("d2")], {
      description: "Diagram language",
    }),
    source: Type.String({ description: "Diagram source code (mermaid or d2 syntax)" }),
    outputPath: Type.Optional(
      Type.String({
        description:
          "Where to write the rendered file (absolute or relative to cwd). Required for PNG. If omitted for SVG, content is returned in tool output.",
      }),
    ),
    format: Type.Optional(
      Type.Union([Type.Literal("svg"), Type.Literal("png")], {
        description: "Output format (default: svg)",
      }),
    ),
    theme: Type.Optional(
      Type.String({
        description:
          "Theme name. mermaid: 'default'|'dark'|'forest'|'neutral'. d2: theme id from `d2 themes` (e.g. '0' neutral default, '3' flagship, '200' dark mauve, '201' dark flagship, '300' terminal, '302' origami). Omit for default.",
      }),
    ),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const { text, details, isError } = await renderDiagram({
      language: params.language,
      source: params.source,
      cwd: ctx.cwd,
      outputPath: params.outputPath,
      format: params.format,
      theme: params.theme,
    });
    return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }], details };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(renderDiagramTool);
}
