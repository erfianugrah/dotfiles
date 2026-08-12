/**
 * build_favicon_set — generate the full PWA favicon artifact set from a
 * single SVG or high-res PNG source.
 *
 * Inputs: an SVG string OR a path to a high-res PNG (recommended >=512x512).
 *
 * Outputs (written to `outDir`):
 *   - favicon.ico      — multi-resolution .ico (16, 32, 48 px)
 *   - favicon-16.png   — for legacy <link rel="icon" sizes="16x16">
 *   - favicon-32.png   — for <link rel="icon" sizes="32x32">
 *   - apple-touch-icon.png  — 180x180 for iOS home screen
 *   - icon-192.png     — PWA manifest icon
 *   - icon-512.png     — PWA manifest icon
 *   - icon-maskable.png — 512x512 maskable variant for adaptive icons
 *   - site.webmanifest — PWA manifest stub
 *   - favicon.svg      — original SVG if input was SVG
 *
 * The tool also returns an HTML `<head>` snippet ready to paste into a layout.
 *
 * Tooling: rsvg-convert (SVG->PNG rasterization) + ImageMagick `magick`
 * (PNG->ICO multi-res, PNG resizing, transparent background). Both pre-checked
 * as installed on this machine.
 *
 * Pure logic lives in ./lib/build-favicon-set-core.ts (shared with the Claude
 * Code MCP toolkit); this file is the thin pi adapter.
 *
 * Companion skill: `favicons-and-icons`.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildFaviconSet } from "./lib/build-favicon-set-core.ts";

export {
  htmlSnippet,
  manifestJson,
  planSizes,
  generatedList,
  buildFaviconSet,
} from "./lib/build-favicon-set-core.ts";

const buildFaviconSetTool = defineTool({
  name: "build_favicon_set",
  label: "Build Favicon Set",
  promptSnippet: "build_favicon_set — SVG/PNG → full PWA favicon artifact set + HTML snippet.",
  promptGuidelines: [
    "Prefer SVG input over PNG for geometric marks (better at 16/32px).",
  ],
  description: [
    "PWA favicon artifact set from SVG or >=512px PNG.",
    "Writes to outDir: favicon.ico (16/32/48), favicon-16.png, favicon-32.png, apple-touch-icon.png (180), icon-192.png, icon-512.png, icon-maskable.png (with 80% safe-zone), site.webmanifest, favicon.svg (if SVG input).",
    "Returns HTML <head> snippet.",
  ].join("\n"),
  parameters: Type.Object({
    svg: Type.Optional(Type.String({ description: "SVG source string. Mutually exclusive with pngPath." })),
    pngPath: Type.Optional(
      Type.String({ description: "Path to high-res PNG (>=512x512 ideal). Mutually exclusive with svg." }),
    ),
    outDir: Type.String({ description: "Output directory (absolute or relative to cwd, e.g. 'public' or 'static')" }),
    name: Type.Optional(Type.String({ description: "Filename prefix for favicon.ico/svg/-16/-32 (default: 'favicon')" })),
    manifestName: Type.Optional(
      Type.String({ description: "App name for site.webmanifest (default: 'App')" }),
    ),
    manifestShortName: Type.Optional(
      Type.String({ description: "Short name for site.webmanifest (default: same as manifestName, max 12 chars recommended)" }),
    ),
    themeColor: Type.Optional(Type.String({ description: "PWA theme color (default: '#000000')" })),
    backgroundColor: Type.Optional(Type.String({ description: "PWA background color (default: '#ffffff')" })),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const { text, details, isError } = await buildFaviconSet({
      svg: params.svg,
      pngPath: params.pngPath,
      outDir: params.outDir,
      cwd: ctx.cwd,
      name: params.name,
      manifestName: params.manifestName,
      manifestShortName: params.manifestShortName,
      themeColor: params.themeColor,
      backgroundColor: params.backgroundColor,
    });
    return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }], details };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(buildFaviconSetTool);
}
