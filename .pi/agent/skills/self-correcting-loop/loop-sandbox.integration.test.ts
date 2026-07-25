/**
 * Integration tests: the bwrap agent sandbox (manifest.sandbox).
 *
 * The writeScope fence is repo-scoped; the sandbox is what stops the agent
 * from writing OUTSIDE the repo (other projects, dotfiles, pi's own
 * extensions dir) and from reading secret dirs (~/.ssh).
 *
 *   A. sandboxed (auto, bwrap present): escape attempts FAIL, in-repo work
 *      succeeds, loop passes.
 *   B. sandbox: "off" - the same escape succeeds (discrimination: proves
 *      the jail is what blocked it, not something else).
 *   C. sandbox: "require" without bwrap (LOOP_BWRAP pointed at nothing):
 *      aborts exit 2 before any iteration.
 *
 * The fake agent records its escape-attempt outcomes into an in-repo
 * results file so the test can assert from outside the jail.
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
const AGENT_DIR = join(process.env.HOME!, ".pi", "agent");
const cleanup: string[] = [];

interface Ctx {
	repo: string;
	outside: string;
	run(extraEnv?: Record<string, string>): Promise<{ code: number; out: string }>;
	report(): any;
}

async function makeCtx(name: string, manifest: Record<string, unknown>): Promise<Ctx> {
	const repo = mkdtempSync(join(tmpdir(), `loop-sb-${name}-`));
	const box = mkdtempSync(join(tmpdir(), `loop-sb-${name}-box-`));
	// "outside" must be READ-ONLY inside the jail to be a meaningful escape
	// target - /tmp is jail-writable by design (scratch), so use a dir under
	// the real $HOME (ro via the ro-bind /) as the stand-in for "another
	// project". Cleaned up in afterAll.
	const outside = mkdtempSync(join(process.env.HOME!, `.loop-sb-${name}-`));
	cleanup.push(repo, box, outside);

	const counter = join(box, "counter");
	const fake = join(box, "fake-agent.sh");
	writeFileSync(
		fake,
		`#!/usr/bin/env bash
n=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$COUNTER_FILE"
R=src/results.txt; : > "$R"
case "$n" in
  1)
    echo done > src/ok.txt
    # escape attempt 1: write outside the repo (another "project")
    if echo evil > "$OUTSIDE_DIR/escape.txt" 2>/dev/null; then
      echo OUTSIDE_WRITE_OK >> "$R"
    else
      echo OUTSIDE_WRITE_BLOCKED >> "$R"
    fi
    # escape attempt 2: plant an extension (code persistence)
    if echo 'export {}' > "$PI_AGENT_DIR/extensions/evil-planted.ts" 2>/dev/null; then
      echo EXT_WRITE_OK >> "$R"
    else
      echo EXT_WRITE_BLOCKED >> "$R"
    fi
    # escape attempt 3: read the ssh dir
    echo "SSH_ENTRIES=$(ls -A "$HOME/.ssh" 2>/dev/null | wc -l)" >> "$R"
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
			maxIterations: 2,
			models: ["weak"],
			stallPatience: 2,
			tools: ["read", "edit", "write", "bash"],
			writeScope: ["src/**"],
			sensors: [{ name: "M", cmd: "grep -q done src/ok.txt" }],
			...manifest,
		}),
	);

	const sh = async (cmd: string[], cwd: string) => {
		const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
		await p.exited;
	};
	await sh(["git", "init", "-q"], repo);
	await sh(["git", "config", "user.email", "t@t.t"], repo);
	await sh(["git", "config", "user.name", "t"], repo);
	await sh(["git", "add", "-A"], repo);
	await sh(["git", "commit", "-q", "-m", "baseline"], repo);

	return {
		repo,
		outside,
		report() {
			return JSON.parse(readFileSync(join(repo, ".pi/harness-report.json"), "utf8"));
		},
		async run(extraEnv = {}) {
			const p = Bun.spawn(["bun", LOOP, "run"], {
				cwd: repo,
				env: {
					...process.env,
					LOOP_PI_CMD: fake,
					COUNTER_FILE: counter,
					OUTSIDE_DIR: outside,
					PI_AGENT_DIR: AGENT_DIR,
					...extraEnv,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, err, code] = await Promise.all([
				new Response(p.stdout).text(),
				new Response(p.stderr).text(),
				p.exited,
			]);
			return { code, out: out + err };
		},
	};
}

afterAll(() => {
	for (const d of cleanup) rmSync(d, { recursive: true, force: true });
	// belt+braces: if any test ever failed to block the extension plant,
	// don't leave it behind in the REAL pi config
	rmSync(join(AGENT_DIR, "extensions", "evil-planted.ts"), { force: true });
});

const hasBwrap = Bun.which("bwrap") !== null;

test("A: sandboxed agent cannot escape the repo or read secret dirs", async () => {
	if (!hasBwrap) {
		console.log("    (skipped: bwrap not installed)");
		return;
	}
	const ctx = await makeCtx("jailed", {}); // sandbox defaults to auto
	const { code } = await ctx.run();
	expect(code).toBe(0); // sensor green => loop succeeded despite escape attempts

	const results = readFileSync(join(ctx.repo, "src", "results.txt"), "utf8");
	expect(results).toContain("OUTSIDE_WRITE_BLOCKED");
	expect(results).toContain("SSH_ENTRIES=0");

	// The extension plant reports OK *inside* the jail (the overlay accepts
	// the write into its tmpfs upper) - the proof is host-side: nothing
	// landed on the real filesystem.
	expect(existsSync(join(ctx.outside, "escape.txt"))).toBe(false);
	expect(existsSync(join(AGENT_DIR, "extensions", "evil-planted.ts"))).toBe(false);
}, 30000);

test("B: sandbox off - the same escapes succeed (discrimination)", async () => {
	const ctx = await makeCtx("bare", { sandbox: "off" });
	const { code } = await ctx.run();
	expect(code).toBe(0);

	const results = readFileSync(join(ctx.repo, "src", "results.txt"), "utf8");
	expect(results).toContain("OUTSIDE_WRITE_OK");
	expect(results).toContain("EXT_WRITE_OK");
	expect(existsSync(join(ctx.outside, "escape.txt"))).toBe(true);
}, 30000);

test("C: sandbox require without bwrap aborts (exit 2) before iterating", async () => {
	const ctx = await makeCtx("require", { sandbox: "require" });
	const { code, out } = await ctx.run({ LOOP_BWRAP: "/nonexistent/bwrap" });
	expect(code).toBe(2);
	expect(out).toContain("bwrap");
	expect(existsSync(join(ctx.repo, "src", "results.txt"))).toBe(false); // agent never ran
}, 30000);
