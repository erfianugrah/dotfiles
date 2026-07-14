/**
 * Integration test for the CDP browser-assert sensor. Skips if no system
 * Chromium/Chrome is available (e.g. minimal CI).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BA = join(import.meta.dir, "browser-assert.ts");
const CHROMIUM = [
	"/usr/sbin/chromium",
	"/usr/bin/chromium",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/google-chrome",
].find((p) => existsSync(p));

// The real-browser test needs Chromium; skip when absent, and skip in CI by
// default (kept reliable/fast - the CDP *logic* is covered by
// browser-assert.cdp.test.ts, which needs no browser). Opt in with
// RUN_BROWSER_TESTS=1.
const SKIP = !CHROMIUM || (!!process.env.CI && !process.env.RUN_BROWSER_TESTS);

let dir: string;
let page: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "ba-it-"));
	page = join(dir, "page.html");
	writeFileSync(
		page,
		`<!doctype html><title>Loading</title><body><div id=app></div>
<script>setTimeout(()=>{document.title="ready";document.getElementById("app").textContent="ok";
var b=document.createElement("button");b.id="cta";document.body.appendChild(b);},300)</script>`,
	);
	// interaction fixture: a button that flips #out, and an input echoed to #echo
	interact = join(dir, "interact.html");
	writeFileSync(
		interact,
		`<!doctype html><title>interact</title><body>
<button id=btn onclick="document.getElementById('out').textContent='clicked'">go</button>
<div id=out>idle</div>
<input id=inp oninput="document.getElementById('echo').textContent=this.value">
<div id=echo></div></body>`,
	);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

let interact: string;

async function run(extra: string[]): Promise<number> {
	const proc = Bun.spawn(["bun", BA, `file://${page}`, "--wait", "#cta", ...extra], {
		stdout: "pipe",
		stderr: "pipe",
	});
	await new Response(proc.stdout).text();
	return await proc.exited;
}

async function runOn(url: string, extra: string[]): Promise<number> {
	const proc = Bun.spawn(["bun", BA, url, ...extra], { stdout: "pipe", stderr: "pipe" });
	await new Response(proc.stdout).text();
	return await proc.exited;
}

test.skipIf(SKIP)("passes when in-page assertions hold (waits for async hydration)", async () => {
	const code = await run([
		"--assert",
		'document.title==="ready"',
		"--assert",
		'document.querySelector("#app").textContent==="ok"',
	]);
	expect(code).toBe(0);
}, 30000);

test.skipIf(SKIP)("fails (exit 1) when an assertion is false", async () => {
	const code = await run(["--assert", 'document.title==="nope"']);
	expect(code).toBe(1);
}, 30000);

test.skipIf(SKIP)("--click triggers the handler (trusted mouse event)", async () => {
	const code = await runOn(`file://${interact}`, [
		"--wait", "#btn",
		"--click", "#btn",
		"--assert", 'document.querySelector("#out").textContent==="clicked"',
	]);
	expect(code).toBe(0);
}, 30000);

test.skipIf(SKIP)("--type inserts text and fires input events", async () => {
	const code = await runOn(`file://${interact}`, [
		"--wait", "#inp",
		"--type", "#inp", "hello",
		"--assert", 'document.querySelector("#echo").textContent==="hello"',
	]);
	expect(code).toBe(0);
}, 30000);

test.skipIf(SKIP)("--screenshot writes a real PNG", async () => {
	const shot = join(dir, "shot.png");
	const code = await runOn(`file://${interact}`, ["--wait", "#btn", "--screenshot", shot]);
	expect(code).toBe(0);
	expect(existsSync(shot)).toBe(true);
	expect(statSync(shot).size).toBeGreaterThan(100);
	// PNG magic bytes
	const head = readFileSync(shot).subarray(0, 8);
	expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}, 30000);
