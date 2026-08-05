import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLI = join(dirname(Bun.fileURLToPath(import.meta.url)), "prose-lint.ts");
const dirs: string[] = [];

function workdir(): string {
	const d = mkdtempSync(join(tmpdir(), "prose-lint-"));
	dirs.push(d);
	return d;
}

afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function run(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
	const p = Bun.spawn(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
	return { code: await p.exited, out, err };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	const p = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "ignore",
		stderr: "ignore",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	});
	await p.exited;
}

/** Prose that clears every default gate: varied length, no slop vocabulary. */
const CLEAN = `# Cache behaviour

The cache stores a response for each request. A later request with the same key
reads that stored response instead of calling the model again.

When two prompts differ only in wording, the exact-match cache misses. This
costs a full model call. The semantic cache compares meaning instead, so a
reworded prompt still hits.

Set the threshold with \`similarity\`. A value near 1 demands a close match. A
lower value accepts loose matches and raises the risk of a wrong hit. Start at
the default and tune it against real traffic.
`;

const SLOPPY = `# Overview

Our robust and seamless caching layer is designed to effortlessly supercharge
your application by leveraging cutting-edge semantic matching that empowers
developers to unlock world-class performance across every conceivable workload
without any vendor lock-in whatsoever. It is important to note that this
enterprise-grade solution will spin up in seconds and additionally provides
sensible defaults that reach out across your entire stack seamlessly.
`;

describe("prose-lint CLI", () => {
	test("clean prose exits 0", async () => {
		const d = workdir();
		await Bun.write(join(d, "clean.md"), CLEAN);
		const r = await run(d, ["clean.md"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("slop");
	});

	test("sloppy prose exits 1 and names the score", async () => {
		const d = workdir();
		await Bun.write(join(d, "slop.md"), SLOPPY);
		const r = await run(d, ["slop.md"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain("--max");
	});

	test("--no-max drops the score gate but keeps the structural gates", async () => {
		const d = workdir();
		await Bun.write(join(d, "slop.md"), SLOPPY);
		const r = await run(d, ["slop.md", "--no-max"]);
		expect(r.err).not.toContain("--max");
		// The half that must SURVIVE --no-max. Asserting only the absence above
		// would pass just as well if --no-max disabled every gate.
		expect(r.err).toContain("mean-sentence-ceiling");
		expect(r.code).toBe(1);
	});

	test("--max tightens the gate", async () => {
		const d = workdir();
		// A document with a SMALL but non-zero score, so the threshold is what
		// decides the outcome. An earlier version of this test used the clean
		// fixture, which scores 0.00 and passes at every threshold - it could
		// not have failed if --max were ignored outright.
		await Bun.write(join(d, "mild.md"), CLEAN.replace("The cache stores", "The robust cache stores"));
		const loose = await run(d, ["mild.md", "--max", "5"]);
		const tight = await run(d, ["mild.md", "--max", "0"]);
		expect(loose.code).toBe(0);
		expect(tight.code).toBe(1);
		expect(tight.err).toContain("--max 0");
	});

	test("prose chopped into stubs is caught by the structural gate, not the score", async () => {
		const d = workdir();
		await Bun.write(
			join(d, "chopped.md"),
			"A cache misses. Text is exact. Wording shifts. A miss occurs. It compares. It uses meaning. Prompts cache. Two match. It returns. Cost drops. Time drops. Use it.\n",
		);
		const r = await run(d, ["chopped.md"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain("mean-sentence-floor");
		// The score alone would have passed this: no slop vocabulary at all.
		expect(r.err).not.toContain("--max");
	});

	test("--explain prints file:line for each violation", async () => {
		const d = workdir();
		await Bun.write(join(d, "slop.md"), SLOPPY);
		const r = await run(d, ["slop.md", "--explain"]);
		expect(r.out).toMatch(/slop\.md:\d+\s+marketing/);
		// No violation may claim line 0: that is the whole-document sentinel and
		// printing it as a location reads like a bug.
		expect(r.out).not.toContain("slop.md:0");
	});

	test("--explain labels whole-document findings instead of printing line 0", async () => {
		const d = workdir();
		await Bun.write(
			join(d, "rot.md"),
			"# Setup\n\nEdit the config to add a route. The config is read once at boot.\n\nThe configuration also sets the port. Keep that configuration under review.\n",
		);
		const r = await run(d, ["rot.md", "--explain", "--no-max"]);
		expect(r.out).toContain("(whole file)  referent-rotation: config / configuration");
		expect(r.out).not.toContain("rot.md:0");
	});

	test("--json emits reports and failures", async () => {
		const d = workdir();
		await Bun.write(join(d, "slop.md"), SLOPPY);
		const r = await run(d, ["slop.md", "--json"]);
		const parsed = JSON.parse(r.out);
		expect(parsed.reports).toHaveLength(1);
		expect(parsed.reports[0].score).toBeGreaterThan(0);
		expect(parsed.failures.length).toBeGreaterThan(0);
	});

	test("em-dash is reported as a marker and excluded from the score", async () => {
		const d = workdir();
		const withDash = CLEAN.replace("The cache stores", "The cache \u2014 always \u2014 stores");
		await Bun.write(join(d, "a.md"), CLEAN);
		await Bun.write(join(d, "b.md"), withDash);
		const a = JSON.parse((await run(d, ["a.md", "--json"])).out).reports[0];
		const b = JSON.parse((await run(d, ["b.md", "--json"])).out).reports[0];
		expect(b.markers.emDash).toBe(2);
		expect(a.markers.emDash).toBe(0);
		// Same slop score despite two em-dashes: the marker is not a violation.
		expect(b.score).toBeCloseTo(a.score, 5);
	});

	test("a config file extends the shipped lexicon", async () => {
		const d = workdir();
		await Bun.write(join(d, "a.md"), CLEAN.replace("The cache stores", "The zesty cache stores"));
		await Bun.write(join(d, "pl.json"), JSON.stringify({ marketing: { add: ["zesty"] } }));
		expect((await run(d, ["a.md"])).code).toBe(0);
		const r = await run(d, ["a.md", "--config", "pl.json", "--explain"]);
		expect(r.out).toContain("marketing: zesty");
	});

	test("a bad config is a usage error, not a crash", async () => {
		const d = workdir();
		await Bun.write(join(d, "a.md"), CLEAN);
		await Bun.write(join(d, "pl.json"), "{ not json");
		expect((await run(d, ["a.md", "--config", "pl.json"])).code).toBe(2);
	});

	test("unknown flags and missing files exit 2", async () => {
		const d = workdir();
		await Bun.write(join(d, "a.md"), CLEAN);
		expect((await run(d, ["a.md", "--nope"])).code).toBe(2);
		expect((await run(d, ["missing.md"])).code).toBe(2);
		expect((await run(d, [])).code).toBe(2);
	});

	describe("--before <rev>", () => {
		test("a rewrite that drops facts fails the retention gate", async () => {
			const d = workdir();
			await git(d, "init", "-q");
			const before = `# Limits

The API allows a maximum of 100 requests per minute for each account. Read the
\`Retry-After\` header to find the exact wait time before retrying the call.
Requests beyond that ceiling receive a rejection and should be retried later.
`;
			await Bun.write(join(d, "doc.md"), before);
			await git(d, "add", "-A");
			await git(d, "commit", "-qm", "base");

			// Same shape, specifics deleted.
			await Bun.write(
				join(d, "doc.md"),
				`# Limits

The API allows only so many requests each minute for every account. Read the
response header to find the exact wait time before you retry the failed call.
Requests beyond that ceiling receive a rejection and should be retried later.
`,
			);
			const r = await run(d, ["doc.md", "--before", "HEAD"]);
			expect(r.code).toBe(1);
			expect(r.err).toContain("fact-retention");
			expect(r.err).toContain("Retry-After");
			expect(r.err).toContain("100");
		});

		test("a rewrite that keeps the facts passes", async () => {
			const d = workdir();
			await git(d, "init", "-q");
			await Bun.write(join(d, "doc.md"), "The cap is 100 per minute. Read `Retry-After` for the wait.\n");
			await git(d, "add", "-A");
			await git(d, "commit", "-qm", "base");
			await Bun.write(
				join(d, "doc.md"),
				"Each account may send 100 requests per minute. The `Retry-After` header gives the wait time.\n",
			);
			const r = await run(d, ["doc.md", "--before", "HEAD"]);
			expect(r.err).not.toContain("fact-retention");
			// not.toContain alone would also pass if the run died for some other
			// reason before reaching the gate.
			expect(r.code).toBe(0);
		});

		test("editing a fenced code example does not count as losing a fact", async () => {
			// Regression: facts were extracted from the whole file, so bumping a
			// version inside a ```bash block dropped a "fact" and failed a
			// perfectly legitimate edit. Any code-example change tripped it.
			const d = workdir();
			await git(d, "init", "-q");
			const doc = (v: string) =>
				`# API\n\nThe client sends at most 100 requests each minute to the endpoint.\n\n\`\`\`bash\nnpm install widget@${v}\n\`\`\`\n\nRead the \`Retry-After\` header when the server rejects a call.\n`;
			await Bun.write(join(d, "d.md"), doc("1.2.3"));
			await git(d, "add", "-A");
			await git(d, "commit", "-qm", "base");

			await Bun.write(join(d, "d.md"), doc("1.2.4"));
			const r = await run(d, ["d.md", "--before", "HEAD"]);
			expect(r.err).not.toContain("fact-retention");
			expect(r.code).toBe(0);
		});

		test("a fact stated in PROSE is still protected", async () => {
			// The other side of the same change: masking fenced code must not have
			// disarmed the gate for prose, which is what it is actually for.
			const d = workdir();
			await git(d, "init", "-q");
			await Bun.write(
				join(d, "d.md"),
				"# API\n\nThe client sends at most 100 requests each minute.\n\n```bash\nnpm install widget@1.2.3\n```\n",
			);
			await git(d, "add", "-A");
			await git(d, "commit", "-qm", "base");

			await Bun.write(
				join(d, "d.md"),
				"# API\n\nThe client sends only a limited number of requests.\n\n```bash\nnpm install widget@1.2.3\n```\n",
			);
			const r = await run(d, ["d.md", "--before", "HEAD"]);
			expect(r.code).toBe(1);
			expect(r.err).toContain("fact-retention");
			expect(r.err).toContain("100");
		});

		test("a file absent from the revision skips the gate instead of failing", async () => {
			const d = workdir();
			await git(d, "init", "-q");
			await Bun.write(join(d, "seed.md"), "seed\n");
			await git(d, "add", "-A");
			await git(d, "commit", "-qm", "base");
			await Bun.write(join(d, "new.md"), CLEAN);
			const r = await run(d, ["new.md", "--before", "HEAD"]);
			expect(r.code).toBe(0);
		});
	});

	describe("ratchet", () => {
		test("--update-baseline writes scores and a regression then fails", async () => {
			const d = workdir();
			await Bun.write(join(d, "a.md"), CLEAN);
			const w = await run(d, ["a.md", "--baseline", "base.json", "--update-baseline"]);
			expect(w.code).toBe(0);
			expect(JSON.parse(await Bun.file(join(d, "base.json")).text())["a.md"]).toBeDefined();

			// Unchanged file still passes against its own baseline.
			expect((await run(d, ["a.md", "--baseline", "base.json"])).code).toBe(0);

			// Introduce slop vocabulary: score rises above the stored value.
			await Bun.write(join(d, "a.md"), CLEAN.replace("The cache stores", "The robust seamless cache stores"));
			const r = await run(d, ["a.md", "--baseline", "base.json"]);
			expect(r.code).toBe(1);
			expect(r.err).toContain("regressed against baseline");
		});

		test("a path spelled two ways is one ratchet key", async () => {
			// Regression: scores were keyed on the raw argv string, so writing the
			// baseline as "a.md" and re-running as "./a.md" missed the key and the
			// ratchet silently stopped gating - the failure mode where you believe
			// you are protected and are not.
			const d = workdir();
			await Bun.write(join(d, "a.md"), CLEAN);
			await run(d, ["a.md", "--baseline", "base.json", "--update-baseline"]);
			const stored = JSON.parse(await Bun.file(join(d, "base.json")).text());
			expect(Object.keys(stored)).toEqual(["a.md"]);

			await Bun.write(join(d, "a.md"), CLEAN.replace("The cache stores", "The robust seamless cache stores"));
			const r = await run(d, ["./a.md", "--baseline", "base.json"]);
			expect(r.code).toBe(1);
			expect(r.err).toContain("regressed against baseline");
		});

		test("--update-baseline without --baseline is a usage error", async () => {
			const d = workdir();
			await Bun.write(join(d, "a.md"), CLEAN);
			expect((await run(d, ["a.md", "--update-baseline"])).code).toBe(2);
		});
	});
});
