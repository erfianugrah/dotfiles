/**
 * Unit tests for lib/skill-first-core.ts - the ACTIVE (re-injecting) skill
 * reminder.
 *
 * User directive (2026-08-27): skill nudging "was passive becomes active",
 * modelled on history-first. The contract under test: re-inject at the END of
 * context every turn until a SKILL.md is actually read, cap the fires, and
 * never accumulate duplicate copies.
 *
 * Run: ./.pi/agent/tests/run.sh skill-first
 */

import { describe, expect, test } from "bun:test";
import {
	addHints,
	decideContext,
	freshState,
	isSkillRead,
	isSubstantive,
	matchIntent,
	reminderText,
	SKILL_FIRST_MARKER,
	type SkillFirstState,
} from "../extensions/lib/skill-first-core.ts";

const U = (text: string) => ({ role: "user", content: text });
const A = (text: string) => ({ role: "assistant", content: text });

const TASK = U("please scaffold a new dashboard app for tracking rent comps");

/** State primed with whatever the given prompt matches. */
function primed(prompt: string, maxFires = 3): SkillFirstState {
	const s = freshState(maxFires);
	addHints(s, matchIntent(prompt));
	return s;
}

describe("isSkillRead (the disarm signal)", () => {
	test("reading a SKILL.md disarms", () => {
		expect(isSkillRead("read", { path: "/home/erfi/.pi/agent/skills/fly/SKILL.md" })).toBe(true);
	});
	test("accepts Claude-style tool name and filePath alias", () => {
		expect(isSkillRead("Read", { file_path: "~/.pi/agent/skills/gh/SKILL.md" })).toBe(true);
		expect(isSkillRead("read", { filePath: "skills/docker/SKILL.md" })).toBe(true);
	});
	test("reading other files does not disarm", () => {
		expect(isSkillRead("read", { path: "/etc/hosts" })).toBe(false);
		expect(isSkillRead("read", { path: "README.md" })).toBe(false);
	});
	test("non-read tools never disarm", () => {
		expect(isSkillRead("bash", { command: "cat SKILL.md" })).toBe(false);
		expect(isSkillRead("grep", { pattern: "SKILL.md" })).toBe(false);
	});
	test("missing or non-string path is safe", () => {
		expect(isSkillRead("read", {})).toBe(false);
		expect(isSkillRead("read", { path: 42 })).toBe(false);
		expect(isSkillRead("read", undefined)).toBe(false);
	});
});

describe("matching is delegated (no new false-positive surface)", () => {
	test("a matching prompt yields hints", () => {
		expect(matchIntent("scaffold a new project").length).toBeGreaterThan(0);
	});
	test("ordinary prose matches nothing", () => {
		expect(matchIntent("what is the weather like today")).toEqual([]);
		expect(matchIntent("fix the typo in line 12")).toEqual([]);
	});
	test("addHints dedups by skill name", () => {
		const s = freshState(3);
		addHints(s, matchIntent("scaffold a new app"));
		addHints(s, matchIntent("scaffold a new service"));
		expect(s.pending.length).toBe(1);
	});
});

describe("decideContext", () => {
	test("injects at the END of context (max recency)", () => {
		const s = primed("scaffold a new dashboard app");
		const out = decideContext(s, [U("hi"), TASK]);
		expect(out).toBeDefined();
		const last = out!.messages[out!.messages.length - 1];
		expect(last.role).toBe("user");
		expect((last.content as string).startsWith(SKILL_FIRST_MARKER)).toBe(true);
		expect(s.fires).toBe(1);
	});

	test("RE-injects on the next turn while unsatisfied (this is the 'active' part)", () => {
		const s = primed("scaffold a new dashboard app");
		const first = decideContext(s, [TASK])!;
		const second = decideContext(s, [...first.messages, A("working on it"), U("go on with the plan")]);
		expect(second).toBeDefined();
		expect(s.fires).toBe(2);
		// Exactly one copy survives - the stale one is stripped, not stacked.
		const copies = second!.messages.filter(
			(m) => typeof m.content === "string" && m.content.startsWith(SKILL_FIRST_MARKER),
		);
		expect(copies.length).toBe(1);
		expect(second!.messages[second!.messages.length - 1].content).toBe(copies[0].content);
	});

	test("reading a SKILL.md disarms permanently and strips the stale copy", () => {
		const s = primed("scaffold a new dashboard app");
		const first = decideContext(s, [TASK])!;
		s.consulted = true;
		const after = decideContext(s, first.messages);
		expect(after).toBeDefined();
		expect(
			after!.messages.some(
				(m) => typeof m.content === "string" && m.content.startsWith(SKILL_FIRST_MARKER),
			),
		).toBe(false);
		// And it never comes back.
		expect(decideContext(s, after!.messages)).toBeUndefined();
	});

	test("stops at the fire cap", () => {
		const s = primed("scaffold a new dashboard app", 2);
		expect(decideContext(s, [TASK])).toBeDefined();
		expect(decideContext(s, [TASK])).toBeDefined();
		expect(decideContext(s, [TASK])).toBeUndefined();
		expect(s.fires).toBe(2);
	});

	test("no matched skill -> never injects", () => {
		const s = primed("fix the typo on line 12 of the readme file");
		expect(decideContext(s, [U("fix the typo on line 12 of the readme file")])).toBeUndefined();
	});

	test("does not inject before any user message", () => {
		const s = primed("scaffold a new dashboard app");
		expect(decideContext(s, [A("assistant preamble")])).toBeUndefined();
	});

	test("trivial control replies do not anchor a reminder", () => {
		const s = primed("scaffold a new dashboard app");
		expect(decideContext(s, [U("y")])).toBeUndefined();
		expect(decideContext(s, [U("continue")])).toBeUndefined();
		expect(s.fires).toBe(0);
	});

	test("its own injected message does not count as the substantive turn", () => {
		// Guards against self-perpetuation: the long reminder text must not
		// itself satisfy the substantive-user-message requirement. Expected
		// result is the STRIP (stale copy removed, nothing re-added) and no new
		// fire - not undefined, since there is a stale copy to clean up.
		const s = primed("scaffold a new dashboard app");
		const injected = U(reminderText(s.pending));
		const out = decideContext(s, [U("y"), injected]);
		expect(out).toBeDefined();
		expect(
			out!.messages.some(
				(m) => typeof m.content === "string" && m.content.startsWith(SKILL_FIRST_MARKER),
			),
		).toBe(false);
		expect(s.fires).toBe(0);
	});
});

describe("isSubstantive", () => {
	test("short control replies are not substantive", () => {
		expect(isSubstantive("y")).toBe(false);
		expect(isSubstantive("continue")).toBe(false);
	});
	test("a real task message is", () => {
		expect(isSubstantive("scaffold a new dashboard for rent comps")).toBe(true);
	});
});

describe("reminderText", () => {
	test("names the skill, its path and the read instruction", () => {
		const t = reminderText(matchIntent("scaffold a new app"));
		expect(t).toContain("scaffold-new-project");
		expect(t).toContain("SKILL.md");
		expect(t).toContain(SKILL_FIRST_MARKER);
	});
	test("offers an explicit escape hatch (avoids fighting a correct judgement)", () => {
		expect(reminderText(matchIntent("scaffold a new app"))).toContain("irrelevant");
	});
});
