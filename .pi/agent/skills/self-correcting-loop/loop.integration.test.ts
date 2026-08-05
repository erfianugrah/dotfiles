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
let promptLog: string;

async function sh(cmd: string[], cwd: string) {
	const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	await p.exited;
}

beforeAll(async () => {
	repo = mkdtempSync(join(tmpdir(), "loop-it-repo-"));
	const box = mkdtempSync(join(tmpdir(), "loop-it-box-"));
	counter = join(box, "counter");
	fake = join(box, "fake-agent.sh");
	promptLog = join(box, "prompts.log");

	// Scripted fake agent (ignores the pi args it receives).
	writeFileSync(
		fake,
		`#!/usr/bin/env bash
n=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$COUNTER_FILE"
printf '\n===PROMPT===\n%s\n' "$2" >> "$PROMPT_LOG"
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
}, 30000); // generous: git setup can starve under concurrent-suite load

afterAll(() => {
	rmSync(repo, { recursive: true, force: true });
});

test("governor: rollback, stall+escalate, scope-revert, then pass", async () => {
	const proc = Bun.spawn(["bun", LOOP, "run"], {
		cwd: repo,
		env: {
			...process.env,
			LOOP_PI_CMD: fake,
			COUNTER_FILE: counter,
			PROMPT_LOG: promptLog,
		},
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
	expect(it1.changedFiles).toEqual(["fileC.txt"]);

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

	// Negative knowledge: iteration 2's prompt must name the rolled-back
	// approach from iteration 1 (fileC.txt) so the fresh agent can't repeat it.
	const prompts = readFileSync(promptLog, "utf8").split("===PROMPT===");
	expect(prompts[1]).not.toContain("Previous approaches that were rolled back");
	expect(prompts[2]).toContain("Previous approaches that were rolled back");
	expect(prompts[2]).toContain("fileC.txt");
}, 30000);

/**
 * Dirty-tree regression (2026-07-24 incident): with --allow-dirty, pre-existing
 * UNCOMMITTED work in out-of-scope files must survive the loop. The old
 * revertPaths restored scope violations from HEAD (destroying dirty content)
 * and changedPaths diffed against HEAD (flagging - and `git clean`-deleting -
 * pre-existing untracked files the agent never touched).
 *
 * The fake agent, keyed off an out-of-repo counter, does:
 *   iter 1: clobber notes.txt (out-of-scope) + create OUTSIDE.txt, no sensor fix
 *           -> scope-revert + rollback; notes.txt must return to the DIRTY
 *           (checkpoint) content, not HEAD; scratch.txt must survive.
 *   iter 2: fix fileA.txt -> all green -> PASS
 */
test("dirty tree: uncommitted out-of-scope work survives scope-revert + rollback", async () => {
	const repo2 = mkdtempSync(join(tmpdir(), "loop-it-dirty-repo-"));
	const box2 = mkdtempSync(join(tmpdir(), "loop-it-dirty-box-"));
	const counter2 = join(box2, "counter");
	const fake2 = join(box2, "fake-agent.sh");

	writeFileSync(
		fake2,
		`#!/usr/bin/env bash
n=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$COUNTER_FILE"
case "$n" in
  1) echo agent-junk > notes.txt; echo junk > OUTSIDE.txt ;;
  2) echo A-ok > fileA.txt ;;
  *) : ;;
esac
exit 0
`,
	);
	chmodSync(fake2, 0o755);

	// Baseline commit: fileA (in scope, sensor fails) + notes.txt (out of scope).
	writeFileSync(join(repo2, "fileA.txt"), "");
	writeFileSync(join(repo2, "notes.txt"), "committed-notes\n");
	await Bun.write(
		join(repo2, ".pi/harness.json"),
		JSON.stringify({
			task: "make the sensors pass",
			maxIterations: 4,
			models: ["weak"],
			stallPatience: 2,
			tools: ["read", "edit", "write", "bash"],
			writeScope: ["file*.txt"],
			sensors: [{ name: "A", cmd: "grep -q A-ok fileA.txt" }],
		}),
	);
	await sh(["git", "init", "-q"], repo2);
	await sh(["git", "config", "user.email", "t@t.t"], repo2);
	await sh(["git", "config", "user.name", "t"], repo2);
	await sh(["git", "add", "-A"], repo2);
	await sh(["git", "commit", "-q", "-m", "baseline"], repo2);

	// Pre-existing UNCOMMITTED work the loop must not destroy: a dirty edit to
	// the out-of-scope tracked file, and an untracked out-of-scope file.
	writeFileSync(join(repo2, "notes.txt"), "user-precious-uncommitted\n");
	writeFileSync(join(repo2, "scratch.txt"), "user-scratch-untracked\n");

	const proc = Bun.spawn(["bun", LOOP, "run", "--allow-dirty"], {
		cwd: repo2,
		env: { ...process.env, LOOP_PI_CMD: fake2, COUNTER_FILE: counter2 },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

	expect(code).toBe(0);
	// The dirty content survived (not HEAD's "committed-notes", not "agent-junk").
	expect(readFileSync(join(repo2, "notes.txt"), "utf8")).toBe("user-precious-uncommitted\n");
	// The pre-existing untracked file survived (old code `git clean`ed it away).
	expect(readFileSync(join(repo2, "scratch.txt"), "utf8")).toBe("user-scratch-untracked\n");
	// The agent's out-of-scope creation was removed, the sensor fix landed.
	expect(existsSync(join(repo2, "OUTSIDE.txt"))).toBe(false);
	expect(readFileSync(join(repo2, "fileA.txt"), "utf8")).toContain("A-ok");

	rmSync(repo2, { recursive: true, force: true });
}, 30000);

test("an expensive sensor is skipped while its cheap dependency is red", async () => {
	// The judge cost 147s of a frontier model per iteration on a real run while
	// every other sensor together took under 30s - and it paid that even when
	// `build` was failing, where an inferential reviewer has nothing useful to
	// say about code that does not compile.
	const d = mkdtempSync(join(tmpdir(), "loop-after-"));
	for (const a of [
		["init", "-q"],
		["config", "user.email", "t@example.invalid"],
		["config", "user.name", "t"],
	]) {
		await Bun.spawn(["git", "-C", d, ...a], { stdout: "pipe", stderr: "pipe" }).exited;
	}
	// Both markers live OUTSIDE the repo: a rollback's `git clean` deletes
	// untracked files, which would wipe the very evidence under test.
	const ran = `${d}.judge-ran.txt`;
	const flag = `${d}.second.flag`;
	await Bun.write(join(d, ".pi/harness.json"), JSON.stringify({
		task: "make build pass",
		maxIterations: 2,
		timeoutMs: 20000,
		agentTimeoutMs: 30000,
		writeScope: ["ops/**"],
		sensors: [
			{ name: "build", cmd: "test -f ops/built.txt", expect: "fail" },
			{ name: "expensive", cmd: `echo ran >> ${ran}; true`, after: ["build"] },
		],
	}));
	// Agent that does nothing on the first call, then satisfies build. Written
	// BEFORE the commit: an untracked script is real dirt and the loop is right
	// to refuse a run over it.
	const agent = join(d, "agent.sh");
	await Bun.write(
		agent,
		`#!/usr/bin/env bash\nif [ -f ${flag} ]; then mkdir -p ops; touch ops/built.txt; else touch ${flag}; fi\nexit 0\n`,
	);
	chmodSync(agent, 0o755);
	await Bun.spawn(["git", "-C", d, "add", "-A"], { stdout: "pipe" }).exited;
	await Bun.spawn(["git", "-C", d, "commit", "-qm", "b"], { stdout: "pipe", stderr: "pipe" }).exited;

	const p = Bun.spawn(["bun", LOOP, "run"], {
		cwd: d,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, LOOP_SANDBOX: "off", LOOP_PI_CMD: agent },
	});
	const out = await new Response(p.stdout).text();
	await p.exited;

	expect(out).toContain("expensive ... skipped (build must pass first)");

	// It ran exactly once: the pass where build finally went green. Baseline and
	// the first failing iteration both skipped it.
	const runs = existsSync(ran) ? (await Bun.file(ran).text()).trim().split("\n").length : 0;
	expect(runs).toBe(1);

	// Skipped is not passing: the report says so, and the run could not have
	// been declared done on a pass where it never executed.
	const report = await Bun.file(join(d, ".pi/harness-report.json")).json();
	const first = report.iterations[0].sensors.find((s: { name: string }) => s.name === "expensive");
	expect(first.ok).toBe(false);
	expect(first.skipped).toBe(true);
	expect(first.output).toContain('"build" must pass first');

	rmSync(d, { recursive: true, force: true });
	rmSync(ran, { force: true });
	rmSync(flag, { force: true });
}, 120_000);
