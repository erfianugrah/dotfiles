/**
 * Integration test for the CDP browser-assert sensor. Skips if no system
 * Chromium/Chrome is available (e.g. minimal CI).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(extra: string[]): Promise<number> {
	const proc = Bun.spawn(["bun", BA, `file://${page}`, "--wait", "#cta", ...extra], {
		stdout: "pipe",
		stderr: "pipe",
	});
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
