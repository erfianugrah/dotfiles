/**
 * pdf-core unit tests - pure pdffonts parsing, mode selection, page-window +
 * tables arg-building, and output projection/rendering. No poppler/tesseract/uv
 * binaries needed (the live run is covered by the pi e2e suite / marked
 * [blocked: needs binary] in the port doc).
 *
 *   bun test extensions/tests/pdf-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  assessText,
  buildTablesArgs,
  chooseStrategy,
  binMissingText,
  pageArgs,
  parsePdffonts,
  PDFPLUMBER_SCRIPT,
  renderTables,
  renderVisual,
  sortPageFiles,
} from "../lib/pdf-core.ts";

// A real `pdffonts` born-digital listing: header + dashed separator + font rows.
const PDFFONTS_BORN_DIGITAL = `name                                 type              encoding         emb sub uni object ID
------------------------------------ ----------------- ---------------- --- --- --- ---------
ABCDEE+Calibri                       TrueType          WinAnsi          yes yes yes      9  0
ABCDEE+Calibri-Bold                  TrueType          WinAnsi          yes yes yes     12  0
`;

// A scanned PDF: header + separator but zero font rows.
const PDFFONTS_SCANNED = `name                                 type              encoding         emb sub uni object ID
------------------------------------ ----------------- ---------------- --- --- --- ---------
`;

describe("pdf-core.parsePdffonts", () => {
  test("born-digital: collects font rows below the separator, hasTextLayer=true", () => {
    const r = parsePdffonts(PDFFONTS_BORN_DIGITAL);
    expect(r.hasTextLayer).toBe(true);
    expect(r.fonts).toEqual(["ABCDEE+Calibri", "ABCDEE+Calibri-Bold"]);
  });
  test("scanned: header only, no fonts -> hasTextLayer=false", () => {
    const r = parsePdffonts(PDFFONTS_SCANNED);
    expect(r.hasTextLayer).toBe(false);
    expect(r.fonts).toEqual([]);
  });
  test("empty output -> no text layer", () => {
    expect(parsePdffonts("").hasTextLayer).toBe(false);
  });
});

describe("pdf-core.chooseStrategy", () => {
  test("explicit mode always wins over the diagnostic", () => {
    expect(chooseStrategy({ mode: "tables", hasTextLayer: false })).toBe("tables");
    expect(chooseStrategy({ mode: "visual", hasTextLayer: true })).toBe("visual");
    expect(chooseStrategy({ mode: "ocr", hasTextLayer: true })).toBe("ocr");
    expect(chooseStrategy({ mode: "text", hasTextLayer: false })).toBe("text");
  });
  test("auto: text layer -> text, none -> ocr", () => {
    expect(chooseStrategy({ hasTextLayer: true })).toBe("text");
    expect(chooseStrategy({ hasTextLayer: false })).toBe("ocr");
  });
  test("unknown mode string falls through to the auto decision", () => {
    expect(chooseStrategy({ mode: "bogus", hasTextLayer: true })).toBe("text");
    expect(chooseStrategy({ mode: "bogus", hasTextLayer: false })).toBe("ocr");
  });
});

describe("pdf-core.assessText", () => {
  test("counts words + chars on trimmed text", () => {
    const a = assessText("  hello  world foo \n");
    expect(a.words).toBe(3);
    expect(a.nonEmpty).toBe(true);
    expect(a.chars).toBe("hello  world foo".length);
  });
  test("whitespace-only is empty", () => {
    const a = assessText("   \n\t ");
    expect(a.nonEmpty).toBe(false);
    expect(a.words).toBe(0);
    expect(a.chars).toBe(0);
  });
});

describe("pdf-core.sortPageFiles", () => {
  test("numerically sorts page-N.png (10 after 2, not before)", () => {
    expect(sortPageFiles(["page-10.png", "page-2.png", "page-1.png"])).toEqual([
      "page-1.png",
      "page-2.png",
      "page-10.png",
    ]);
  });
});

describe("pdf-core.pageArgs", () => {
  test("no window -> no flags", () => {
    expect(pageArgs()).toEqual([]);
  });
  test("first + last -> -f/-l", () => {
    expect(pageArgs(2, 5)).toEqual(["-f", "2", "-l", "5"]);
  });
  test("first only", () => {
    expect(pageArgs(3)).toEqual(["-f", "3"]);
  });
});

describe("pdf-core.buildTablesArgs", () => {
  test("builds the ephemeral uv+pdfplumber argv with defaulted page window", () => {
    const args = buildTablesArgs("/doc.pdf");
    expect(args.slice(0, 6)).toEqual(["run", "--quiet", "--with", "pdfplumber", "--python", "3.12"]);
    expect(args).toContain("python");
    expect(args).toContain("-c");
    expect(args).toContain(PDFPLUMBER_SCRIPT);
    // last three args: target, first (0), last (0)
    expect(args.slice(-3)).toEqual(["/doc.pdf", "0", "0"]);
  });
  test("threads first/last through as strings", () => {
    expect(buildTablesArgs("/doc.pdf", 2, 4).slice(-3)).toEqual(["/doc.pdf", "2", "4"]);
  });
});

describe("pdf-core.renderTables", () => {
  test("NO_TABLES -> not found, with born-digital warning when no text layer", () => {
    const { text, found } = renderTables("NO_TABLES", false);
    expect(found).toBe(false);
    expect(text).toContain("No tables found.");
    expect(text).toContain("no text layer detected");
  });
  test("empty stdout with text layer -> not found, no warning", () => {
    const { text, found } = renderTables("   ", true);
    expect(found).toBe(false);
    expect(text).toBe("No tables found.");
  });
  test("markdown passthrough when tables present", () => {
    const md = "### table 1 (page 1)\n\n| a | b |\n| --- | --- |\n| 1 | 2 |";
    const { text, found } = renderTables(md, true);
    expect(found).toBe(true);
    expect(text).toBe(md);
  });
});

describe("pdf-core.renderVisual", () => {
  test("lists PNG paths with page numbers offset from firstPage", () => {
    const out = renderVisual(["/tmp/page-1.png", "/tmp/page-2.png"], 3, 200, true);
    expect(out).toContain("Rasterized 2 page(s) at 200 DPI (text layer: present)");
    expect(out).toContain("page 3: /tmp/page-1.png");
    expect(out).toContain("page 4: /tmp/page-2.png");
  });
  test("reports absent text layer", () => {
    expect(renderVisual(["/tmp/page-1.png"], 1, 300, false)).toContain("text layer: none");
  });
});

describe("pdf-core.binMissingText", () => {
  test("bin-specific install hints", () => {
    expect(binMissingText("tesseract")).toContain("tesseract-data-eng");
    expect(binMissingText("uv")).toContain("astral.sh/uv");
    expect(binMissingText("pdftoppm")).toContain("poppler");
  });
});
