// .pi/agent/tests/semantic-inject.test.ts
import { describe, expect, test } from "bun:test";
import {
	buildSemanticBlock,
	decideInject,
	fetchSemanticHits,
	freshSemanticState,
	HIT_TEXT_MAX,
	MAX_HITS,
	MIN_SIMILARITY,
	SEMANTIC_INJECT_HEADER,
	SEMANTIC_INJECT_MARKER,
} from "../extensions/lib/semantic-inject-core.ts";

const hit = (sim: number, text: string, key = "pi:HOST:abc", ord = 12) => ({
	session_key: key,
	ordinal: ord,
	text,
	similarity: sim,
});

describe("buildSemanticBlock", () => {
	test("empty hits -> empty string", () => {
		expect(buildSemanticBlock([])).toBe("");
	});

	test("below-threshold hits are dropped", () => {
		expect(buildSemanticBlock([hit(MIN_SIMILARITY - 0.01, "noise")])).toBe("");
	});

	test("at-threshold hit is kept, header + footer + marker present", () => {
		const out = buildSemanticBlock([hit(MIN_SIMILARITY, "some real content")]);
		expect(out).toContain(SEMANTIC_INJECT_HEADER);
		expect(out).toContain(SEMANTIC_INJECT_MARKER);
		expect(out).toContain("some real content");
		expect(out).toContain("possibly-stale");
	});

	test("caps at MAX_HITS and truncates long text", () => {
		const hits = Array.from({ length: MAX_HITS + 2 }, (_, i) =>
			hit(0.9 - i * 0.01, `hit ${i} ${"x".repeat(500)}`),
		);
		const out = buildSemanticBlock(hits);
		const lines = out.split("\n").filter((l) => l.startsWith("- "));
		expect(lines.length).toBe(MAX_HITS);
		for (const l of lines) {
			const text = l.split(" | ")[1];
			expect(text.length).toBeLessThanOrEqual(HIT_TEXT_MAX);
		}
	});

	test("whitespace collapses in hit text", () => {
		const out = buildSemanticBlock([hit(0.9, "line one\n\nline   two")]);
		expect(out).toContain("line one line two");
	});
});

describe("fetchSemanticHits", () => {
	test("parses results and excludes self-session", async () => {
		const fetchFn = (async () =>
			new Response(
				JSON.stringify({
					results: [hit(0.9, "own session", "pi:HOST:self"), hit(0.8, "other", "pi:HOST:other")],
				}),
				{ status: 200 },
			)) as unknown as typeof fetch;
		const hits = await fetchSemanticHits("query", {
			baseUrl: "http://x",
			selfSession: "pi:HOST:self",
			fetchFn,
		});
		expect(hits.length).toBe(1);
		expect(hits[0].session_key).toBe("pi:HOST:other");
	});

	test("HTTP error throws", async () => {
		const fetchFn = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
		await expect(fetchSemanticHits("q", { baseUrl: "http://x", fetchFn })).rejects.toThrow("500");
	});

	test("missing results key -> empty array", async () => {
		const fetchFn = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
		const hits = await fetchSemanticHits("q", { baseUrl: "http://x", fetchFn });
		expect(hits).toEqual([]);
	});
});

describe("decideInject", () => {
	const goodFetch = (async () =>
		new Response(JSON.stringify({ results: [hit(0.9, "relevant past work")] }), {
			status: 200,
		})) as unknown as typeof fetch;

	test("waits (not done) when no substantive user message", async () => {
		const state = freshSemanticState();
		const out = await decideInject(state, ["hi", "continue"], { fetchFn: goodFetch });
		expect(out).toBeUndefined();
		expect(state.done).toBe(false);
	});

	test("fires once on first substantive message, then never again", async () => {
		const state = freshSemanticState();
		const out = await decideInject(state, ["fix the parse error in crypto.zsh line 445"], {
			fetchFn: goodFetch,
		});
		expect(out).toContain("relevant past work");
		expect(state.done).toBe(true);
		const second = await decideInject(state, ["another substantive message here"], {
			fetchFn: goodFetch,
		});
		expect(second).toBeUndefined();
	});

	test("fetch failure degrades silently and marks done (one-shot)", async () => {
		const state = freshSemanticState();
		const badFetch = (async () => {
			throw new Error("off tailnet");
		}) as unknown as typeof fetch;
		const out = await decideInject(state, ["debug the router DHCP pool exhaustion"], {
			fetchFn: badFetch,
		});
		expect(out).toBeUndefined();
		expect(state.done).toBe(true);
	});

	test("all-below-threshold hits -> no injection but done", async () => {
		const state = freshSemanticState();
		const noiseFetch = (async () =>
			new Response(JSON.stringify({ results: [hit(0.2, "junk")] }), {
				status: 200,
			})) as unknown as typeof fetch;
		const out = await decideInject(state, ["refactor the extension loader tests"], {
			fetchFn: noiseFetch,
		});
		expect(out).toBeUndefined();
		expect(state.done).toBe(true);
	});

	test("anchors on the FIRST substantive message among several", async () => {
		const state = freshSemanticState();
		let queried = "";
		const spyFetch = (async (url: RequestInfo | URL) => {
			queried = String(url);
			return new Response(JSON.stringify({ results: [] }), { status: 200 });
		}) as unknown as typeof fetch;
		await decideInject(state, ["short", "the real task message number one", "later follow up"], {
			fetchFn: spyFetch,
		});
		expect(queried).toContain(encodeURIComponent("the real task message number one").slice(0, 30));
	});
});

describe("noise filtering", () => {
	test("[thinking]/[tool_call]/[tool_result] blobs are dropped", () => {
		const out = buildSemanticBlock([
			hit(0.95, "[thinking]\nI have enough. Let me check"),
			hit(0.9, '[tool_call: write] {"path":'),
			hit(0.85, "real prose about the decision"),
		]);
		expect(out).toContain("real prose");
		expect(out).not.toContain("I have enough");
		expect(out).not.toContain("tool_call");
	});
});
