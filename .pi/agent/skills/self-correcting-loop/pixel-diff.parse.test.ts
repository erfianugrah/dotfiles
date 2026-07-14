import { describe, expect, test } from "bun:test";
import {
	type Image,
	MAX_YIQ_DELTA_SQ,
	colorDeltaSq,
	decodePng,
	diffImages,
	encodePng,
	parseArgs,
	parseRect,
} from "./pixel-diff.ts";

/** Build a solid-colour RGBA image. */
function solid(w: number, h: number, rgba: [number, number, number, number]): Image {
	const data = new Uint8Array(w * h * 4);
	for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
	return { width: w, height: h, data };
}

describe("pixel-diff parseArgs", () => {
	test("requires --baseline", () => {
		expect(() => parseArgs([])).toThrow("usage");
		expect(() => parseArgs(["--current", "a.png"])).toThrow("usage");
	});

	test("requires a source (--current or --url)", () => {
		expect(() => parseArgs(["--baseline", "b.png"])).toThrow("need --current");
	});

	test("defaults", () => {
		const a = parseArgs(["--baseline", "b.png", "--current", "c.png"]);
		expect(a.threshold).toBe(0.1);
		expect(a.maxDiffRatio).toBe(0);
		expect(a.ignore).toEqual([]);
		expect(a.updateBaseline).toBe(false);
	});

	test("parses all flags", () => {
		const a = parseArgs([
			"--baseline", "b.png",
			"--url", "http://x/",
			"--wait", "main",
			"--viewport", "1280x800",
			"--full-page",
			"--threshold", "0.2",
			"--max-diff-ratio", "0.01",
			"--ignore-region", "0,0,10,10",
			"--ignore-region", "5,5,2,2",
			"--diff-out", "d.png",
			"--update-baseline",
		]);
		expect(a.url).toBe("http://x/");
		expect(a.threshold).toBe(0.2);
		expect(a.maxDiffRatio).toBe(0.01);
		expect(a.ignore).toEqual([{ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 2, h: 2 }]);
		expect(a.diffOut).toBe("d.png");
		expect(a.updateBaseline).toBe(true);
	});

	test("rejects unknown args", () => {
		expect(() => parseArgs(["--baseline", "b", "--current", "c", "--nope"])).toThrow("unknown arg");
	});
});

describe("pixel-diff parseRect", () => {
	test("parses x,y,w,h", () => {
		expect(parseRect("1,2,3,4")).toEqual({ x: 1, y: 2, w: 3, h: 4 });
	});
	test("rejects malformed", () => {
		expect(() => parseRect("1,2,3")).toThrow("x,y,w,h");
		expect(() => parseRect("1,2,-3,4")).toThrow("x,y,w,h");
	});
});

describe("pixel-diff colorDeltaSq", () => {
	test("identical pixel = 0", () => {
		const a = new Uint8Array([10, 20, 30, 255]);
		expect(colorDeltaSq(a, a, 0)).toBe(0);
	});
	test("black vs white is a large delta (0.5053*255^2), within the max bound", () => {
		const black = new Uint8Array([0, 0, 0, 255]);
		const white = new Uint8Array([255, 255, 255, 255]);
		const d = colorDeltaSq(black, white, 0);
		expect(d).toBeGreaterThan(30000);
		expect(d).toBeLessThanOrEqual(MAX_YIQ_DELTA_SQ); // 35215 is the all-pairs max
	});
	test("symmetric", () => {
		const a = new Uint8Array([12, 200, 40, 255]);
		const b = new Uint8Array([90, 30, 210, 255]);
		expect(colorDeltaSq(a, b, 0)).toBeCloseTo(colorDeltaSq(b, a, 0), 5);
	});
});

describe("pixel-diff encode/decode round-trip", () => {
	test("RGBA survives encode -> decode", () => {
		const img: Image = {
			width: 3,
			height: 2,
			data: new Uint8Array([
				255, 0, 0, 255,   0, 255, 0, 128,   0, 0, 255, 255,
				10, 20, 30, 40,   200, 100, 50, 255, 1, 2, 3, 4,
			]),
		};
		const round = decodePng(encodePng(img));
		expect(round.width).toBe(3);
		expect(round.height).toBe(2);
		expect([...round.data]).toEqual([...img.data]);
	});

	test("decode rejects a non-PNG", () => {
		expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow("not a PNG");
	});
});

describe("pixel-diff diffImages", () => {
	test("identical images => 0 changed", () => {
		const a = solid(4, 4, [100, 100, 100, 255]);
		const b = solid(4, 4, [100, 100, 100, 255]);
		expect(diffImages(a, b, { threshold: 0.1 }).diffPixels).toBe(0);
	});

	test("sub-threshold noise is NOT counted (AA tolerance)", () => {
		const a = solid(2, 2, [100, 100, 100, 255]);
		const b = solid(2, 2, [101, 100, 100, 255]); // +1 on one channel
		expect(diffImages(a, b, { threshold: 0.1 }).diffPixels).toBe(0);
	});

	test("a strong change IS counted", () => {
		const a = solid(2, 2, [0, 0, 0, 255]);
		const b = solid(2, 2, [0, 0, 0, 255]);
		b.data.set([255, 255, 255, 255], 0); // one pixel to white
		const r = diffImages(a, b, { threshold: 0.1 });
		expect(r.diffPixels).toBe(1);
		expect(r.ratio).toBeCloseTo(1 / 4, 5);
	});

	test("ignore-region excludes changed pixels", () => {
		const a = solid(2, 2, [0, 0, 0, 255]);
		const b = solid(2, 2, [255, 255, 255, 255]); // everything changed
		// ignore the whole image => 0 counted
		expect(diffImages(a, b, { threshold: 0.1, ignore: [{ x: 0, y: 0, w: 2, h: 2 }] }).diffPixels).toBe(0);
	});

	test("diff:true produces a highlight image of the right size", () => {
		const a = solid(2, 2, [0, 0, 0, 255]);
		const b = solid(2, 2, [255, 255, 255, 255]);
		const r = diffImages(a, b, { threshold: 0.1, diff: true });
		expect(r.out?.width).toBe(2);
		expect(r.out?.data.length).toBe(2 * 2 * 4);
		// a changed pixel is painted red.
		expect([r.out!.data[0], r.out!.data[1], r.out!.data[2], r.out!.data[3]]).toEqual([255, 0, 0, 255]);
	});

	test("unchanged BRIGHT baseline pixels fade toward white, never wrap to 0", () => {
		const a = solid(2, 1, [255, 255, 255, 255]); // white baseline
		const b = solid(2, 1, [255, 255, 255, 255]);
		const r = diffImages(a, b, { threshold: 0.1, diff: true });
		// regression guard: luma*0.1+230 used to overflow to 256 -> 0 (black).
		expect(r.out!.data[0]).toBe(255);
		expect(r.out!.data[1]).toBe(255);
		expect(r.out!.data[2]).toBe(255);
	});
});
