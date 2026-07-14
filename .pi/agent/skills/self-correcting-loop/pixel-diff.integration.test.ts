/**
 * Integration test for pixel-diff.ts - the computational visual-regression gate.
 *
 * Fixtures are built with the tool's own encodePng (round-trip-tested in the
 * unit suite), so no external PNG tooling is needed. The --url path uses a fake
 * capture ($LOOP_CAPTURE_CMD) that copies a fixture into the --screenshot slot.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Image, encodePng } from "./pixel-diff.ts";

const CLI = join(import.meta.dir, "pixel-diff.ts");
let dir: string;
let fakeCapture: string;

function solid(w: number, h: number, rgba: [number, number, number, number]): Image {
	const data = new Uint8Array(w * h * 4);
	for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
	return { width: w, height: h, data };
}

function writePng(path: string, img: Image) {
	writeFileSync(path, encodePng(img));
}

async function run(args: string[], env: Record<string, string> = {}) {
	const p = Bun.spawn(["bun", CLI, ...args], {
		cwd: dir,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { code, out: out + err };
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pixdiff-it-"));
	// A fake capture that copies $FIXTURE_PNG into the path after --screenshot.
	fakeCapture = join(dir, "fake-capture.sh");
	writeFileSync(
		fakeCapture,
		`#!/usr/bin/env bash
out=""; prev=""
for a in "$@"; do [ "$prev" = "--screenshot" ] && out="$a"; prev="$a"; done
cp "$FIXTURE_PNG" "$out"
`,
	);
	chmodSync(fakeCapture, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("identical current vs baseline => exit 0", async () => {
	const base = join(dir, "b1.png");
	const cur = join(dir, "c1.png");
	writePng(base, solid(8, 8, [30, 60, 90, 255]));
	writePng(cur, solid(8, 8, [30, 60, 90, 255]));
	const { code, out } = await run(["--baseline", base, "--current", cur]);
	expect(code).toBe(0);
	expect(out).toContain("PASS");
});

test("changed beyond ratio => exit 1 and a diff image is written", async () => {
	const base = join(dir, "b2.png");
	const cur = join(dir, "c2.png");
	const diff = join(dir, "d2.png");
	writePng(base, solid(8, 8, [0, 0, 0, 255]));
	writePng(cur, solid(8, 8, [255, 255, 255, 255])); // fully changed
	const { code, out } = await run(["--baseline", base, "--current", cur, "--diff-out", diff]);
	expect(code).toBe(1);
	expect(out).toContain("FAIL");
	expect(existsSync(diff)).toBe(true);
});

test("tolerance: --max-diff-ratio absorbs a small change", async () => {
	const base = join(dir, "b3.png");
	const cur = join(dir, "c3.png");
	writePng(base, solid(10, 10, [0, 0, 0, 255]));
	const c = solid(10, 10, [0, 0, 0, 255]);
	c.data.set([255, 255, 255, 255], 0); // 1 of 100 px changed = 1%
	writePng(cur, c);
	// ratio 0 fails, ratio 0.02 (2%) passes.
	expect((await run(["--baseline", base, "--current", cur])).code).toBe(1);
	expect((await run(["--baseline", base, "--current", cur, "--max-diff-ratio", "0.02"])).code).toBe(0);
});

test("missing baseline => created and FAILs (needs review + commit)", async () => {
	const base = join(dir, "new-baseline.png");
	const cur = join(dir, "c4.png");
	writePng(cur, solid(4, 4, [10, 10, 10, 255]));
	expect(existsSync(base)).toBe(false);
	const { code, out } = await run(["--baseline", base, "--current", cur]);
	expect(code).toBe(1);
	expect(out).toContain("no baseline");
	expect(existsSync(base)).toBe(true); // it was created
});

test("--update-baseline promotes current and passes", async () => {
	const base = join(dir, "b5.png");
	const cur = join(dir, "c5.png");
	writePng(base, solid(4, 4, [0, 0, 0, 255]));
	writePng(cur, solid(4, 4, [255, 255, 255, 255]));
	const { code, out } = await run(["--baseline", base, "--current", cur, "--update-baseline"]);
	expect(code).toBe(0);
	expect(out).toContain("baseline updated");
	// baseline now equals current => a follow-up diff passes.
	expect((await run(["--baseline", base, "--current", cur])).code).toBe(0);
});

test("dimension mismatch => exit 1", async () => {
	const base = join(dir, "b6.png");
	const cur = join(dir, "c6.png");
	writePng(base, solid(8, 8, [0, 0, 0, 255]));
	writePng(cur, solid(8, 6, [0, 0, 0, 255]));
	const { code, out } = await run(["--baseline", base, "--current", cur]);
	expect(code).toBe(1);
	expect(out).toContain("size changed");
});

test("--url path captures via browser-assert (faked) then diffs", async () => {
	const base = join(dir, "b7.png");
	const fixture = join(dir, "fixture7.png");
	writePng(base, solid(8, 8, [50, 50, 50, 255]));
	writePng(fixture, solid(8, 8, [50, 50, 50, 255])); // capture returns == baseline
	const { code, out } = await run(
		["--baseline", base, "--url", "http://localhost:4333/"],
		{ LOOP_CAPTURE_CMD: fakeCapture, FIXTURE_PNG: fixture },
	);
	expect(code).toBe(0);
	expect(out).toContain("PASS");
});

test("capture failure => exit 1", async () => {
	const base = join(dir, "b8.png");
	writePng(base, solid(4, 4, [0, 0, 0, 255]));
	const failCap = join(dir, "cap-fail.sh");
	writeFileSync(failCap, "#!/usr/bin/env bash\nexit 3\n");
	chmodSync(failCap, 0o755);
	const { code } = await run(["--baseline", base, "--url", "http://x/"], { LOOP_CAPTURE_CMD: failCap });
	expect(code).toBe(1);
});
