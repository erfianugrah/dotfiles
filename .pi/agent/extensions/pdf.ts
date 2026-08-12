/**
 * pdf - diagnostic-first PDF text extraction.
 *
 * pi's built-in `read` tool handles text + images only; it is blind to PDFs.
 * This tool fills that gap by encoding the "right tool for the job" decision
 * tree that Anthropic's own pdf skill uses under the hood:
 *
 *   1. `pdffonts`  - does the file carry a text layer?
 *   2. born-digital (fonts present) -> `pdftotext -layout`   (ms, free, exact)
 *   3. scanned     (no fonts)       -> `pdftoppm -r 300 -png` then
 *                                     `tesseract --psm 1 --oem 1`  (local OCR)
 *   4. layout/figure judgment -> rasterize pages to PNG and let the MODEL look
 *
 * The deterministic tool owns character recognition (fast, offline, no tokens,
 * reproducible). The model is held back for the fuzzy remainder - layout,
 * figures, tables - via `mode:"visual"`, which emits PNG paths for the agent
 * to `read` as images.
 *
 * Requires poppler-utils (pdffonts/pdftotext/pdftoppm) + tesseract.
 *   Arch: sudo pacman -S poppler tesseract tesseract-data-eng
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractPdf } from "./lib/pdf-core.ts";

// Re-export the pure helpers so existing importers (tests/extensions.test.ts)
// keep resolving them here; the source of truth is ./lib/pdf-core.ts.
export {
  parsePdffonts,
  assessText,
  chooseStrategy,
  sortPageFiles,
  type PdffontsResult,
  type TextAssessment,
  type Strategy,
} from "./lib/pdf-core.ts";

// -- tool --------------------------------------------------------------------

const pdfTool = defineTool({
  name: "pdf",
  label: "PDF Extract",
  promptSnippet:
    "pdf - extract text from a PDF (pi's `read` can't). Diagnoses text-layer vs scanned and routes to pdftotext or tesseract OCR automatically.",
  promptGuidelines: [
    "Use this for ANY .pdf - pi's built-in `read` tool cannot open PDFs.",
    "Leave `mode` unset for auto-routing (text layer -> pdftotext, scanned -> OCR).",
    "mode:'tables' extracts born-digital tables as markdown via pdfplumber (run ephemerally under uv).",
    "mode:'visual' rasterizes pages to PNG and returns their paths - then `read` those for layout/figure judgment (the model's job).",
    "Narrow long docs with `first`/`last` page numbers; OCR is slow (~1-2s/page).",
  ],
  description: [
    "Extract text from a PDF file. pi's built-in `read` tool handles text + images only and cannot open PDFs; this tool fills that gap.",
    "",
    "Diagnostic-first routing (auto unless `mode` is set):",
    "  - born-digital (has text layer) -> pdftotext -layout (instant, exact)",
    "  - scanned (no text layer)       -> pdftoppm 300 DPI + tesseract OCR",
    "  - mode:'tables'                 -> pdfplumber table extraction as markdown (born-digital only)",
    "  - mode:'visual'                 -> rasterize pages to PNG, return paths to `read` for layout/figures",
    "",
    "Returns extracted text plus which strategy ran and a word-count quality signal. If auto text-extraction comes back empty, it transparently falls back to OCR.",
  ].join("\n"),
  parameters: Type.Object({
    path: Type.String({ description: "Path to the PDF file. Relative paths resolve against cwd." }),
    mode: Type.Optional(
      Type.String({
        description:
          "Force a strategy: 'text' (pdftotext), 'ocr' (tesseract), 'tables' (pdfplumber -> markdown), or 'visual' (rasterize to PNG for the model to read). Omit for auto.",
      }),
    ),
    first: Type.Optional(Type.Number({ description: "First page (1-indexed) to process." })),
    last: Type.Optional(Type.Number({ description: "Last page (1-indexed) to process." })),
    lang: Type.Optional(
      Type.String({ description: "Tesseract language(s), e.g. 'eng' or 'eng+nld'. Default 'eng'. OCR only." }),
    ),
    dpi: Type.Optional(Type.Number({ description: "Rasterization DPI for OCR/visual. Default 300." })),
  }),
  async execute(_id, params, signal, _onUpdate, ctx) {
    const { text, details, isError } = await extractPdf({
      path: params.path,
      cwd: ctx.cwd,
      mode: params.mode,
      first: params.first,
      last: params.last,
      lang: params.lang,
      dpi: params.dpi,
      signal,
    });
    return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }], details };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(pdfTool);
}
