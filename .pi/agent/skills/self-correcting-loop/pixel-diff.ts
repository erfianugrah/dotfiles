#!/usr/bin/env bun
/**
 * pixel-diff.ts - a COMPUTATIONAL visual-regression sensor for the loop.
 *
 *   bun pixel-diff.ts --baseline <png> (--current <png> | --url <url>) [flags]
 *
 * The inferential judge (judge.ts VISUAL) reliably catches GROSS breakage but
 * is weak on pixel-level polish. This is the deterministic other half: capture
 * the current render and diff it against a committed, human-APPROVED baseline
 * PNG, failing when too many pixels changed. Approved-baseline pattern: you
 * generate baselines as a setup step and COMMIT them (committing = approval);
 * the loop then runs this sensor with the baseline already present.
 *
 * Zero runtime deps (Bun + node:zlib only): PNG decode via inflate + scanline
 * un-filtering, a YIQ perceptual per-pixel threshold (pixelmatch's colour
 * metric) so anti-aliasing / sub-pixel noise does not false-positive, and a
 * minimal PNG encoder for the optional --diff-out highlight image.
 *
 *   --baseline <png>        approved reference (required)
 *   --current <png>         pre-captured render to compare
 *   --url <url>             capture the render via browser-assert instead
 *   --wait/--viewport/--full-page   forwarded to the capture
 *   --threshold <0..1>      per-pixel YIQ sensitivity (default 0.1; higher = laxer)
 *   --max-diff-ratio <0..1> allowed fraction of changed pixels (default 0)
 *   --ignore-region x,y,w,h zero this rect in both images before diffing (repeatable)
 *   --diff-out <png>        write a red-highlight diff image
 *   --update-baseline       overwrite the baseline with current, exit 0
 *
 * Exit 0 = within tolerance, non-zero = regression / missing baseline / usage.
 * Capture command overridable via $LOOP_CAPTURE_CMD (same hook as judge.ts).
 */

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const SCRIPT_DIR = dirname(Bun.fileURLToPath(import.meta.url));

export interface Image {
	width: number;
	height: number;
	/** RGBA, 8-bit, row-major (length = width*height*4). */
	data: Uint8Array;
}

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Args {
	baseline: string;
	current: string;
	url: string;
	wait: string;
	viewport: string;
	fullPage: boolean;
	threshold: number;
	maxDiffRatio: number;
	ignore: Rect[];
	diffOut: string;
	updateBaseline: boolean;
}

// --- arg parsing (pure) -----------------------------------------------------

export function parseArgs(argv: string[]): Args {
	const a: Args = {
		baseline: "",
		current: "",
		url: "",
		wait: "",
		viewport: "",
		fullPage: false,
		threshold: 0.1,
		maxDiffRatio: 0,
		ignore: [],
		diffOut: "",
		updateBaseline: false,
	};
	const need = (i: number, flag: string): string => {
		const v = argv[i + 1];
		if (v === undefined || v.startsWith("--")) throw new Error(`${flag} wants a value`);
		return v;
	};
	const num = (s: string, flag: string): number => {
		const n = Number.parseFloat(s);
		if (!Number.isFinite(n)) throw new Error(`${flag} wants a number`);
		return n;
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--baseline": a.baseline = need(i, "--baseline"); i++; break;
			case "--current": a.current = need(i, "--current"); i++; break;
			case "--url": a.url = need(i, "--url"); i++; break;
			case "--wait": a.wait = need(i, "--wait"); i++; break;
			case "--viewport": a.viewport = need(i, "--viewport"); i++; break;
			case "--full-page": a.fullPage = true; break;
			case "--threshold": a.threshold = num(need(i, "--threshold"), "--threshold"); i++; break;
			case "--max-diff-ratio": a.maxDiffRatio = num(need(i, "--max-diff-ratio"), "--max-diff-ratio"); i++; break;
			case "--ignore-region": a.ignore.push(parseRect(need(i, "--ignore-region"))); i++; break;
			case "--diff-out": a.diffOut = need(i, "--diff-out"); i++; break;
			case "--update-baseline": a.updateBaseline = true; break;
			default:
				throw new Error(`unknown arg: ${arg}`);
		}
	}
	if (!a.baseline.trim()) throw new Error("usage: pixel-diff.ts --baseline <png> (--current <png> | --url <url>) [--threshold n] [--max-diff-ratio n] [--ignore-region x,y,w,h] [--diff-out png] [--update-baseline]");
	if (!a.current.trim() && !a.url.trim()) throw new Error("need --current <png> or --url <url>");
	return a;
}

export function parseRect(s: string): Rect {
	const p = s.split(",").map((n) => Number.parseInt(n, 10));
	if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0)) {
		throw new Error(`--ignore-region wants x,y,w,h (non-negative ints), got: ${s}`);
	}
	return { x: p[0], y: p[1], w: p[2], h: p[3] };
}

// --- YIQ perceptual pixel delta (pixelmatch's metric) -----------------------

/** Max possible YIQ squared distance (white vs black), for threshold scaling. */
export const MAX_YIQ_DELTA_SQ = 35215;

function blendWhite(c: number, a: number): number {
	return 255 + (c - 255) * a;
}

/**
 * Squared YIQ colour distance between pixel i of two RGBA buffers, alpha-blended
 * over white. 0 = identical; ~35215 = max. Sub-pixel/AA differences produce
 * small values, so a threshold on this is inherently AA-tolerant.
 */
export function colorDeltaSq(a: Uint8Array, b: Uint8Array, i: number): number {
	let r1 = a[i], g1 = a[i + 1], b1 = a[i + 2];
	let r2 = b[i], g2 = b[i + 1], b2 = b[i + 2];
	const a1 = a[i + 3], a2 = b[i + 3];
	if (a1 === a2 && r1 === r2 && g1 === g2 && b1 === b2) return 0;
	if (a1 < 255) { const f = a1 / 255; r1 = blendWhite(r1, f); g1 = blendWhite(g1, f); b1 = blendWhite(b1, f); }
	if (a2 < 255) { const f = a2 / 255; r2 = blendWhite(r2, f); g2 = blendWhite(g2, f); b2 = blendWhite(b2, f); }
	const y = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223;
	const iq1 = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.2741761 - (b1 - b2) * 0.32180189;
	const q = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694;
	return 0.5053 * y * y + 0.299 * iq1 * iq1 + 0.1957 * q * q;
}

function inAnyRect(x: number, y: number, rects: Rect[]): boolean {
	for (const r of rects) {
		if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
	}
	return false;
}

export interface DiffResult {
	diffPixels: number;
	total: number;
	ratio: number;
	/** highlight image (grey base, red changed pixels) when requested. */
	out?: Image;
}

/**
 * Count pixels whose perceptual delta exceeds the threshold. `threshold` is
 * 0..1 scaled against MAX_YIQ_DELTA_SQ. Pixels inside any ignore rect are
 * skipped. Images must share dimensions (caller checks). Pure.
 */
export function diffImages(
	a: Image,
	b: Image,
	opts: { threshold: number; ignore?: Rect[]; diff?: boolean },
): DiffResult {
	const { width, height } = a;
	const total = width * height;
	const maxDelta = MAX_YIQ_DELTA_SQ * opts.threshold * opts.threshold;
	const ignore = opts.ignore ?? [];
	const out = opts.diff ? new Uint8Array(total * 4) : undefined;
	let diffPixels = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			const ignored = inAnyRect(x, y, ignore);
			const delta = ignored ? 0 : colorDeltaSq(a.data, b.data, i);
			const changed = delta > maxDelta;
			if (changed) diffPixels++;
			if (out) {
				if (changed) {
					out[i] = 255; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 255;
				} else {
					// faint version of the baseline for context: blend each channel
					// toward white by 90% (never exceeds 255, so no Uint8 wraparound).
					out[i] = 255 + ((a.data[i] - 255) * 0.1); // |0 not needed; assigning to Uint8Array truncates
					out[i + 1] = 255 + ((a.data[i + 1] - 255) * 0.1);
					out[i + 2] = 255 + ((a.data[i + 2] - 255) * 0.1);
					out[i + 3] = 255;
				}
			}
		}
	}
	return {
		diffPixels,
		total,
		ratio: total ? diffPixels / total : 0,
		out: out ? { width, height, data: out } : undefined,
	};
}

// --- PNG decode / encode (RGBA, 8-bit, non-interlaced) ----------------------

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode an 8-bit, non-interlaced PNG of colour type 2 (RGB) or 6 (RGBA). */
export function decodePng(bytes: Uint8Array): Image {
	for (let i = 0; i < 8; i++) {
		if (bytes[i] !== PNG_SIG[i]) throw new Error("not a PNG (bad signature)");
	}
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let pos = 8;
	let width = 0, height = 0, colorType = 0, bitDepth = 0, interlace = 0;
	const idatParts: Uint8Array[] = [];
	while (pos < bytes.length) {
		const len = dv.getUint32(pos);
		const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
		const dstart = pos + 8;
		if (type === "IHDR") {
			width = dv.getUint32(dstart);
			height = dv.getUint32(dstart + 4);
			bitDepth = bytes[dstart + 8];
			colorType = bytes[dstart + 9];
			interlace = bytes[dstart + 12];
		} else if (type === "IDAT") {
			idatParts.push(bytes.subarray(dstart, dstart + len));
		} else if (type === "IEND") {
			break;
		}
		pos = dstart + len + 4; // skip data + CRC
	}
	if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth} (need 8)`);
	if (interlace !== 0) throw new Error("interlaced PNG not supported");
	if (colorType !== 2 && colorType !== 6) throw new Error(`unsupported PNG colour type ${colorType} (need 2 or 6)`);
	const channels = colorType === 6 ? 4 : 3;

	// concat IDAT then inflate (zlib-wrapped).
	let idatLen = 0;
	for (const p of idatParts) idatLen += p.length;
	const idat = new Uint8Array(idatLen);
	{ let o = 0; for (const p of idatParts) { idat.set(p, o); o += p.length; } }
	const raw = new Uint8Array(inflateSync(idat));

	const stride = width * channels;
	const data = new Uint8Array(width * height * 4);
	const prev = new Uint8Array(stride);
	const cur = new Uint8Array(stride);
	let rp = 0;
	for (let y = 0; y < height; y++) {
		const filter = raw[rp++];
		for (let x = 0; x < stride; x++) {
			const rawByte = raw[rp++];
			const a = x >= channels ? cur[x - channels] : 0;
			const b = prev[x];
			const c = x >= channels ? prev[x - channels] : 0;
			let val: number;
			switch (filter) {
				case 0: val = rawByte; break;
				case 1: val = rawByte + a; break;
				case 2: val = rawByte + b; break;
				case 3: val = rawByte + ((a + b) >> 1); break;
				case 4: val = rawByte + paeth(a, b, c); break;
				default: throw new Error(`bad PNG filter ${filter}`);
			}
			cur[x] = val & 0xff;
		}
		// expand scanline into RGBA.
		for (let x = 0; x < width; x++) {
			const s = x * channels;
			const d = (y * width + x) * 4;
			data[d] = cur[s];
			data[d + 1] = cur[s + 1];
			data[d + 2] = cur[s + 2];
			data[d + 3] = channels === 4 ? cur[s + 3] : 255;
		}
		prev.set(cur);
	}
	return { width, height, data };
}

/** Encode an RGBA image as an 8-bit colour-type-6 PNG (filter 0). */
export function encodePng(img: Image): Uint8Array {
	const { width, height, data } = img;
	const chunk = (type: string, body: Uint8Array): Uint8Array => {
		const out = new Uint8Array(12 + body.length);
		const dv = new DataView(out.buffer);
		dv.setUint32(0, body.length);
		for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
		out.set(body, 8);
		const typed = out.subarray(4, 8 + body.length);
		dv.setUint32(8 + body.length, crc32(typed));
		return out;
	};
	const ihdr = new Uint8Array(13);
	const idv = new DataView(ihdr.buffer);
	idv.setUint32(0, width);
	idv.setUint32(4, height);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type RGBA
	// 10/11/12 = compression/filter/interlace = 0
	const rawStride = width * 4;
	const raw = new Uint8Array(height * (rawStride + 1));
	for (let y = 0; y < height; y++) {
		raw[y * (rawStride + 1)] = 0; // filter: none
		raw.set(data.subarray(y * rawStride, (y + 1) * rawStride), y * (rawStride + 1) + 1);
	}
	const idat = new Uint8Array(deflateSync(raw));
	const parts = [
		new Uint8Array(PNG_SIG),
		chunk("IHDR", ihdr),
		chunk("IDAT", idat),
		chunk("IEND", new Uint8Array(0)),
	];
	let len = 0;
	for (const p of parts) len += p.length;
	const out = new Uint8Array(len);
	let o = 0;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
}

// --- impure shell (only runs as a script) -----------------------------------

async function sh(cmd: string[]): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out: `${stdout}${stderr}` };
}

async function captureCurrent(a: Args): Promise<string> {
	if (!a.url.trim()) return resolve(a.current);
	const out = resolve(tmpdir(), `pixel-diff-${Date.now()}.png`);
	const base = (process.env.LOOP_CAPTURE_CMD ?? `bun ${SCRIPT_DIR}/browser-assert.ts`).split(" ").filter(Boolean);
	const cmd = [...base, a.url];
	if (a.wait) cmd.push("--wait", a.wait);
	if (a.viewport) cmd.push("--viewport", a.viewport);
	if (a.fullPage) cmd.push("--full-page");
	cmd.push("--screenshot", out);
	const { code, out: log } = await sh(cmd);
	if (code !== 0) throw new Error(`capture failed (exit ${code}):\n${log.trim().slice(0, 1000)}`);
	return out;
}

async function main(): Promise<number> {
	let args: Args;
	try {
		args = parseArgs(Bun.argv.slice(2));
	} catch (err) {
		console.error((err as Error).message);
		return 2;
	}

	let currentPath: string;
	try {
		currentPath = await captureCurrent(args);
	} catch (err) {
		console.error((err as Error).message);
		return 1;
	}
	const baselinePath = resolve(args.baseline);

	// --update-baseline: promote current to the approved baseline and pass.
	if (args.updateBaseline) {
		await Bun.write(baselinePath, Bun.file(currentPath));
		console.log(`pixel-diff: baseline updated <- ${currentPath}`);
		return 0;
	}

	// Missing baseline: create it and FAIL - it must be reviewed + committed
	// (approval) before it can gate. Baselines are a setup step, not in-loop.
	if (!existsSync(baselinePath)) {
		await Bun.write(baselinePath, Bun.file(currentPath));
		console.error(`pixel-diff: no baseline - created ${baselinePath}. Review and COMMIT it, then re-run.`);
		return 1;
	}

	let base: Image;
	let cur: Image;
	try {
		base = decodePng(await Bun.file(baselinePath).bytes());
		cur = decodePng(await Bun.file(currentPath).bytes());
	} catch (err) {
		console.error(`pixel-diff: decode failed: ${(err as Error).message}`);
		return 1;
	}

	if (base.width !== cur.width || base.height !== cur.height) {
		console.error(`pixel-diff: size changed ${base.width}x${base.height} -> ${cur.width}x${cur.height} (layout regression or viewport change)`);
		return 1;
	}

	const r = diffImages(base, cur, { threshold: args.threshold, ignore: args.ignore, diff: !!args.diffOut });
	if (args.diffOut && r.out) await Bun.write(resolve(args.diffOut), encodePng(r.out));

	const pct = (r.ratio * 100).toFixed(4);
	if (r.ratio > args.maxDiffRatio) {
		console.error(`pixel-diff: FAIL ${r.diffPixels}/${r.total} px changed (${pct}% > ${(args.maxDiffRatio * 100).toFixed(4)}%)${args.diffOut ? ` - see ${args.diffOut}` : ""}`);
		return 1;
	}
	console.log(`pixel-diff: PASS ${r.diffPixels}/${r.total} px changed (${pct}% <= ${(args.maxDiffRatio * 100).toFixed(4)}%)`);
	return 0;
}

if (import.meta.main && basename(Bun.main) === "pixel-diff.ts") process.exit(await main());
