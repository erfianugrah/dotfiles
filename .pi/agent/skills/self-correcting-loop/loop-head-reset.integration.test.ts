/**
 * Regression test: the ref-guard must undo an agent-run `git commit`.
 *
 * The bug: the governor's state model is the git index - changedPaths()
 * diffs worktree vs index, and a commit leaves worktree == index, so an
 * agent that commits (plan docs often instruct per-task commits) made the
 * scope fence blind AND baked out-of-scope edits into history; rollback
 * never touched HEAD either, so the commit survived even a rolled-back
 * iteration.
 *
 * The fix: after each agent iteration, if HEAD moved, `git reset --soft`
 * back to the checkpoint HEAD and `git read-tree` the checkpoint tree
 * snapshot (a bare reset --mixed would destroy keeper state that was
 * staged but never committed). The agent's changes become ordinary
 * worktree-vs-checkpoint deltas and flow through the normal scope fence.
 *
 * Fake agent (single iteration): makes an IN-scope edit (src/ok.txt),
 * an OUT-of-scope edit (forbidden.txt), then commits BOTH.
 * Expect: commit undone (HEAD back at baseline), out-of-scope file
 * reverted, in-scope file kept, sensor green, exit 0.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOP = join(import.meta.dir, "loop.ts");
let repo: string;
let box: string;
let counter: string;
let fake: string;
let baselineHead: string;

async function sh(cmd: string[], cwd: string): Promise<string> {
	const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
	return out;
}

beforeAll(async () => {
	repo = mkdtempSync(join(tmpdir(), "loop-head-repo-"));
	box = mkdtempSync(join(tmpdir(), "loop-head-box-"));
	counter = join(box, "counter");
	fake = join(box, "fake-agent.sh");

	writeFileSync(
		fake,
		`#!/usr/bin/env bash
n=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$COUNTER_FILE"
case "$n" in
  1)
    echo done > src/ok.txt          # IN scope
    echo poison > forbidden.txt     # OUT of scope
    git add -A
    git commit -q -m "wip: agent commit"
    ;;
  *) : ;;
esac
exit 0
`,
	);
	chmodSync(fake, 0o755);

	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src", "ok.txt"), "");
	await Bun.write(
		join(repo, ".pi/harness.json"),
		JSON.stringify({
			task: "make the sensor pass",
			maxIterations: 3,
			models: ["weak"],
			stallPatience: 2,
			tools: ["read", "edit", "write", "bash"],
			writeScope: ["src/ok.txt"],
			sensors: [{ name: "M", cmd: "grep -q done src/ok.txt" }],
		}),
	);

	await sh(["git", "init", "-q"], repo);
	await sh(["git", "config", "user.email", "t@t.t"], repo);
	await sh(["git", "config", "user.name", "t"], repo);
	await sh(["git", "add", "-A"], repo);
	await sh(["git", "commit", "-q", "-m", "baseline"], repo);
	baselineHead = (await sh(["git", "rev-parse", "HEAD"], repo)).trim();
}, 30000);

afterAll(() => {
	rmSync(repo, { recursive: true, force: true });
	rmSync(box, { recursive: true, force: true });
});

test("agent-run commit is undone; scope fence still fires on committed files", async () => {
	const proc = Bun.spawn(["bun", LOOP, "run"], {
		cwd: repo,
		env: { ...process.env, LOOP_PI_CMD: fake, COUNTER_FILE: counter },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	expect(code).toBe(0);

	// HEAD is back at the baseline commit - the agent's wip commit is gone.
	expect((await sh(["git", "rev-parse", "HEAD"], repo)).trim()).toBe(baselineHead);
	expect((await sh(["git", "log", "-1", "--format=%s"], repo)).trim()).toBe("baseline");

	// The committed out-of-scope file was still caught by the fence and removed.
	expect(existsSync(join(repo, "forbidden.txt"))).toBe(false);
	// The committed in-scope edit survived (sensor went green).
	expect(readFileSync(join(repo, "src", "ok.txt"), "utf8")).toContain("done");

	const report = JSON.parse(readFileSync(join(repo, ".pi/harness-report.json"), "utf8"));
	expect(report.result).toBe("pass");
	expect(report.iterations[0].scopeViolations).toContain("forbidden.txt");
	expect(report.iterations[0].notes.join("\n")).toContain("moved HEAD");
}, 30000);
