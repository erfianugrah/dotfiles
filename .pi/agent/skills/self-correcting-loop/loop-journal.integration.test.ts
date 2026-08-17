/**
 * Journal integration: every completed run appends exactly one JSON line to
 * $LOOP_JOURNAL with the cross-repo perf record (result, iterations, kept,
 * agentMs, modelUsed, taskSha), the trivially-green early exit journals
 * "already-green" with zero iterations, and `loop history` renders both.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOP = join(import.meta.dir, "loop.ts");

let box: string;
let journal: string;

async function mkRepo(name: string, sensorOk: boolean): Promise<string> {
	const repo = join(box, name);
	mkdirSync(join(repo, ".pi"), { recursive: true });
	writeFileSync(join(repo, "file.txt"), sensorOk ? "ok\n" : "");
	await Bun.write(
		join(repo, ".pi/harness.json"),
		JSON.stringify({
			task: `make the sensor pass in ${name}`,
			maxIterations: 3,
			models: ["weak"],
			tools: ["bash"],
			writeScope: ["file.txt"],
			sensors: [{ name: "A", cmd: "grep -q ok file.txt" }],
		}),
	);
	const sh = async (args: string[]) => {
		const p = Bun.spawn(args, { cwd: repo, stdout: "pipe", stderr: "pipe" });
		await p.exited;
	};
	await sh(["git", "init", "-q"]);
	await sh(["git", "config", "user.email", "t@t.t"]);
	await sh(["git", "config", "user.name", "t"]);
	await sh(["git", "add", "-A"]);
	await sh(["git", "commit", "-q", "-m", "baseline"]);
	return repo;
}

async function runLoop(cwd: string, extraEnv: Record<string, string> = {}) {
	const proc = Bun.spawn(["bun", LOOP, "run"], {
		cwd,
		env: {
			...process.env,
			LOOP_SANDBOX: "off",
			LOOP_JOURNAL: journal,
			...extraEnv,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, code] = await Promise.all([
		new Response(proc.stdout).text(),
		proc.exited,
	]);
	return { out, code };
}

function journalLines(): Record<string, unknown>[] {
	return readFileSync(journal, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

beforeAll(async () => {
	box = mkdtempSync(join(tmpdir(), "loop-journal-it-"));
	journal = join(box, "runs.jsonl");

	// Fake agent: fixes the sensor on the first call.
	const fake = join(box, "fake-agent.sh");
	writeFileSync(fake, '#!/usr/bin/env bash\necho ok > file.txt\nexit 0\n');
	chmodSync(fake, 0o755);

	const repo = await mkRepo("converges", false);
	const { code } = await runLoop(repo, { LOOP_PI_CMD: fake });
	expect(code).toBe(0);

	const green = await mkRepo("already-green", true);
	const g = await runLoop(green);
	expect(g.code).toBe(0);
}, 60000);

afterAll(() => {
	rmSync(box, { recursive: true, force: true });
});

test("completed run appends one journal line with the perf record", () => {
	const lines = journalLines();
	expect(lines.length).toBe(2);
	const r = lines[0] as never as {
		v: number; result: string; repo: string; iterations: number; kept: number;
		agentMs: number; modelUsed: string[]; taskSha: string; headSha: string;
		initialFailing: number; finalFailing: number; iter: unknown[];
	};
	expect(r.v).toBe(1);
	expect(r.result).toBe("pass");
	expect(r.repo).toBe("converges");
	expect(r.iterations).toBe(1);
	expect(r.kept).toBe(1);
	expect(r.initialFailing).toBe(1);
	expect(r.finalFailing).toBe(0);
	expect(typeof r.agentMs).toBe("number");
	expect(r.modelUsed).toEqual(["weak"]);
	expect(r.taskSha).toMatch(/^[0-9a-f]{12}$/);
	expect(typeof r.headSha).toBe("string");
	expect(r.iter.length).toBe(1);
});

test("trivially-green run journals already-green with zero iterations", () => {
	const r = journalLines()[1] as never as {
		result: string; repo: string; iterations: number; iter: unknown[];
	};
	expect(r.result).toBe("already-green");
	expect(r.repo).toBe("already-green");
	expect(r.iterations).toBe(0);
	expect(r.iter).toEqual([]);
});

test("loop history renders the journal (table + --json)", async () => {
	const proc = Bun.spawn(["bun", LOOP, "history", "--last", "5"], {
		env: { ...process.env, LOOP_JOURNAL: journal },
		stdout: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	expect(await proc.exited).toBe(0);
	expect(out).toContain("converges");
	expect(out).toContain("already-green");

	const pj = Bun.spawn(["bun", LOOP, "history", "--json"], {
		env: { ...process.env, LOOP_JOURNAL: journal },
		stdout: "pipe",
	});
	const raw = await new Response(pj.stdout).text();
	expect(await pj.exited).toBe(0);
	const rows = raw.trim().split("\n").map((l) => JSON.parse(l));
	expect(rows.length).toBe(2);
	expect(rows[0].result).toBe("pass");
});
