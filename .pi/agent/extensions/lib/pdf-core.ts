/**
 * pdf-core - pure diagnostic-first PDF extraction: mode selection, argv
 * building, output projection/rendering, plus a spawn orchestrator. ZERO
 * harness imports (node stdlib + globals only). Source of truth for the pi
 * adapter (../pdf.ts) and the Claude Code MCP toolkit
 * (../../../.claude/mcp/toolkit.ts).
 *
 * Extracted from pdf.ts (2026-08-12); see
 * .pi/agent/docs/pi-to-claude-code-port.md.
 *
 * Requires poppler-utils (pdffonts/pdftotext/pdftoppm) + tesseract; tables mode
 * runs pdfplumber ephemerally under uv.
 */

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

/** Pure: build the poppler page-window flags (`-f`/`-l`) shared by pdftotext/pdftoppm. */
export function pageArgs(first?: number, last?: number): string[] {
  const a: string[] = [];
  // poppler pages are 1-based; a 0/negative/float page is invalid and also
  // disagrees with the pdfplumber path (which treats first>0). Only emit a
  // valid integer window.
  if (first != null && first > 0) a.push("-f", String(Math.floor(first)));
  if (last != null && last > 0) a.push("-l", String(Math.floor(last)));
  return a;
}

// pdfplumber table extraction runs ephemerally under uv (no system install,
// cached after first fetch). Emits GitHub-flavoured markdown tables.
export const PDFPLUMBER_SCRIPT = `import sys, pdfplumber
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

/** Pure: build the argv for the ephemeral pdfplumber (tables) invocation under uv. */
export function buildTablesArgs(target: string, first?: number, last?: number): string[] {
  return [
    "run",
    "--quiet",
    "--with",
    "pdfplumber",
    "--python",
    "3.12",
    "python",
    "-c",
    PDFPLUMBER_SCRIPT,
    target,
    String(first ?? 0),
    String(last ?? 0),
  ];
}

/** Pure: project raw pdfplumber stdout into rendered text + a found flag. */
export function renderTables(raw: string, hasTextLayer: boolean): { text: string; found: boolean } {
  const trimmed = raw.trim();
  const none = trimmed === "NO_TABLES" || trimmed === "";
  const warn = !hasTextLayer
    ? "\n(no text layer detected - pdfplumber reads born-digital tables only; use OCR for scanned tables)"
    : "";
  return { text: none ? `No tables found.${warn}` : trimmed, found: !none };
}

/** Pure: render the visual (rasterize) result - a page list for the model to `read`. */
export function renderVisual(pngs: string[], firstPage: number, dpi: number, hasTextLayer: boolean): string {
  const list = pngs.map((p, i) => `  page ${firstPage + i}: ${p}`).join("\n");
  return `Rasterized ${pngs.length} page(s) at ${dpi} DPI (text layer: ${hasTextLayer ? "present" : "none"}).\nRead these PNGs to judge layout / figures / tables:\n${list}`;
}

/** Pure: install-hint message for a missing binary. */
export function binMissingText(bin: string): string {
  const hint =
    bin === "tesseract"
      ? "`sudo pacman -S tesseract tesseract-data-eng`"
      : bin === "uv"
        ? "`curl -LsSf https://astral.sh/uv/install.sh | sh` (needed for the tables mode's ephemeral pdfplumber)"
        : "`sudo pacman -S poppler` (Arch) / `apt install poppler-utils`";
  return `${bin} not on PATH. Install: ${hint}.`;
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

// -- harness-agnostic orchestrator -------------------------------------------

export interface PdfResult {
  text: string;
  details: Record<string, unknown>;
  isError?: boolean;
}

export interface PdfOpts {
  path: string;
  cwd: string;
  mode?: string;
  first?: number;
  last?: number;
  lang?: string;
  dpi?: number;
  signal?: AbortSignal;
}

export async function extractPdf(opts: PdfOpts): Promise<PdfResult> {
  const target = isAbsolute(opts.path) ? opts.path : pathResolve(opts.cwd, opts.path);
  if (!existsSync(target)) {
    return { isError: true, text: `No such file: ${target}`, details: { error: "not-found", target } };
  }

  const signal = opts.signal;
  const dpi = opts.dpi ?? 300;
  const lang = opts.lang ?? "eng";
  const pages = pageArgs(opts.first, opts.last);

  // Step 1 - diagnostic. pdffonts tells us if there's a text layer.
  const fontsRes = await run("pdffonts", [...pages, target], signal);
  if (fontsRes.spawnErr) {
    return { isError: true, text: binMissingText("pdffonts"), details: { error: "binary-missing", binary: "pdffonts" } };
  }
  const { hasTextLayer } = parsePdffonts(fontsRes.stdout);
  const strategy = chooseStrategy({ mode: opts.mode, hasTextLayer });

  // -- tables: pdfplumber (ephemeral via uv) ---------------------------------
  if (strategy === "tables") {
    const rr = await run("uv", buildTablesArgs(target, opts.first, opts.last), signal);
    if (rr.spawnErr) {
      return { isError: true, text: binMissingText("uv"), details: { error: "binary-missing", binary: "uv" } };
    }
    if (rr.code !== 0) {
      return {
        isError: true,
        text: `pdfplumber failed (exit ${rr.code}): ${rr.stderr.slice(0, 400)}`,
        details: { strategy, code: rr.code },
      };
    }
    const { text, found } = renderTables(rr.stdout, hasTextLayer);
    return { text, details: { strategy: "tables", hasTextLayer, found } };
  }

  // -- visual: rasterize to PNGs for the model to read -----------------------
  if (strategy === "visual") {
    const outDir = join(tmpdir(), `pi-pdf-${basename(target).replace(/\W+/g, "_")}`);
    mkdirSync(outDir, { recursive: true });
    const prefix = join(outDir, "page");
    const rr = await run("pdftoppm", ["-r", String(dpi), "-png", ...pages, target, prefix], signal);
    if (rr.spawnErr) {
      return { isError: true, text: binMissingText("pdftoppm"), details: { error: "binary-missing", binary: "pdftoppm" } };
    }
    const pngs = sortPageFiles(readdirSync(outDir).filter((f) => f.endsWith(".png"))).map((f) => join(outDir, f));
    if (pngs.length === 0) {
      return {
        isError: true,
        text: `Rasterization produced no pages (pdftoppm exit ${rr.code}): ${rr.stderr.slice(0, 300)}`,
        details: { strategy, code: rr.code },
      };
    }
    return {
      text: renderVisual(pngs, opts.first ?? 1, dpi, hasTextLayer),
      details: { strategy, dpi, hasTextLayer, pages: pngs },
    };
  }

  // -- text: pdftotext, with auto-fallback to OCR when it comes back empty ----
  if (strategy === "text") {
    const rr = await run("pdftotext", ["-layout", ...pages, target, "-"], signal);
    if (rr.spawnErr) {
      return { isError: true, text: binMissingText("pdftotext"), details: { error: "binary-missing", binary: "pdftotext" } };
    }
    const a = assessText(rr.stdout);
    if (a.nonEmpty || opts.mode === "text") {
      return {
        text: rr.stdout.trim() || "(no text extracted)",
        details: { strategy: "text", hasTextLayer, ...a },
      };
    }
    // Auto mode + empty text-layer result -> fall through to OCR.
  }

  // -- ocr: rasterize then tesseract per page --------------------------------
  const tmp = mkdtempSync(join(tmpdir(), "pi-pdf-ocr-"));
  try {
    const prefix = join(tmp, "page");
    const rr = await run("pdftoppm", ["-r", String(dpi), "-png", ...pages, target, prefix], signal);
    if (rr.spawnErr) {
      return { isError: true, text: binMissingText("pdftoppm"), details: { error: "binary-missing", binary: "pdftoppm" } };
    }
    const pngs = sortPageFiles(readdirSync(tmp).filter((f) => f.endsWith(".png")));
    if (pngs.length === 0) {
      return {
        isError: true,
        text: `Rasterization produced no pages (pdftoppm exit ${rr.code}): ${rr.stderr.slice(0, 300)}`,
        details: { strategy: "ocr", code: rr.code },
      };
    }
    const parts: string[] = [];
    for (let i = 0; i < pngs.length; i++) {
      if (signal?.aborted) break;
      const png = join(tmp, pngs[i]);
      const tr = await run("tesseract", [png, "stdout", "--psm", "1", "--oem", "1", "-l", lang], signal);
      if (tr.spawnErr) {
        return { isError: true, text: binMissingText("tesseract"), details: { error: "binary-missing", binary: "tesseract" } };
      }
      const pageNo = (opts.first ?? 1) + i;
      parts.push(`--- page ${pageNo} ---\n${tr.stdout.trim()}`);
    }
    const text = parts.join("\n\n");
    const a = assessText(text.replace(/--- page \d+ ---/g, ""));
    return {
      text: text || "(OCR produced no text)",
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
}
