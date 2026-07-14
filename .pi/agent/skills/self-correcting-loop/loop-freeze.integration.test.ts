/**
 * 2d freeze mode: a sensor already failing at baseline (pre-existing debt) is
 * tolerated; only NEW failures gate. Deterministic, no git, no pi.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOP = join(import.meta.dir, "loop.ts");
let dir: string;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "loop-freeze-"));
	// "debt" is permanently red; "ok" is green. Non-git dir on purpose.
	await Bun.write(
		join(dir, ".pi/harness.json"),
		JSON.stringify({
			task: "noop",
			sensors: [
				{ name: "debt", cmd: "false" },
				{ name: "ok", cmd: "true" },
			],
		}),
	);
}, 30000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(args: string[]): Promise<number> {
	const p = Bun.spawn(["bun", LOOP, "run", ...args], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	await new Response(p.stdout).text();
	return await p.exited;
}

test("without freeze, a baseline failure is red (dry exit 1)", async () => {
	expect(await run(["--dry"])).toBe(1);
});

test("with --freeze, the pre-existing failure is tolerated (exit 0)", async () => {
	expect(await run(["--freeze"])).toBe(0);
});
