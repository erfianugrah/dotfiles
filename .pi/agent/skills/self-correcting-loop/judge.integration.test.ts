/**
 * Integration test for judge.ts - the inferential gate.
 *
 * We substitute a SCRIPTED fake judge for `pi -p` (via $LOOP_JUDGE_CMD) whose
 * verdict is controlled by $FAKE_VERDICT, so the whole path - collect diff,
 * spawn judge, parse verdict, map to exit code - is exercised deterministically
 * with zero model/network dependence. The fake also proves the diff actually
 * reaches the judge by echoing back whether the prompt contained the change.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const JUDGE = join(import.meta.dir, "judge.ts");
let repo: string;
let fake: string;

async function sh(cmd: string[], cwd: string, env: Record<string, string> = {}) {
	const p = Bun.spawn(cmd, {
		cwd,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, code] = await Promise.all([
		new Response(p.stdout).text().then((o) => o + ""),
		p.exited,
	]);
	// merge stderr too
	const err = await new Response(p.stderr).text();
	return { code, out: out + err };
}

beforeAll(async () => {
	repo = mkdtempSync(join(tmpdir(), "judge-it-"));
	fake = join(repo, "fake-judge.sh");

	// Fake judge: emits a verdict controlled by $FAKE_VERDICT, and echoes a
	// marker proving the diff was passed in the -p prompt (arg $2).
	writeFileSync(
		fake,
		`#!/usr/bin/env bash
prompt="$2"
case "$prompt" in *DIFF_MARKER_XYZ*) echo "saw the diff" ;; esac
case "\${FAKE_VERDICT:-PASS}" in
  PASS) echo "looks correct"; echo "VERDICT: PASS" ;;
  FAIL) echo "REASONS:"; echo "- spec not met"; echo "VERDICT: FAIL" ;;
  NONE) echo "I have no opinion" ;;
esac
exit 0
`,
	);
	chmodSync(fake, 0o755);

	await sh(["git", "init", "-q"], repo);
	await sh(["git", "config", "user.email", "t@t.t"], repo);
	await sh(["git", "config", "user.name", "t"], repo);
	writeFileSync(join(repo, "base.txt"), "baseline\n");
	await sh(["git", "add", "-A"], repo);
	await sh(["git", "commit", "-q", "-m", "baseline"], repo);

	// A change the judge must SEE: contains the marker the fake greps for.
	writeFileSync(join(repo, "change.txt"), "DIFF_MARKER_XYZ\n");
}, 30000);

afterAll(() => rmSync(repo, { recursive: true, force: true }));

test("PASS verdict => exit 0 (quiet - reasons discarded on pass)", async () => {
	const { code, out } = await sh(["bun", JUDGE, "--spec", "make change"], repo, {
		LOOP_JUDGE_CMD: fake,
		FAKE_VERDICT: "PASS",
	});
	expect(code).toBe(0);
	expect(out).toContain("judge: PASS");
});

test("FAIL => exit 1, reasons fed back, and the diff reached the judge", async () => {
	const { code, out } = await sh(["bun", JUDGE, "--spec", "make change"], repo, {
		LOOP_JUDGE_CMD: fake,
		FAKE_VERDICT: "FAIL",
	});
	expect(code).toBe(1);
	expect(out).toContain("judge: FAIL");
	expect(out).toContain("spec not met");
	expect(out).toContain("saw the diff"); // untracked change.txt was diffed into the prompt
});

test("no verdict => fail-closed (exit 1) by default", async () => {
	const { code } = await sh(["bun", JUDGE, "--spec", "make change"], repo, {
		LOOP_JUDGE_CMD: fake,
		FAKE_VERDICT: "NONE",
	});
	expect(code).toBe(1);
});

test("no verdict + --lenient => fail-open (exit 0)", async () => {
	const { code, out } = await sh(["bun", JUDGE, "--spec", "make change", "--lenient"], repo, {
		LOOP_JUDGE_CMD: fake,
		FAKE_VERDICT: "NONE",
	});
	expect(code).toBe(0);
	expect(out).toContain("--lenient");
});

test("usage error (no --spec) => exit 2", async () => {
	const { code } = await sh(["bun", JUDGE], repo, { LOOP_JUDGE_CMD: fake });
	expect(code).toBe(2);
});
