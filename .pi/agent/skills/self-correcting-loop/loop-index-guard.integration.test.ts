/**
 * Regression tests: the index-guard must neutralize agent-run git mutations
 * that attack the checkpoint WITHOUT moving HEAD (the ref-guard's blind
 * spot before this fix):
 *
 *   A. `git update-index --skip-worktree` hides a tracked file from
 *      `git diff` -> a scope-fence EVASION. read-tree rebuilds the index
 *      wholesale, dropping the flag, so the edit shows up and is reverted.
 *   B. `git reset --hard HEAD` destroys the checkpoint index itself,
 *      wiping keeper state that was staged but never committed. The
 *      unconditional read-tree restore brings it back.
 *   C. `git stash` hides the iteration's work from sensors and the fence.
 *      Detected via refs/stash and surfaced as a loop note; work the agent
 *      pops back later flows through the fence normally.
 *
 * Each case is constructed to FAIL without the index-guard and PASS with it.
 */

import { afterAll, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOP = join(import.meta.dir, "loop.ts");
const cleanup: string[] = [];

interface Repo {
	dir: string;
	head: string;
	run(): Promise<{ code: number; out: string }>;
	report(): any;
	git(args: string[]): Promise<string>;
}

async function makeRepo(opts: {
	name: string;
	files: Record<string, string>;
	fakeAgent: string;
	sensors: { name: string; cmd: string }[];
	writeScope: string[];
	maxIterations?: number;
}): Promise<Repo> {
	const dir = mkdtempSync(join(tmpdir(), `loop-ig-${opts.name}-`));
	const box = mkdtempSync(join(tmpdir(), `loop-ig-${opts.name}-box-`));
	cleanup.push(dir, box);

	const counter = join(box, "counter");
	const fake = join(box, "fake-agent.sh");
	writeFileSync(
		fake,
		`#!/usr/bin/env bash
n=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$COUNTER_FILE"
case "$n" in
${opts.fakeAgent}
  *) : ;;
esac
exit 0
`,
	);
	chmodSync(fake, 0o755);

	for (const [rel, content] of Object.entries(opts.files)) {
		mkdirSync(join(dir, rel, ".."), { recursive: true });
		writeFileSync(join(dir, rel), content);
	}
	await Bun.write(
		join(dir, ".pi/harness.json"),
		JSON.stringify({
			task: "make the sensors pass",
			maxIterations: opts.maxIterations ?? 3,
			models: ["weak"],
			stallPatience: 2,
			tools: ["read", "edit", "write", "bash"],
			writeScope: opts.writeScope,
			sensors: opts.sensors,
		}),
	);

	const git = async (args: string[]) => {
		const p = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
		const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
		return out;
	};
	await git(["init", "-q"]);
	await git(["config", "user.email", "t@t.t"]);
	await git(["config", "user.name", "t"]);
	await git(["add", "-A"]);
	await git(["commit", "-q", "-m", "baseline"]);

	return {
		dir,
		head: (await git(["rev-parse", "HEAD"])).trim(),
		git,
		async run() {
			const p = Bun.spawn(["bun", LOOP, "run"], {
				cwd: dir,
				env: { ...process.env, LOOP_PI_CMD: fake, COUNTER_FILE: counter },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
			return { code, out };
		},
		report() {
			return JSON.parse(readFileSync(join(dir, ".pi/harness-report.json"), "utf8"));
		},
	};
}

afterAll(() => {
	for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

test("A: skip-worktree fence evasion is neutralized (read-tree drops the flag)", async () => {
	const r = await makeRepo({
		name: "skipworktree",
		files: { "src/ok.txt": "", "forbidden-tracked.txt": "clean\n" },
		writeScope: ["src/ok.txt"],
		sensors: [
			{ name: "M1", cmd: "grep -q done src/ok.txt" },
			{ name: "M2", cmd: "! grep -q poison forbidden-tracked.txt" },
		],
		fakeAgent: `  1)
    git update-index --skip-worktree forbidden-tracked.txt
    echo poison > forbidden-tracked.txt   # OUT of scope, hidden from git diff
    echo done > src/ok.txt                # IN scope
    ;;`,
	});

	const { code } = await r.run();
	expect(code).toBe(0); // without the guard: M2 red forever -> exit 1
	expect(readFileSync(join(r.dir, "forbidden-tracked.txt"), "utf8")).toBe("clean\n");
	expect(readFileSync(join(r.dir, "src", "ok.txt"), "utf8")).toContain("done");
	const rep = r.report();
	expect(rep.iterations[0].scopeViolations).toContain("forbidden-tracked.txt");
	// the evasion flag itself is gone (index rebuilt from the checkpoint tree)
	expect((await r.git(["ls-files", "-v", "forbidden-tracked.txt"])).startsWith("H")).toBe(true);
}, 30000);

test("B: reset --hard cannot destroy the staged-but-uncommitted checkpoint", async () => {
	const r = await makeRepo({
		name: "resethard",
		files: { "src/ok.txt": "" },
		writeScope: ["src/ok.txt"],
		maxIterations: 4,
		sensors: [
			{ name: "M1", cmd: "grep -q step1 src/ok.txt" },
			{ name: "M2", cmd: "grep -q step2 src/ok.txt" },
		],
		fakeAgent: `  1)
    echo step1 > src/ok.txt    # M1 green -> keeper checkpoint (staged, never committed)
    ;;
  2)
    git reset --hard HEAD      # attacks the checkpoint index itself
    ;;
  3)
    echo step2 >> src/ok.txt   # only step2 - step1 must have survived via the checkpoint
    ;;`,
	});

	const { code } = await r.run();
	expect(code).toBe(0); // without the guard: step1 lost in iter2 -> M1 red forever
	expect(readFileSync(join(r.dir, "src", "ok.txt"), "utf8")).toBe("step1\nstep2\n");
	expect((await r.git(["rev-parse", "HEAD"])).trim()).toBe(r.head);
}, 30000);

test("C: stash is detected (loop note); popped work flows through the fence", async () => {
	const r = await makeRepo({
		name: "stash",
		files: { "src/ok.txt": "" },
		writeScope: ["src/ok.txt"],
		sensors: [{ name: "M", cmd: "grep -q done src/ok.txt" }],
		fakeAgent: `  1)
    echo done > src/ok.txt
    git stash                  # hides the work from sensors + fence
    ;;
  2)
    git stash pop              # brings it back as an ordinary worktree edit
    ;;`,
	});

	const { code } = await r.run();
	expect(code).toBe(0);
	expect(readFileSync(join(r.dir, "src", "ok.txt"), "utf8")).toContain("done");
	const rep = r.report();
	expect(rep.iterations[0].notes.join("\n")).toContain("stash");
	expect(existsSync(join(r.dir, "src", "ok.txt"))).toBe(true);
}, 30000);
