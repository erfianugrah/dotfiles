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
