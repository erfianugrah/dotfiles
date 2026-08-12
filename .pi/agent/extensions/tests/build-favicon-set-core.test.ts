/**
 * build-favicon-set-core unit tests - pure argv builders, HTML/manifest
 * snippets, the size plan, and the report renderer. No rsvg-convert / magick
 * binary needed (the live run is covered by the pi e2e suite / marked
 * [blocked: needs binary] in the port doc).
 *
 *   bun test extensions/tests/build-favicon-set-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  abs,
  svgToPngArgs,
  pngResizeArgs,
  buildIcoArgs,
  maskableArgs,
  htmlSnippet,
  manifestJson,
  planSizes,
  generatedList,
  renderReport,
  validateSource,
} from "../lib/build-favicon-set-core.ts";

describe("build-favicon-set-core.abs", () => {
  test("absolute path passes through", () => {
    expect(abs("/repo", "/etc/x")).toBe("/etc/x");
  });
  test("relative path resolves against cwd", () => {
    expect(abs("/repo", "public")).toBe("/repo/public");
  });
});

describe("build-favicon-set-core.argv builders", () => {
  test("svgToPngArgs: width/height/out/src for rsvg-convert", () => {
    expect(svgToPngArgs("/tmp/logo.svg", 32, "/out/x.png")).toEqual([
      "-w", "32", "-h", "32", "-o", "/out/x.png", "/tmp/logo.svg",
    ]);
  });
  test("pngResizeArgs: square resize with transparent centered extent", () => {
    expect(pngResizeArgs("/in.png", 180, "/out.png")).toEqual([
      "/in.png",
      "-resize", "180x180",
      "-background", "none",
      "-gravity", "center",
      "-extent", "180x180",
      "/out.png",
    ]);
  });
  test("buildIcoArgs: PNG inputs followed by the .ico output", () => {
    expect(buildIcoArgs(["/a-16.png", "/a-32.png", "/tmp/48.png"], "/a.ico")).toEqual([
      "/a-16.png", "/a-32.png", "/tmp/48.png", "/a.ico",
    ]);
  });
  test("maskableArgs: 410px content on a 512px transparent canvas (80% safe-zone)", () => {
    expect(maskableArgs("/m.png", "/mask.png")).toEqual([
      "/m.png",
      "-resize", "410x410",
      "-background", "none",
      "-gravity", "center",
      "-extent", "512x512",
      "/mask.png",
    ]);
  });
});

describe("build-favicon-set-core.htmlSnippet", () => {
  test("emits every rel link with the name prefix and a manifest link", () => {
    const s = htmlSnippet("favicon");
    expect(s).toContain(`<link rel="icon" href="/favicon.ico" sizes="any">`);
    expect(s).toContain(`<link rel="icon" href="/favicon.svg" type="image/svg+xml">`);
    expect(s).toContain(`sizes="16x16" href="/favicon-16.png"`);
    expect(s).toContain(`sizes="32x32" href="/favicon-32.png"`);
    expect(s).toContain(`<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">`);
    expect(s).toContain(`<link rel="manifest" href="/site.webmanifest">`);
  });
  test("respects a custom name prefix", () => {
    const s = htmlSnippet("brand");
    expect(s).toContain(`href="/brand.ico"`);
    expect(s).toContain(`href="/brand-16.png"`);
    // apple-touch-icon is NOT name-prefixed (fixed filename)
    expect(s).toContain(`href="/apple-touch-icon.png"`);
  });
});

describe("build-favicon-set-core.manifestJson", () => {
  test("valid JSON with the three icon entries and a maskable purpose", () => {
    const json = manifestJson({
      name: "My App",
      shortName: "App",
      themeColor: "#101010",
      backgroundColor: "#fafafa",
    });
    const m = JSON.parse(json);
    expect(m.name).toBe("My App");
    expect(m.short_name).toBe("App");
    expect(m.theme_color).toBe("#101010");
    expect(m.background_color).toBe("#fafafa");
    expect(m.display).toBe("standalone");
    expect(m.icons).toHaveLength(3);
    expect(m.icons).toContainEqual({ src: "/icon-192.png", sizes: "192x192", type: "image/png" });
    const maskable = m.icons.find((i: { purpose?: string }) => i.purpose === "maskable");
    expect(maskable).toEqual({ src: "/icon-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" });
  });
});

describe("build-favicon-set-core.planSizes", () => {
  test("emits the canonical size set; 48px is a non-kept temp for ICO assembly", () => {
    const plan = planSizes("/out", "favicon", "/tmp/48.png");
    expect(plan.map((p) => p.size)).toEqual([16, 32, 48, 180, 192, 512]);
    const px48 = plan.find((p) => p.size === 48)!;
    expect(px48.keep).toBe(false);
    expect(px48.out).toBe("/tmp/48.png");
    // kept files land in outDir with the right names
    expect(plan.find((p) => p.size === 16)!.out).toBe("/out/favicon-16.png");
    expect(plan.find((p) => p.size === 180)!.out).toBe("/out/apple-touch-icon.png");
    expect(plan.find((p) => p.size === 192)!.out).toBe("/out/icon-192.png");
    expect(plan.find((p) => p.size === 512)!.out).toBe("/out/icon-512.png");
    // exactly one non-kept temp entry
    expect(plan.filter((p) => !p.keep)).toHaveLength(1);
  });
});

describe("build-favicon-set-core.generatedList", () => {
  test("includes the .svg entry only when SVG input was used", () => {
    expect(generatedList("favicon", true)).toContain("favicon.svg");
    expect(generatedList("favicon", false)).not.toContain("favicon.svg");
  });
  test("always lists ico, both pngs, apple-touch, pwa icons, manifest", () => {
    const list = generatedList("favicon", false);
    expect(list).toContain("favicon.ico (multi-res 16/32/48)");
    expect(list).toContain("favicon-16.png");
    expect(list).toContain("favicon-32.png");
    expect(list).toContain("apple-touch-icon.png (180x180)");
    expect(list).toContain("icon-192.png");
    expect(list).toContain("icon-512.png");
    expect(list).toContain("icon-maskable.png (512x512, 80% safe-zone)");
    expect(list).toContain("site.webmanifest");
  });
});

describe("build-favicon-set-core.renderReport", () => {
  test("headers the outDir, bullets each file, and fences the HTML snippet", () => {
    const text = renderReport("/out", ["favicon.ico (multi-res 16/32/48)", "site.webmanifest"], htmlSnippet("favicon"));
    expect(text).toContain("Built favicon set in /out:");
    expect(text).toContain("  - favicon.ico (multi-res 16/32/48)");
    expect(text).toContain("  - site.webmanifest");
    expect(text).toContain("```html");
    expect(text).toContain(`<link rel="manifest" href="/site.webmanifest">`);
  });
});

describe("build-favicon-set-core.validateSource", () => {
  test("neither svg nor pngPath -> error", () => {
    expect(validateSource({})).toBe("Either `svg` or `pngPath` must be provided.");
  });
  test("both svg and pngPath -> error", () => {
    expect(validateSource({ svg: "<svg/>", pngPath: "/x.png" })).toBe("Pass either `svg` OR `pngPath`, not both.");
  });
  test("exactly one -> null (valid)", () => {
    expect(validateSource({ svg: "<svg/>" })).toBeNull();
    expect(validateSource({ pngPath: "/x.png" })).toBeNull();
  });
});
