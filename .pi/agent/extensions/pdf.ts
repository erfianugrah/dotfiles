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
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve as pathResolve } from "node:path";

const RUN_TIMEOUT_MS = 240_000;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

// -- pure helpers (unit-tested) ---------------------------------------------

export interface PdffontsResult {
  fonts: string[];
  hasTextLayer: boolean;
}

/**
 * Parse `pdffonts` output. A born-digital PDF lists one row per embedded font
 * beneath a two-line header (column names + a dashed separator). A scanned PDF
 * prints only the header (or nothing) - no font rows - so `hasTextLayer` is
 * false and the caller should route to OCR.
 */
export function parsePdffonts(raw: string): PdffontsResult {
  const lines = raw.split(/\r?\n/);
  const fonts: string[] = [];
  let pastSeparator = false;
  for (const line of lines) {
    // The separator row is a run of dashes and spaces, e.g. "----- -----".
    if (/^[-\s]*-{3,}[-\s]*$/.test(line) && line.includes("-")) {
      pastSeparator = true;
      continue;
    }
    if (!pastSeparator) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Font name is the first whitespace-delimited column.
    const name = trimmed.split(/\s+/)[0];
    if (name) fonts.push(name);
  }
  return { fonts, hasTextLayer: fonts.length > 0 };
}

export interface TextAssessment {
  chars: number;
  words: number;
  nonEmpty: boolean;
}

/** Cheap quality signal so the caller knows whether an extraction came back thin. */
export function assessText(text: string): TextAssessment {
  const trimmed = text.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  return { chars: trimmed.length, words, nonEmpty: trimmed.length > 0 };
}

export type Strategy = "text" | "ocr" | "visual" | "tables";

/**
 * Route decision. An explicit `mode` always wins; otherwise the presence of a
 * text layer decides between fast text extraction and OCR.
 */
export function chooseStrategy(opts: { mode?: string; hasTextLayer: boolean }): Strategy {
  if (opts.mode === "text" || opts.mode === "ocr" || opts.mode === "visual" || opts.mode === "tables") {
    return opts.mode;
  }
  return opts.hasTextLayer ? "text" : "ocr";
}

/** Numerically sort pdftoppm output files (page-1.png, page-2.png, ... page-10.png). */
export function sortPageFiles(names: string[]): string[] {
  const num = (s: string) => {
    const m = s.match(/(\d+)(?=\.\w+$)/);
    return m ? Number.parseInt(m[1], 10) : 0;
  };
  return [...names].sort((a, b) => num(a) - num(b));
}

// -- spawn helper ------------------------------------------------------------

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  spawnErr: boolean;
}

function run(cmd: string, args: string[], signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolveP) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, RUN_TIMEOUT_MS);
    const onAbort = () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    proc.stdout.on("data", (b: Buffer) => {
      bytes += b.length;
      if (bytes > MAX_TEXT_BYTES) {
        truncated = true;
        return;
      }
      out.push(b);
    });
    proc.stderr.on("data", (b: Buffer) => err.push(b));
    proc.on("error", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolveP({ code: 127, stdout: "", stderr: `${cmd} not found on PATH`, spawnErr: true });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(out).toString("utf-8") + (truncated ? "\n[...truncated]" : "");
      resolveP({ code: code ?? 1, stdout, stderr: Buffer.concat(err).toString("utf-8"), spawnErr: false });
    });
  });
}

function pageArgs(first?: number, last?: number): string[] {
  const a: string[] = [];
  if (first != null) a.push("-f", String(first));
  if (last != null) a.push("-l", String(last));
  return a;
}

// pdfplumber table extraction runs ephemerally under uv (no system install,
// cached after first fetch). Emits GitHub-flavoured markdown tables.
const PDFPLUMBER_SCRIPT = `import sys, pdfplumber
path, first, last = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
def md(rows):
    rows = [[('' if c is None else str(c).replace('|', '\\\\|').replace(chr(10), ' ')) for c in r] for r in rows]
    if not rows:
        return ''
    w = max(len(r) for r in rows)
    rows = [r + [''] * (w - len(r)) for r in rows]
    out = ['| ' + ' | '.join(rows[0]) + ' |', '| ' + ' | '.join(['---'] * w) + ' |']
    for r in rows[1:]:
        out.append('| ' + ' | '.join(r) + ' |')
    return chr(10).join(out)
with pdfplumber.open(path) as pdf:
    pages = pdf.pages
    lo = (first - 1) if first > 0 else 0
    hi = last if last > 0 else len(pages)
    n = 0
    for idx in range(lo, min(hi, len(pages))):
        for t in pages[idx].extract_tables():
            n += 1
            print(chr(10) + '### table %d (page %d)' % (n, idx + 1) + chr(10))
            print(md(t))
    if n == 0:
        print('NO_TABLES')
`;

function binMissing(bin: string) {
  const hint =
    bin === "tesseract"
      ? "`sudo pacman -S tesseract tesseract-data-eng`"
      : bin === "uv"
        ? "`curl -LsSf https://astral.sh/uv/install.sh | sh` (needed for the tables mode's ephemeral pdfplumber)"
        : "`sudo pacman -S poppler` (Arch) / `apt install poppler-utils`";
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `${bin} not on PATH. Install: ${hint}.` }],
    details: { error: "binary-missing", binary: bin },
  };
}

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
    const target = isAbsolute(params.path) ? params.path : pathResolve(ctx.cwd, params.path);
    if (!existsSync(target)) {
      return {
        isError: true,
        content: [{ type: "text", text: `No such file: ${target}` }],
        details: { error: "not-found", target },
      };
    }

    const dpi = params.dpi ?? 300;
    const lang = params.lang ?? "eng";
    const pages = pageArgs(params.first, params.last);

    // Step 1 - diagnostic. pdffonts tells us if there's a text layer.
    const fontsRes = await run("pdffonts", [...pages, target], signal);
    if (fontsRes.spawnErr) return binMissing("pdffonts");
    const { hasTextLayer } = parsePdffonts(fontsRes.stdout);
    const strategy = chooseStrategy({ mode: params.mode, hasTextLayer });

    // -- tables: pdfplumber (ephemeral via uv) --------------------------------
    if (strategy === "tables") {
      const script = PDFPLUMBER_SCRIPT;
      const rr = await run(
        "uv",
        ["run", "--quiet", "--with", "pdfplumber", "--python", "3.12", "python", "-c", script, target, String(params.first ?? 0), String(params.last ?? 0)],
        signal,
      );
      if (rr.spawnErr) return binMissing("uv");
      if (rr.code !== 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `pdfplumber failed (exit ${rr.code}): ${rr.stderr.slice(0, 400)}` }],
          details: { strategy, code: rr.code },
        };
      }
      const raw = rr.stdout.trim();
      const none = raw === "NO_TABLES" || raw === "";
      const warn = !hasTextLayer
        ? "\n(no text layer detected - pdfplumber reads born-digital tables only; use OCR for scanned tables)"
        : "";
      return {
        content: [
          { type: "text", text: none ? `No tables found.${warn}` : raw },
        ],
        details: { strategy: "tables", hasTextLayer, found: !none },
      };
    }

    // -- visual: rasterize to PNGs for the model to read ----------------------
    if (strategy === "visual") {
      const outDir = join(tmpdir(), `pi-pdf-${basename(target).replace(/\W+/g, "_")}`);
      mkdirSync(outDir, { recursive: true });
      const prefix = join(outDir, "page");
      const rr = await run("pdftoppm", ["-r", String(dpi), "-png", ...pages, target, prefix], signal);
      if (rr.spawnErr) return binMissing("pdftoppm");
      const pngs = sortPageFiles(readdirSync(outDir).filter((f) => f.endsWith(".png"))).map((f) => join(outDir, f));
      if (pngs.length === 0) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Rasterization produced no pages (pdftoppm exit ${rr.code}): ${rr.stderr.slice(0, 300)}` },
          ],
          details: { strategy, code: rr.code },
        };
      }
      const list = pngs.map((p, i) => `  page ${(params.first ?? 1) + i}: ${p}`).join("\n");
      return {
        content: [
          {
            type: "text",
            text: `Rasterized ${pngs.length} page(s) at ${dpi} DPI (text layer: ${hasTextLayer ? "present" : "none"}).\nRead these PNGs to judge layout / figures / tables:\n${list}`,
          },
        ],
        details: { strategy, dpi, hasTextLayer, pages: pngs },
      };
    }

    // -- text: pdftotext, with auto-fallback to OCR when it comes back empty ---
    if (strategy === "text") {
      const rr = await run("pdftotext", ["-layout", ...pages, target, "-"], signal);
      if (rr.spawnErr) return binMissing("pdftotext");
      const a = assessText(rr.stdout);
      if (a.nonEmpty || params.mode === "text") {
        return {
          content: [{ type: "text", text: rr.stdout.trim() || "(no text extracted)" }],
          details: { strategy: "text", hasTextLayer, ...a },
        };
      }
      // Auto mode + empty text-layer result -> fall through to OCR.
    }

    // -- ocr: rasterize then tesseract per page -------------------------------
    const tmp = mkdtempSync(join(tmpdir(), "pi-pdf-ocr-"));
    try {
      const prefix = join(tmp, "page");
      const rr = await run("pdftoppm", ["-r", String(dpi), "-png", ...pages, target, prefix], signal);
      if (rr.spawnErr) return binMissing("pdftoppm");
      const pngs = sortPageFiles(readdirSync(tmp).filter((f) => f.endsWith(".png")));
      if (pngs.length === 0) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Rasterization produced no pages (pdftoppm exit ${rr.code}): ${rr.stderr.slice(0, 300)}` },
          ],
          details: { strategy: "ocr", code: rr.code },
        };
      }
      const parts: string[] = [];
      for (let i = 0; i < pngs.length; i++) {
        if (signal?.aborted) break;
        const png = join(tmp, pngs[i]);
        const tr = await run("tesseract", [png, "stdout", "--psm", "1", "--oem", "1", "-l", lang], signal);
        if (tr.spawnErr) return binMissing("tesseract");
        const pageNo = (params.first ?? 1) + i;
        parts.push(`--- page ${pageNo} ---\n${tr.stdout.trim()}`);
      }
      const text = parts.join("\n\n");
      const a = assessText(text.replace(/--- page \d+ ---/g, ""));
      return {
        content: [{ type: "text", text: text || "(OCR produced no text)" }],
        details: {
          strategy: "ocr",
          hasTextLayer,
          dpi,
          lang,
          pages: pngs.length,
          words: a.words,
          note: hasTextLayer ? "OCR ran despite a text layer (fell back from empty pdftotext output)" : undefined,
        },
      };
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(pdfTool);
}
