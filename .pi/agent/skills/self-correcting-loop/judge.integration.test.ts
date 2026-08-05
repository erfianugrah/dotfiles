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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const JUDGE = join(import.meta.dir, "judge.ts");
let repo: string;
let fake: string;
let fakeCapture: string;
let fakeCaptureFail: string;

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
	// marker proving the diff was passed via STDIN (judge.ts pipes the prompt
	// to `pi -p` - argv is capped at 128 KiB per argument, big diffs hit E2BIG).
	writeFileSync(
		fake,
		`#!/usr/bin/env bash
prompt="$(cat)"
case "$prompt" in *DIFF_MARKER_XYZ*) echo "saw the diff" ;; esac
case "$prompt" in *.png*) echo "saw a screenshot" ;; esac
case "\${FAKE_VERDICT:-PASS}" in
  PASS) echo "looks correct"; echo "VERDICT: PASS" ;;
  FAIL) echo "REASONS:"; echo "- spec not met"; echo "VERDICT: FAIL" ;;
  NONE) echo "I have no opinion" ;;
esac
exit 0
`,
	);
	chmodSync(fake, 0o755);

	// Fake capture: mimics browser-assert - writes a PNG to the path after
	// --screenshot (always the last two args here) and exits 0.
	fakeCapture = join(repo, "fake-capture.sh");
	writeFileSync(
		fakeCapture,
		`#!/usr/bin/env bash
out=""; prev=""
for a in "$@"; do [ "$prev" = "--screenshot" ] && out="$a"; prev="$a"; done
[ -n "$out" ] && printf 'PNG-BYTES' > "$out"
exit 0
`,
	);
	chmodSync(fakeCapture, 0o755);

	// Fake capture that fails (browser wedged / server down).
	fakeCaptureFail = join(repo, "fake-capture-fail.sh");
	writeFileSync(fakeCaptureFail, "#!/usr/bin/env bash\necho 'capture boom' >&2\nexit 1\n");
	chmodSync(fakeCaptureFail, 0o755);

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

test("VISUAL --url: captures a screenshot, judges it, PASS => exit 0", async () => {
	const shot = join(repo, "ux.png");
	const { code } = await sh(
		["bun", JUDGE, "--spec", "page looks right", "--url", "http://localhost:4333/", "--screenshot", shot],
		repo,
		{ LOOP_JUDGE_CMD: fake, LOOP_CAPTURE_CMD: fakeCapture, FAKE_VERDICT: "PASS" },
	);
	expect(code).toBe(0);
	expect(existsSync(shot)).toBe(true); // capture actually ran
});

test("VISUAL FAIL: exit 1 and the screenshot path reached the judge prompt", async () => {
	const { code, out } = await sh(
		["bun", JUDGE, "--spec", "page looks right", "--url", "http://x/", "--screenshot", join(repo, "ux2.png")],
		repo,
		{ LOOP_JUDGE_CMD: fake, LOOP_CAPTURE_CMD: fakeCapture, FAKE_VERDICT: "FAIL" },
	);
	expect(code).toBe(1);
	expect(out).toContain("saw a screenshot"); // visual prompt embedded the .png path
});

test("VISUAL --screenshot only (pre-captured, no --url): no capture needed", async () => {
	const shot = join(repo, "pre.png");
	writeFileSync(shot, "PNG-BYTES");
	const { code } = await sh(
		["bun", JUDGE, "--spec", "looks right", "--screenshot", shot],
		repo,
		// capture cmd deliberately set to the FAILING one to prove it is NOT called.
		{ LOOP_JUDGE_CMD: fake, LOOP_CAPTURE_CMD: fakeCaptureFail, FAKE_VERDICT: "PASS" },
	);
	expect(code).toBe(0);
});

test("VISUAL capture failure => fail-closed (exit 1)", async () => {
	const { code } = await sh(
		["bun", JUDGE, "--spec", "x", "--url", "http://down/"],
		repo,
		{ LOOP_JUDGE_CMD: fake, LOOP_CAPTURE_CMD: fakeCaptureFail },
	);
	expect(code).toBe(1);
});

/**
 * These two use their OWN repo: the shared fixture accumulates stray untracked
 * files from the visual tests, and both assertions here turn on the diff being
 * genuinely empty.
 */
async function freshRepo(): Promise<string> {
	const d = mkdtempSync(join(tmpdir(), "judge-empty-"));
	await sh(["git", "init", "-q"], d);
	await sh(["git", "config", "user.email", "t@t.t"], d);
	await sh(["git", "config", "user.name", "t"], d);
	writeFileSync(join(d, "base.txt"), "baseline\n");
	await sh(["git", "add", "-A"], d);
	await sh(["git", "commit", "-q", "-m", "baseline"], d);
	return d;
}

test("loop artifacts never reach the reviewers", async () => {
	// Two reviewers wrote up `.pi/harness-run.log` as a defect - "committing a
	// harness run log as the sole deliverable is unrequested scope" - because
	// the loop's own output was sitting untracked in the tree being judged.
	const d = await freshRepo();
	mkdirSync(join(d, ".pi"), { recursive: true });
	writeFileSync(join(d, ".pi/harness-run.log"), "DIFF_MARKER_XYZ loop trace\n");
	writeFileSync(join(d, ".pi/harness-report.json"), '{"marker":"DIFF_MARKER_XYZ"}\n');

	const { code, out } = await sh(["bun", JUDGE, "--spec", "make change"], d, {
		LOOP_JUDGE_CMD: fake,
		FAKE_VERDICT: "PASS",
	});

	expect(out).not.toContain("saw the diff"); // the artifacts were filtered out
	expect(out).toContain("nothing to review"); // ...leaving nothing at all
	expect(code).toBe(1); // fail-closed: the change was not made

	// A real change in the same tree IS still reviewed - the filter is narrow.
	// FAIL, not PASS: reasons are only echoed on a failing verdict, and the
	// echoed reasons are how we prove the diff reached the reviewer.
	writeFileSync(join(d, "change.txt"), "DIFF_MARKER_XYZ\n");
	const real = await sh(["bun", JUDGE, "--spec", "make change"], d, {
		LOOP_JUDGE_CMD: fake,
		FAKE_VERDICT: "FAIL",
	});
	expect(real.out).toContain("saw the diff");
	expect(real.code).toBe(1);

	rmSync(d, { recursive: true, force: true });
});

test("an empty diff is failed without spending a model call", async () => {
	// Baseline: the tree matches the base ref. An adversarial CODE judge would
	// burn minutes of a frontier model to conclude "the work was not started",
	// and that text then becomes iteration 1's "previous attempt failed"
	// feedback about an attempt that never happened.
	const d = await freshRepo();
	const { code, out } = await sh(["bun", JUDGE, "--spec", "make change"], d, {
		LOOP_JUDGE_CMD: fake,
		FAKE_VERDICT: "PASS", // would pass if the judge ran at all
	});
	expect(code).toBe(1);
	expect(out).toContain("nothing to review");
	expect(out).not.toContain("looks correct"); // the fake judge never ran

	// --lenient still opts out of fail-closed, as everywhere else.
	const lenient = await sh(["bun", JUDGE, "--spec", "s", "--lenient"], d, {
		LOOP_JUDGE_CMD: fake,
	});
	expect(lenient.code).toBe(0);

	rmSync(d, { recursive: true, force: true });
});
