/**
 * session-ledger END-TO-END: drives the REAL extension hooks + tools through
 * a fake pi runtime, exercising the full lifecycle in one process:
 *   session_start → session_compact (good + degenerate) → session_start
 *   (loads inject rows) → context (inject block) → ledger_search → ledger_sql
 *   (read + rejected write) → session_shutdown (raw capture) → session_start
 *   (lazy-summarise the pending raw row via mocked complete()).
 *
 * Run: ./.pi/agent/tests/run.sh   (runs as a separate bun process from the unit suite)
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";

const AGENT_DIR = "/tmp/pi-ledger-e2e";
const PROJECT = "/tmp/pi-ledger-e2e/proj"; // not a git repo → gitProject falls back to this

// Controllable complete() — returns a real structured summary for lazy-summarise.
let completeReturn = {
	content: [
		{
			type: "text",
			text: "## Goal\nLazily summarised the short session about the markdown parser refactor\n## Key Decisions\n- Kept the streaming tokenizer for memory\n## Next Steps\n1. Wire up the renderer",
		},
	],
};
mock.module("@earendil-works/pi-ai", () => ({
	Type: {
		Object: (x: unknown) => x,
		String: (x: unknown) => x,
		Number: (x: unknown) => x,
		Optional: (x: unknown) => x,
	},
	complete: async () => completeReturn,
}));
mock.module("@earendil-works/pi-coding-agent", () => ({
	defineTool: (x: unknown) => x,
	getAgentDir: () => AGENT_DIR,
}));

// Fake pi runtime
const hooks: Record<string, Array<(e: unknown, c: unknown) => Promise<unknown> | unknown>> = {};
const tools: Record<string, { execute: (id: string, p: unknown) => Promise<{ content: Array<{ text: string }> }> }> = {};
const commands: Record<string, { handler: (a: string, c: unknown) => Promise<void> }> = {};
const pi = {
	registerTool: (t: { name: string }) => {
		tools[t.name] = t as never;
	},
	registerCommand: (name: string, def: never) => {
		commands[name] = def;
	},
	on: (evt: string, fn: never) => {
		(hooks[evt] ||= []).push(fn);
	},
};
async function emit(evt: string, event: unknown, ctx: unknown): Promise<unknown> {
	let last: unknown;
	for (const fn of hooks[evt] ?? []) last = await fn(event, ctx);
	return last;
}

// Fake ctx
let entries: Array<{ type?: string; role?: string; content?: unknown }> = [];
const notifications: string[] = [];
const ctx = {
	cwd: PROJECT,
	model: { id: "test-model", provider: "test" },
	modelRegistry: {
		find: () => ctx.model,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
	},
	sessionManager: {
		getSessionFile: () => "/tmp/sess-e2e.jsonl",
		getEntries: () => entries,
	},
	ui: {
		notify: (m: string) => {
			notifications.push(m);
		},
		confirm: async () => true,
		setStatus: () => {},
	},
};

let mod: { default: (pi: unknown) => void };

beforeAll(async () => {
	try {
		rmSync(AGENT_DIR, { recursive: true });
	} catch {
		/* fresh */
	}
	mod = await import("../../extensions/session-ledger/index.ts");
	mod.default(pi);
});
afterAll(() => {
	try {
		rmSync(AGENT_DIR, { recursive: true });
	} catch {
		/* ignore */
	}
});

const GOOD_SUMMARY =
	"## Goal\nBuild the DNS migration tooling for knot.\n## Key Decisions\n- **Chose Knot over PowerDNS**: anycast fit.\n## Next Steps\n1. Wire AXFR.";
const DEGENERATE_SUMMARY =
	"## Goal\n(No conversation content was provided to summarize.)\n## Key Decisions\n- (none)\n## Next Steps\n1. Provide the actual conversation content.";

describe("session-ledger e2e", () => {
	test("tools + command registered", () => {
		expect(typeof tools.ledger_search?.execute).toBe("function");
		expect(typeof tools.ledger_sql?.execute).toBe("function");
		expect(typeof commands.ledger?.handler).toBe("function");
	});

	test("session_start on empty ledger: no rows, no inject", async () => {
		await emit("session_start", { reason: "new" }, ctx);
		const r = await tools.ledger_sql.execute("1", { sql: "SELECT count(*) c FROM ledger" });
		expect(r.content[0].text).toContain('"c": 0');
	});

	test("session_compact persists a good summary, skips a degenerate one", async () => {
		await emit("session_compact", { compactionEntry: { summary: GOOD_SUMMARY, details: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] }, tokensBefore: 5000 } }, ctx);
		await emit("session_compact", { compactionEntry: { summary: DEGENERATE_SUMMARY, details: {} } }, ctx);
		const r = await tools.ledger_sql.execute("2", { sql: "SELECT count(*) c FROM ledger" });
		expect(r.content[0].text).toContain('"c": 1'); // degenerate filtered
	});

	test("ledger_search finds the captured summary via FTS5", async () => {
		const r = await tools.ledger_search.execute("3", { query: "knot DNS migration", project: PROJECT });
		expect(r.content[0].text).toContain("Knot over PowerDNS");
	});

	test("ledger_sql rejects writes (production guard)", async () => {
		const r = await tools.ledger_sql.execute("4", { sql: "DELETE FROM ledger" });
		expect(r.content[0].text).toContain("Rejected");
	});

	test("next session_start loads inject rows; context hook prepends a cached system block", async () => {
		await emit("session_start", { reason: "new" }, ctx); // captured flag reset; injectRows loaded
		const msgs = [{ role: "user", content: "hi" }];
		const res = (await emit("context", { messages: msgs }, ctx)) as { messages: Array<{ role: string; content: string }> };
		expect(res?.messages?.[0]?.role).toBe("system");
		expect(res.messages[0].content).toContain("# Recent work in this project");
		expect(res.messages[0].content).toContain("re-read named files");
		expect(res.messages[0].content).toContain("Knot over PowerDNS");
	});

	test("context hook is idempotent (no double-inject)", async () => {
		const already = [
			{ role: "system", content: "# Recent work in this project (from past sessions)\n..." },
			{ role: "user", content: "hi" },
		];
		const res = await emit("context", { messages: already }, ctx);
		expect(res).toBeUndefined();
	});

	test("session_shutdown captures a short un-compacted session as pending raw", async () => {
		entries = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i} doing real work on the parser` }));
		await emit("session_shutdown", { reason: "quit" }, ctx);
		const r = await tools.ledger_sql.execute("5", { sql: "SELECT count(*) c FROM ledger WHERE summary_pending = 1" });
		expect(r.content[0].text).toContain('"c": 1');
	});

	test("next session_start lazily summarises the pending raw row via complete()", async () => {
		await emit("session_start", { reason: "new" }, ctx);
		const pending = await tools.ledger_sql.execute("6", { sql: "SELECT count(*) c FROM ledger WHERE summary_pending = 1" });
		expect(pending.content[0].text).toContain('"c": 0'); // cleared
		const found = await tools.ledger_search.execute("7", { query: "markdown parser refactor" });
		expect(found.content[0].text).toContain("Lazily summarised");
	});

	test("lazy-summarise drops a row when the model says SKIP", async () => {
		const c0 = await tools.ledger_sql.execute("8a", { sql: "SELECT count(*) c FROM ledger" });
		entries = Array.from({ length: 8 }, (_, i) => ({ role: "user", content: `trivial ${i}` }));
		await emit("session_shutdown", { reason: "quit" }, ctx); // +1 pending row
		completeReturn = { content: [{ type: "text", text: "SKIP" }] };
		await emit("session_start", { reason: "new" }, ctx); // SKIP → row deleted
		const after = await tools.ledger_sql.execute("9", { sql: "SELECT count(*) c FROM ledger" });
		const pending = await tools.ledger_sql.execute("9b", { sql: "SELECT count(*) c FROM ledger WHERE summary_pending = 1" });
		expect(after.content[0].text).toBe(c0.content[0].text); // net zero: SKIP row gone
		expect(pending.content[0].text).toContain('"c": 0');
	});

	test("/ledger status reports counts", async () => {
		await commands.ledger.handler("status", ctx);
		expect(notifications.some((n) => n.includes("ledger:"))).toBe(true);
	});

	test("/ledger off disables injection", async () => {
		await commands.ledger.handler("off", ctx);
		const res = await emit("context", { messages: [{ role: "user", content: "hi" }] }, ctx);
		expect(res).toBeUndefined();
	});
});
