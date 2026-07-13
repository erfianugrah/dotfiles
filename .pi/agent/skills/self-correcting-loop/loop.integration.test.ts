/**
 * Integration test for the loop driver's control logic.
 *
 * We substitute a SCRIPTED fake agent for `pi -p` (via $LOOP_PI_CMD) so the
 * whole governor - git checkpoint/rollback, write-scope enforcement, stall
 * detection, model escalation - is exercised deterministically, with zero
 * dependence on real model behaviour or network.
 *
 * The fake agent, keyed off an out-of-repo counter, does:
 *   iter 1: break fileC       -> regression (3 failing) -> ROLLED BACK
 *   iter 2: no-op             -> stall (2 failing, same) -> ESCALATE to rung 1
 *   iter 3: fix fileA + write OUTSIDE.txt -> progress + OUT-OF-SCOPE reverted
 *   iter 4: fix fileB         -> all green -> PASS
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOP = join(import.meta.dir, "loop.ts");
let repo: string;
let counter: string;
let fake: string;

async function sh(cmd: string[], cwd: string) {
	const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	await p.exited;
}

beforeAll(async () => {
	repo = mkdtempSync(join(tmpdir(), "loop-it-repo-"));
	const box = mkdtempSync(join(tmpdir(), "loop-it-box-"));
	counter = join(box, "counter");
	fake = join(box, "fake-agent.sh");

	// Scripted fake agent (ignores the pi args it receives).
	writeFileSync(
		fake,
		`#!/usr/bin/env bash
n=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$COUNTER_FILE"
case "$n" in
  1) echo broken > fileC.txt ;;
  2) : ;;
  3) echo A-ok > fileA.txt; echo junk > OUTSIDE.txt ;;
  4) echo B-ok > fileB.txt ;;
  *) : ;;
esac
exit 0
`,
	);
	chmodSync(fake, 0o755);

	// Target repo: three files, three grep sensors. Baseline: A,B fail; C ok.
	writeFileSync(join(repo, "fileA.txt"), "");
	writeFileSync(join(repo, "fileB.txt"), "");
	writeFileSync(join(repo, "fileC.txt"), "C-ok\n");
	await Bun.write(
		join(repo, ".pi/harness.json"),
		JSON.stringify({
			task: "make the sensors pass",
			maxIterations: 6,
			models: ["weak", "strong"],
			stallPatience: 2,
			tools: ["read", "edit", "write", "bash"],
			writeScope: ["file*.txt"],
			sensors: [
				{ name: "A", cmd: "grep -q A-ok fileA.txt" },
				{ name: "B", cmd: "grep -q B-ok fileB.txt" },
				{ name: "C", cmd: "grep -q C-ok fileC.txt" },
			],
		}),
	);

	await sh(["git", "init", "-q"], repo);
	await sh(["git", "config", "user.email", "t@t.t"], repo);
	await sh(["git", "config", "user.name", "t"], repo);
	await sh(["git", "add", "-A"], repo);
	await sh(["git", "commit", "-q", "-m", "baseline"], repo);
});

afterAll(() => {
	rmSync(repo, { recursive: true, force: true });
});

test("governor: rollback, stall+escalate, scope-revert, then pass", async () => {
	const proc = Bun.spawn(["bun", LOOP, "run"], {
		cwd: repo,
		env: { ...process.env, LOOP_PI_CMD: fake, COUNTER_FILE: counter },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, code] = await Promise.all([
		new Response(proc.stdout).text(),
		proc.exited,
	]);

	expect(code).toBe(0);

	const report = JSON.parse(readFileSync(join(repo, ".pi/harness-report.json"), "utf8"));
	expect(report.result).toBe("pass");
	expect(report.iterations.length).toBe(4);

	const [it1, it2, it3, it4] = report.iterations;

	// iter 1: regression (C broken -> 3 failing), not kept (rolled back).
	expect(it1.failingBefore).toBe(2);
	expect(it1.failingAfter).toBe(3);
	expect(it1.kept).toBe(false);
	expect(it1.model).toBe("weak");

	// iter 2: stall -> escalate to rung 1.
	expect(it2.progressed).toBe(false);
	expect(it2.escalated).toBe(true);

	// iter 3: strong model now; fixed A (progress) and OUTSIDE.txt reverted.
	expect(it3.model).toBe("strong");
	// EXACTLY the out-of-scope file - the in-scope fileA.txt must NOT be flagged.
	expect(it3.scopeViolations).toEqual(["OUTSIDE.txt"]);
	expect(it3.kept).toBe(true);
	expect(it3.failingAfter).toBe(1);

	// iter 4: all green.
	expect(it4.failingAfter).toBe(0);

	// Final tree: fixed in scope, out-of-scope file gone, C restored.
	expect(readFileSync(join(repo, "fileA.txt"), "utf8")).toContain("A-ok");
	expect(readFileSync(join(repo, "fileB.txt"), "utf8")).toContain("B-ok");
	expect(readFileSync(join(repo, "fileC.txt"), "utf8")).toContain("C-ok");
	expect(existsSync(join(repo, "OUTSIDE.txt"))).toBe(false);
}, 30000);
