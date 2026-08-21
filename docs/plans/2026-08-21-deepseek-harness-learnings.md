# DeepSeek Harness Learnings: Spill + Loop-Breaker for pi - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or implement this plan task-by-task in-session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the two highest value/effort ideas verified in the deepseek-harness review - a tool-output spill policy and an advisory repeat-tool loop-breaker - to pi as dotfiles extensions, following the established pure-core-in-`lib/` + thin-adapter pattern.

**Architecture:** Two new pi extensions, each split into a pure, unit-testable core under `.pi/agent/extensions/lib/` and a thin pi adapter at `.pi/agent/extensions/<name>.ts`. Spill hooks `tool_result` (pi natively supports content replacement there) and swaps oversized plain-text results for a bounded head/tail preview + locator, full text persisted under `~/.pi/agent/spill/`. The loop-breaker hooks `tool_call` (count) and `tool_result` (deliver), tracking consecutive identical-args calls per chain and appending an escalating advisory at thresholds 3/5/8.

**Tech Stack:** TypeScript, pi ExtensionAPI, bun test (unit suite via `tests/preload.ts` SDK stub).

---

## Verified review findings (why this scope and no more)

Re-verified against pi 0.84.2 docs (`/opt/pi-coding-agent/docs/`) and dotfiles source on 2026-08-21:

- **Spill: build it.** Built-in `bash`/`read` self-cap (50KB / 2000 lines; bash already spills overflow to a temp file). The unbounded fresh-output surface is the extension-tool fleet: `webfetch` (5MB cap), `codesearch` / `context7_query_docs` (up to 50k tokens), `task` subagent results, `sg_dossier`, `video_doc`. `tool-output-prune` only reclaims OLD output at the `context` event; nothing bounds a fresh oversized result entering context right now.
- **Loop-breaker: build it.** tool-guard's `checkReformulationLoop` covers only search-tools-without-drill-in. The generic identical-args chain catches everything else (hammering a denied call, repeated failed `edit`s, repeated `bg_status` polls are excluded by default).
- **Deny-only guard registry: do NOT build.** pi is already fail-safe: `tool_call` handler errors block the tool (extensions.md "Error Handling"), blocking is a first-class return value, and "ask" exists via `ctx.ui.confirm` in a `tool_call` handler. Task 1 empirically confirms any-block-wins ordering; if it holds, nothing else is needed.
- **Balanced-cut validation: do NOT build.** pi compaction already never cuts at tool results (compaction.md: "Never cut at tool results (they must stay with their tool call)").
- **Upstream wishlist (no code in this plan):** per-tool `timeoutMs` + AbortSignal threading; `request/header` snapshots in the session log; documented monotonic block-combination semantics. Candidate feature requests for pi upstream, not extensions.

Reference sources (dsh): `packages/spill/spill-policy/README.md`, `packages/guard/repeat-tool-reminder/README.md` in `/home/erfi/deepseek-harness`.

---

### Task 1: Empirical probe of pi tool_call/tool_result semantics

Two semantics determine the loop-breaker's delivery arm. Probe both with a throwaway extension; record results in the plan's "Probe results" section at the bottom before proceeding.

**Files:**
- Create: `/tmp/pi-probe/probe.ts` (temporary extension, deleted after)

- [ ] **Step 1: Write the probe extension**

```typescript
// /tmp/pi-probe/probe.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

const LOG = "/tmp/pi-probe/events.log";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		appendFileSync(LOG, `tool_call ${event.toolName} id=${event.toolCallId}\n`);
		// Probe B: block every bash call to see if a blocked call still emits tool_result.
		if (event.toolName === "bash") {
			return { block: true, reason: "probe block" };
		}
	});
	pi.on("tool_result", async (event) => {
		appendFileSync(LOG, `tool_result ${event.toolName} id=${event.toolCallId} isError=${event.isError}\n`);
	});
}
```

- [ ] **Step 2: Run the probe**

```bash
mkdir -p /tmp/pi-probe
cp /tmp/pi-probe/probe.ts ~/.pi/agent/extensions/zz-probe.ts
cd /tmp && pi -p "run: bash echo hello" 2>&1 | tail -5
rm ~/.pi/agent/extensions/zz-probe.ts
cat /tmp/pi-probe/events.log
```

Expected: log shows `tool_call bash` followed by `tool_result bash isError=true` if blocked calls emit results. Also confirms the block decision from one handler is final (no later handler ran to un-block - tool-guard's own blocks already demonstrate any-block-wins in production, this just confirms the blocked-result event shape).

- [ ] **Step 3: Record the result**

Append to "Probe results" at the bottom of this file: does a blocked `tool_call` emit `tool_result`? If YES, the loop-breaker delivers reminders purely via `tool_result` content-append. If NO, the adapter must also flush pending reminders on the next non-matching `tool_result` (the plan's adapter code below already implements this flush - it is correct under both outcomes).

---

### Task 2: tool-output-spill pure core

**Files:**
- Create: `.pi/agent/extensions/lib/tool-output-spill-core.ts`
- Test: `.pi/agent/tests/tool-output-spill.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// .pi/agent/tests/tool-output-spill.test.ts
import { describe, expect, test } from "bun:test";
import {
	buildReplacement,
	byteLen,
	flattenText,
	isPlainTextContent,
	sliceBytes,
	sliceBytesTail,
} from "../extensions/lib/tool-output-spill-core.ts";

describe("isPlainTextContent", () => {
	test("accepts all-text arrays", () => {
		expect(isPlainTextContent([{ type: "text", text: "a" }])).toBe(true);
	});
	test("rejects mixed content", () => {
		expect(
			isPlainTextContent([{ type: "text", text: "a" }, { type: "image", data: "x" }]),
		).toBe(false);
	});
	test("rejects strings and empty arrays", () => {
		expect(isPlainTextContent("hello")).toBe(false);
		expect(isPlainTextContent([])).toBe(false);
	});
});

describe("sliceBytes", () => {
	test("returns short strings unchanged", () => {
		expect(sliceBytes("abc", 10)).toBe("abc");
	});
	test("never splits a multibyte code point", () => {
		const s = "ab\u{1F600}cd"; // emoji = 4 bytes, starts at byte 2
		const out = sliceBytes(s, 4); // cuts 2 bytes into the emoji
		expect(out).toBe("ab");
		expect(byteLen(out)).toBeLessThanOrEqual(4);
	});
});

describe("sliceBytesTail", () => {
	test("takes the tail without splitting a code point", () => {
		const s = "ab\u{1F600}cd";
		const out = sliceBytesTail(s, 4); // window starts 2 bytes into the emoji
		expect(out).toBe("cd");
	});
});

describe("buildReplacement", () => {
	const LOCATOR = "/home/erfi/.pi/agent/spill/sess/call-1-webfetch.txt";
	const HINT = "Use read with offset/limit, or grep this path to search within it.";

	test("replacement stays within the byte cap", () => {
		const full = "x".repeat(100_000);
		const r = buildReplacement(full, 50_000, LOCATOR, HINT);
		expect(r).not.toBeNull();
		expect(byteLen(r!.text)).toBeLessThanOrEqual(50_000);
		expect(r!.omittedBytes).toBe(100_000);
		expect(r!.text).toContain(`(Omitted 100000 bytes. Full result stored at: ${LOCATOR}.`);
		expect(r!.text).toContain("[... middle omitted ...]");
	});

	test("preserves head and tail content", () => {
		const full = "HEAD-".repeat(100) + "middle".repeat(10_000) + "-TAIL".repeat(100);
		const r = buildReplacement(full, 10_000, LOCATOR, HINT)!;
		expect(r!.text.startsWith("HEAD-")).toBe(true);
		expect(r!.text).toContain("TAIL");
	});

	test("returns null when the notice alone cannot fit", () => {
		const r = buildReplacement("x".repeat(1000), 10, LOCATOR, HINT);
		expect(r).toBeNull();
	});

	test("replacement is always smaller than the original", () => {
		const full = "y".repeat(60_000);
		const r = buildReplacement(full, 50_000, LOCATOR, HINT)!;
		expect(byteLen(r!.text)).toBeLessThan(byteLen(full));
	});
});

describe("flattenText", () => {
	test("joins text parts with newlines", () => {
		expect(
			flattenText([
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			]),
		).toBe("a\nb");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/dotfiles && bun test --preload .pi/agent/tests/preload.ts .pi/agent/tests/tool-output-spill.test.ts`
Expected: FAIL - module `../extensions/lib/tool-output-spill-core.ts` does not exist.

- [ ] **Step 3: Write the core**

```typescript
// .pi/agent/extensions/lib/tool-output-spill-core.ts
/**
 * tool-output-spill core - pure decision + rendering logic.
 *
 * Port of deepseek-harness packages/spill/spill-policy: when a plain-text
 * tool result exceeds the inline byte budget, persist the full text and
 * replace the model-facing content with a bounded head/tail preview plus a
 * locator notice. The notice's byte cost is reserved out of the budget, so
 * the replacement NEVER exceeds the cap; when the notice alone cannot fit
 * the function returns null and the caller leaves the original inline.
 */

export interface TextPart {
	type: "text";
	text: string;
}

export function isPlainTextContent(content: unknown): content is TextPart[] {
	if (!Array.isArray(content) || content.length === 0) return false;
	return content.every(
		(p) =>
			typeof p === "object" &&
			p !== null &&
			(p as { type?: unknown }).type === "text" &&
			typeof (p as { text?: unknown }).text === "string",
	);
}

export function flattenText(parts: TextPart[]): string {
	return parts.map((p) => p.text).join("\n");
}

export function byteLen(s: string): number {
	return Buffer.byteLength(s, "utf-8");
}

/** Truncate to at most n UTF-8 bytes without splitting a code point. */
export function sliceBytes(s: string, n: number): string {
	const bytes = new TextEncoder().encode(s);
	if (bytes.byteLength <= n) return s;
	let out = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, n));
	while (out.endsWith("")) out = out.slice(0, -1);
	return out;
}

/** Take the last n UTF-8 bytes without splitting a code point. */
export function sliceBytesTail(s: string, n: number): string {
	const bytes = new TextEncoder().encode(s);
	if (bytes.byteLength <= n) return s;
	let out = new TextDecoder("utf-8", { fatal: false }).decode(
		bytes.subarray(bytes.byteLength - n),
	);
	while (out.startsWith("")) out = out.slice(1);
	return out;
}

export interface Replacement {
	/** Full model-facing replacement; guaranteed <= maxBytes. */
	text: string;
	omittedBytes: number;
}

const SEP = "\n\n";
const MIDDLE_MARKER = "\n\n[... middle omitted ...]\n\n";

export function buildReplacement(
	fullText: string,
	maxBytes: number,
	locator: string,
	hint: string,
): Replacement | null {
	const omittedBytes = byteLen(fullText);
	const notice = `(Omitted ${omittedBytes} bytes. Full result stored at: ${locator}. ${hint})`;
	const budget = maxBytes - byteLen(notice) - byteLen(SEP);
	if (budget <= 0) return null; // notice alone exceeds the cap: leave original inline

	const previewBudget = budget - byteLen(MIDDLE_MARKER);
	if (previewBudget < 2) {
		// Tiny budget: head-only preview, no marker.
		const head = sliceBytes(fullText, budget);
		return { text: head + SEP + notice, omittedBytes };
	}

	const headBudget = Math.floor(previewBudget * 0.7);
	const tailBudget = previewBudget - headBudget;
	const head = sliceBytes(fullText, headBudget);
	const tail = sliceBytesTail(fullText, tailBudget);
	return { text: head + MIDDLE_MARKER + tail + SEP + notice, omittedBytes };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/dotfiles && bun test --preload .pi/agent/tests/preload.ts .pi/agent/tests/tool-output-spill.test.ts`
Expected: PASS (all suites green).

- [ ] **Step 5: Commit**

```bash
cd ~/dotfiles
git add .pi/agent/extensions/lib/tool-output-spill-core.ts .pi/agent/tests/tool-output-spill.test.ts
git commit -m "feat(pi-extensions): tool-output-spill pure core (port of dsh spill-policy)"
```

---

### Task 3: tool-output-spill pi adapter

**Files:**
- Create: `.pi/agent/extensions/tool-output-spill.ts`
- Modify: `.pi/agent/tests/run.sh` (add the new test file to the unit-suite line)

- [ ] **Step 1: Write the adapter**

```typescript
// .pi/agent/extensions/tool-output-spill.ts
/**
 * tool-output-spill - keep oversized plain-text tool results out of context.
 *
 * Port of deepseek-harness packages/spill/spill-policy to pi's tool_result
 * event (which natively supports content replacement). Complements
 * tool-output-prune: prune reclaims OLD results at the context event; spill
 * bounds a FRESH oversized result the moment it lands.
 *
 * Primary targets are the extension tools without provider-side caps:
 * webfetch (5MB), codesearch / context7_query_docs (50k tokens), task,
 * sg_dossier, video_doc. Built-in bash/read self-cap at 50KB/2000 lines,
 * so they rarely trigger this.
 *
 * Semantics (matching dsh):
 *   - Only all-text results are spillable (mixed/image content untouched).
 *   - `read` is skipped: spilling a read result forces a read-again loop.
 *   - Best-effort: any persistence failure leaves the original inline; a
 *     spill failure never turns a success into an error.
 *   - The replacement (preview + notice) never exceeds the byte cap.
 *
 * Env:
 *   PI_SPILL_MAX_BYTES  default 51200 (matches built-in tool caps)
 *   PI_SPILL_DIR        default ~/.pi/agent/spill
 *   PI_SPILL_OFF=1      disable
 *   PI_SPILL_VERBOSE=1  notify on each spill
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	buildReplacement,
	byteLen,
	flattenText,
	isPlainTextContent,
} from "./lib/tool-output-spill-core.ts";

const MAX_BYTES = Math.max(
	1024,
	Number(process.env.PI_SPILL_MAX_BYTES ?? "51200"),
);
const SPILL_DIR =
	process.env.PI_SPILL_DIR ?? join(homedir(), ".pi", "agent", "spill");
const OFF = process.env.PI_SPILL_OFF === "1";
const VERBOSE = process.env.PI_SPILL_VERBOSE === "1";

// `read` spilling would force a read -> spill -> read-again loop.
const SKIP_TOOLS = new Set(["read"]);

const HINT =
	"Use read with offset/limit, or grep this path to search within it.";

function safe(s: string): string {
	return s.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
}

export default function (pi: ExtensionAPI) {
	if (OFF) return;

	pi.on("tool_result", async (event, ctx) => {
		if (SKIP_TOOLS.has(event.toolName)) return;
		if (!isPlainTextContent(event.content)) return;

		const full = flattenText(event.content);
		if (byteLen(full) <= MAX_BYTES) return;

		let sessionId = "ephemeral";
		try {
			sessionId = ctx.sessionManager.getSessionId() ?? "ephemeral";
		} catch {
			// headless / early-boot: keep the fallback
		}
		const dir = join(SPILL_DIR, safe(sessionId));
		const file = join(
			dir,
			`${safe(event.toolCallId)}-${safe(event.toolName)}.txt`,
		);

		try {
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, full);
		} catch {
			return; // best-effort: never hide the inline result
		}

		const repl = buildReplacement(full, MAX_BYTES, file, HINT);
		if (!repl) return; // notice cannot fit: leave original inline

		if (VERBOSE) {
			ctx.ui.notify(
				`tool-output-spill: ${event.toolName} (${repl.omittedBytes}B) -> ${file}`,
				"info",
			);
		}
		return { content: [{ type: "text", text: repl.text }] };
	});
}
```

- [ ] **Step 2: Wire the unit test into run.sh**

Edit `.pi/agent/tests/run.sh`, add `"$HERE/tool-output-spill.test.ts"` to the unit-suite `bun test` line (alongside the other single-purpose suites, before `"$@"`).

- [ ] **Step 3: Run the full suite**

Run: `cd ~/dotfiles && ./.pi/agent/tests/run.sh tool-output-spill`
Expected: unit suite PASS including the new file; integration + manifest suites PASS. The manifest test asserts the pi-package manifest ships every resource - if it fails on the new top-level extension, add the file to the `pi` manifest globs in the root `package.json`.

- [ ] **Step 4: Live smoke test**

```bash
PI_SPILL_VERBOSE=1 PI_SPILL_MAX_BYTES=2048 pi -p "webfetch https://example.com and quote the first paragraph" 2>&1 | tail -10
ls ~/.pi/agent/spill/
```

Expected: a spill notification and a file under `~/.pi/agent/spill/<session>/` containing the full fetch; the model-visible result carries the `(Omitted N bytes ...)` notice. If example.com is too small to trip 2048 bytes, use a larger page.

- [ ] **Step 5: Commit**

```bash
cd ~/dotfiles
git add .pi/agent/extensions/tool-output-spill.ts .pi/agent/tests/run.sh
git commit -m "feat(pi-extensions): tool-output-spill adapter on tool_result"
```

---

### Task 4: repeat-tool-guard pure core

**Files:**
- Create: `.pi/agent/extensions/lib/repeat-tool-core.ts`
- Test: `.pi/agent/tests/repeat-tool-guard.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// .pi/agent/tests/repeat-tool-guard.test.ts
import { describe, expect, test } from "bun:test";
import {
	canonicalize,
	parseThresholds,
	reminderFor,
	track,
	type Chain,
	type ChainConfig,
} from "../extensions/lib/repeat-tool-core.ts";

const CFG: ChainConfig = {
	thresholds: [3, 5, 8],
	exclude: new Set(["todowrite"]),
	argumentsPreviewChars: 50,
};

function freshChain(): Chain {
	return { lastKey: null, count: 0 };
}

describe("canonicalize", () => {
	test("key order does not matter", () => {
		expect(canonicalize({ a: 1, b: { c: 2, d: 3 } })).toBe(
			canonicalize({ b: { d: 3, c: 2 }, a: 1 }),
		);
	});
	test("distinguishes different values", () => {
		expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 2 }));
	});
});

describe("track", () => {
	test("consecutive identical calls increment", () => {
		const c = freshChain();
		expect(track(c, "grep", { pattern: "x" }, CFG)).toBe(1);
		expect(track(c, "grep", { pattern: "x" }, CFG)).toBe(2);
		expect(track(c, "grep", { pattern: "x" }, CFG)).toBe(3);
	});
	test("a different call resets to 1", () => {
		const c = freshChain();
		track(c, "grep", { pattern: "x" }, CFG);
		track(c, "grep", { pattern: "x" }, CFG);
		expect(track(c, "grep", { pattern: "y" }, CFG)).toBe(1);
	});
	test("same args on a different tool is a different chain key", () => {
		const c = freshChain();
		track(c, "grep", { pattern: "x" }, CFG);
		expect(track(c, "rg", { pattern: "x" }, CFG)).toBe(1);
	});
	test("excluded tools are transparent - no increment, no reset", () => {
		const c = freshChain();
		track(c, "grep", { pattern: "x" }, CFG);
		track(c, "grep", { pattern: "x" }, CFG);
		expect(track(c, "todowrite", { todos: [] }, CFG)).toBe("transparent");
		expect(track(c, "grep", { pattern: "x" }, CFG)).toBe(3);
	});
});

describe("reminderFor", () => {
	test("null below and between thresholds", () => {
		expect(reminderFor("grep", { pattern: "x" }, 2, CFG)).toBeNull();
		expect(reminderFor("grep", { pattern: "x" }, 4, CFG)).toBeNull();
	});
	test("first threshold is the short nudge", () => {
		const r = reminderFor("grep", { pattern: "x" }, 3, CFG)!;
		expect(r).toContain("repeating the exact same tool call");
		expect(r).not.toContain("consecutive_calls");
	});
	test("later thresholds are detailed and name the tool and count", () => {
		const r = reminderFor("grep", { pattern: "x" }, 5, CFG)!;
		expect(r).toContain("tool: grep");
		expect(r).toContain("consecutive_calls: 5");
		expect(r).toContain("arguments:");
	});
	test("argument preview is capped with an omitted-count marker", () => {
		const long = { pattern: "z".repeat(500) };
		const r = reminderFor("grep", long, 5, CFG)!;
		expect(r).toContain("(+");
		expect(r).toContain("more chars)");
		expect(r!.length).toBeLessThan(600);
	});
});

describe("parseThresholds", () => {
	test("parses and sorts", () => {
		expect(parseThresholds("8,3,5")).toEqual([3, 5, 8]);
	});
	test("rejects duplicates, values < 2, and non-integers", () => {
		expect(() => parseThresholds("3,3")).toThrow();
		expect(() => parseThresholds("1,3")).toThrow();
		expect(() => parseThresholds("3,abc")).toThrow();
		expect(() => parseThresholds("")).toThrow();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/dotfiles && bun test --preload .pi/agent/tests/preload.ts .pi/agent/tests/repeat-tool-guard.test.ts`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Write the core**

```typescript
// .pi/agent/extensions/lib/repeat-tool-core.ts
/**
 * repeat-tool-guard core - pure chain + reminder logic.
 *
 * Port of deepseek-harness packages/guard/repeat-tool-reminder. Chain key is
 * (tool name, canonical arguments); canonicalization is a deep key-sort plus
 * JSON.stringify, so property-order differences count as identical.
 * Excluded tools are TRANSPARENT to the chain (neither increment nor reset)
 * so interleaved bookkeeping cannot launder a loop.
 */

export interface ChainConfig {
	/** Ascending consecutive-call counts that trigger a reminder. */
	thresholds: number[];
	/** Tool names transparent to the chain. */
	exclude: Set<string>;
	/** Cap on the arguments quoted in the detailed reminder. */
	argumentsPreviewChars: number;
}

export interface Chain {
	lastKey: string | null;
	count: number;
}

function sortKeys(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (v !== null && typeof v === "object") {
		return Object.fromEntries(
			Object.entries(v as Record<string, unknown>)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([k, val]) => [k, sortKeys(val)]),
		);
	}
	return v;
}

export function canonicalize(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

/**
 * Record one call. Returns "transparent" for excluded tools (chain
 * untouched), otherwise the new consecutive count.
 */
export function track(
	chain: Chain,
	toolName: string,
	args: unknown,
	cfg: ChainConfig,
): number | "transparent" {
	if (cfg.exclude.has(toolName)) return "transparent";
	const key = `${toolName} ${canonicalize(args)}`;
	if (key === chain.lastKey) {
		chain.count += 1;
	} else {
		chain.lastKey = key;
		chain.count = 1;
	}
	return chain.count;
}

const SHORT_NUDGE =
	"You are repeating the exact same tool call with identical arguments. " +
	"Carefully analyze the previous result before calling again: if the " +
	"task is not complete, try a different approach or different arguments " +
	"instead of repeating the call.";

/** Reminder text for a threshold hit, or null. Fires only at exact counts. */
export function reminderFor(
	toolName: string,
	args: unknown,
	count: number,
	cfg: ChainConfig,
): string | null {
	if (!cfg.thresholds.includes(count)) return null;
	if (count === cfg.thresholds[0]) return SHORT_NUDGE;

	const canonical = canonicalize(args);
	let preview = canonical;
	if (canonical.length > cfg.argumentsPreviewChars) {
		preview =
			canonical.slice(0, cfg.argumentsPreviewChars) +
			` (+${canonical.length - cfg.argumentsPreviewChars} more chars)`;
	}
	return (
		"Repeated tool call detected:\n" +
		`- tool: ${toolName}\n` +
		`- consecutive_calls: ${count}\n` +
		`- arguments: ${preview}\n` +
		"The repeated calls are not making progress. Do not call this tool " +
		"with these exact arguments again. Inspect the latest result and " +
		"choose a different action, different arguments, or finish the task " +
		"if enough evidence has been gathered."
	);
}

/** Parse "3,5,8" into ascending validated thresholds. Throws on bad input. */
export function parseThresholds(raw: string): number[] {
	const parts = raw.split(",").map((s) => s.trim());
	if (parts.length === 0 || parts.some((p) => p === "")) {
		throw new Error("thresholds: empty list");
	}
	const nums = parts.map((p) => {
		const n = Number(p);
		if (!Number.isInteger(n) || n < 2) {
			throw new Error(`thresholds: bad value ${p}`);
		}
		return n;
	});
	if (new Set(nums).size !== nums.length) {
		throw new Error("thresholds: duplicates");
	}
	return nums.sort((a, b) => a - b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/dotfiles && bun test --preload .pi/agent/tests/preload.ts .pi/agent/tests/repeat-tool-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/dotfiles
git add .pi/agent/extensions/lib/repeat-tool-core.ts .pi/agent/tests/repeat-tool-guard.test.ts
git commit -m "feat(pi-extensions): repeat-tool-guard pure core (port of dsh repeat-tool-reminder)"
```

---

### Task 5: repeat-tool-guard pi adapter

**Files:**
- Create: `.pi/agent/extensions/repeat-tool-guard.ts`
- Modify: `.pi/agent/tests/run.sh` (add repeat-tool-guard.test.ts to the unit line)

- [ ] **Step 1: Write the adapter**

```typescript
// .pi/agent/extensions/repeat-tool-guard.ts
/**
 * repeat-tool-guard - advisory loop-breaker for consecutive identical
 * tool calls. Port of deepseek-harness packages/guard/repeat-tool-reminder.
 *
 * Never blocks, never rewrites a call: at thresholds (default 3/5/8) it
 * appends an escalating advisory text part to the tool result. The decision
 * - retry differently, gather more evidence, or finish - stays with the
 * model. Complements tool-guard's checkReformulationLoop (which only covers
 * search-tools-without-drill-in) and degenerate-stream-guard (which covers
 * provider-side output collapse, not tool-call loops).
 *
 * Semantics (matching dsh):
 *   - Chain key = (tool name, deep-key-sorted canonical arguments).
 *   - Excluded tools are transparent: they neither increment nor reset the
 *     chain, so interleaved bookkeeping cannot launder a loop.
 *   - Counting happens on tool_call, so calls blocked by other guards
 *     still count (a model hammering a denied call is the loop worth
 *     breaking).
 *   - Delivery happens on tool_result via content-append; pending
 *     reminders flush on the next result even if the exact toolCallId
 *     never produces one (covers the blocked-call case regardless of the
 *     Task 1 probe outcome).
 *   - A user message resets the chain.
 *
 * Env:
 *   PI_REPEAT_GUARD_OFF=1          disable
 *   PI_REPEAT_THRESHOLDS="3,5,8"   consecutive counts that fire
 *   PI_REPEAT_EXCLUDE="a,b"        override the default transparent set
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	parseThresholds,
	reminderFor,
	track,
	type Chain,
	type ChainConfig,
} from "./lib/repeat-tool-core.ts";

const OFF = process.env.PI_REPEAT_GUARD_OFF === "1";

const DEFAULT_EXCLUDE = [
	"todowrite",
	"question",
	"wait_job",
	"research_wait_job",
	"bg_wait",
	"bg_status",
	"bg_list",
];

const MARKER = "[repeat-tool-guard] ";

function loadConfig(): ChainConfig {
	return {
		thresholds: parseThresholds(process.env.PI_REPEAT_THRESHOLDS ?? "3,5,8"),
		exclude: new Set(
			process.env.PI_REPEAT_EXCLUDE
				? process.env.PI_REPEAT_EXCLUDE.split(",").map((s) => s.trim())
				: DEFAULT_EXCLUDE,
		),
		argumentsPreviewChars: 500,
	};
}

export default function (pi: ExtensionAPI) {
	if (OFF) return;
	const cfg = loadConfig();
	const chain: Chain = { lastKey: null, count: 0 };
	const pending = new Map<string, string>(); // toolCallId -> reminder

	pi.on("tool_call", async (event) => {
		const count = track(chain, event.toolName, event.input, cfg);
		if (count === "transparent") return;
		const reminder = reminderFor(event.toolName, event.input, count, cfg);
		if (reminder) pending.set(event.toolCallId, reminder);
	});

	pi.on("tool_result", async (event) => {
		if (pending.size === 0) return;
		const notes: string[] = [];
		const exact = pending.get(event.toolCallId);
		if (exact) {
			notes.push(exact);
			pending.delete(event.toolCallId);
		}
		// Flush reminders whose call never produced a matching result
		// (e.g. blocked calls, if the probe shows they skip tool_result).
		for (const [, r] of pending) notes.push(r);
		pending.clear();
		if (notes.length === 0) return;

		const extra = notes.map((n) => ({ type: "text" as const, text: MARKER + n }));
		const content = event.content;
		if (Array.isArray(content)) {
			return { content: [...content, ...extra] };
		}
		return {
			content: [
				{ type: "text" as const, text: String(content ?? "") },
				...extra,
			],
		};
	});

	pi.on("message_start", async (event) => {
		if (event.message.role === "user") {
			chain.lastKey = null;
			chain.count = 0;
			pending.clear();
		}
	});
}
```

- [ ] **Step 2: Wire the test into run.sh**

Edit `.pi/agent/tests/run.sh`, add `"$HERE/repeat-tool-guard.test.ts"` to the unit-suite `bun test` line.

- [ ] **Step 3: Run the full suite**

Run: `cd ~/dotfiles && ./.pi/agent/tests/run.sh`
Expected: all suites PASS.

- [ ] **Step 4: Live smoke test**

```bash
PI_REPEAT_THRESHOLDS=2 pi -p "call the glob tool with pattern '*.md' in the current directory, three times in a row, to check for readme files" 2>&1 | tail -15
```

Expected: after the 2nd identical glob, the tool result carries a `[repeat-tool-guard]` advisory part; the agent changes approach instead of a 3rd identical call. (If the agent refuses to repeat on instruction, this still validates the reminder fires - the reminder text must appear in the transcript.)

- [ ] **Step 5: Commit**

```bash
cd ~/dotfiles
git add .pi/agent/extensions/repeat-tool-guard.ts .pi/agent/tests/run.sh
git commit -m "feat(pi-extensions): repeat-tool-guard advisory loop-breaker"
```

---

### Task 6: Stow, docs, final verification

**Files:**
- Modify: `AGENTS.md` (extension list rows)

- [ ] **Step 1: Stow to live tree**

```bash
cd ~ && stow -d ~/dotfiles -t ~ -v . 2>&1 | tail -5
ls -la ~/.pi/agent/extensions/tool-output-spill.ts ~/.pi/agent/extensions/repeat-tool-guard.ts
```

Expected: both live paths resolve into `~/dotfiles`. New files inside already-symlinked dirs need no stow, but run it to be safe.

- [ ] **Step 2: Document in AGENTS.md**

Add two rows to the extensions documentation in `~/dotfiles/AGENTS.md`: name, one-line purpose, env kill switches (`PI_SPILL_OFF`, `PI_REPEAT_GUARD_OFF`).

- [ ] **Step 3: Full verification**

```bash
cd ~/dotfiles && ./.pi/agent/tests/run.sh && stow-drift
```

Expected: all test suites PASS, `0 drifted`.

- [ ] **Step 4: Commit**

```bash
cd ~/dotfiles
git add AGENTS.md docs/plans/2026-08-21-deepseek-harness-learnings.md
git commit -m "docs(pi-extensions): spill + repeat-tool-guard entries; deepseek-harness learnings plan"
```

---

## Self-review notes

- **Spec coverage:** spill (Tasks 2-3), loop-breaker (Tasks 4-5), deny-monotonicity probe (Task 1), docs/stow (Task 6). Deliberately excluded with reasons: deny-registry (pi already fail-safe), balanced-cut validation (already in pi core), upstream core changes (wishlist, not extensions).
- **Type consistency:** `Chain`, `ChainConfig`, `track`, `reminderFor`, `parseThresholds`, `canonicalize` used identically across Tasks 4-5; `buildReplacement`, `sliceBytes`, `sliceBytesTail`, `isPlainTextContent`, `flattenText`, `byteLen` across Tasks 2-3.
- **Known soft spot:** the adapter's `pending` flush delivers reminders on the next result if the exact call never produces one - correct under both Task 1 probe outcomes. Per-session state is module-level; `pi -p` subagents are separate processes, so no cross-agent keying is needed (unlike dsh's WeakMap<Agent>).

## Probe results

(probed 2026-08-21, pi 0.84.2, throwaway extension blocking all `bash` calls)

- Blocked `tool_call` emits `tool_result`: **NO.** Two `tool_call bash` events (the model retried after the block), zero `tool_result` events. The loop-breaker adapter's flush-pending-on-next-result arm is REQUIRED - reminder delivery keyed only on exact toolCallId would strand reminders for blocked calls.
- Any-block-wins across handlers: **YES (empirically).** The probe's `{block: true}` stood even with the full production extension set loaded (tool-guard, dangerous-cmd-guard, etc. all ran and none could un-block). Fail-safe is also documented: a throwing `tool_call` handler blocks the tool (extensions.md Error Handling).
