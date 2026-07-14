import { describe, expect, test } from "bun:test";
import { type Step, parseArgs } from "./browser-assert.ts";

describe("browser-assert parseArgs", () => {
	test("requires a url first", () => {
		expect(() => parseArgs([])).toThrow("usage");
		expect(() => parseArgs(["--wait", "#x"])).toThrow("usage");
	});

	test("defaults", () => {
		const a = parseArgs(["http://x"]);
		expect(a.url).toBe("http://x");
		expect(a.steps).toEqual([]);
		expect(a.timeout).toBe(15000);
		expect(a.viewport).toEqual({ width: 1280, height: 800 });
		expect(a.fullPage).toBe(false);
	});

	test("preserves step ORDER across kinds (scripts a flow)", () => {
		const a = parseArgs([
			"http://x",
			"--click", "#login",
			"--type", "#email", "me@x.com",
			"--press", "Enter",
			"--wait", "#dash",
			"--assert", "document.title.length>0",
			"--screenshot", "/tmp/a.png",
		]);
		expect(a.steps).toEqual([
			{ kind: "click", selector: "#login" },
			{ kind: "type", selector: "#email", text: "me@x.com" },
			{ kind: "press", key: "Enter" },
			{ kind: "wait", selector: "#dash" },
			{ kind: "assert", expr: "document.title.length>0" },
			{ kind: "screenshot", path: "/tmp/a.png" },
		] satisfies Step[]);
	});

	test("--type consumes exactly two args (selector, text)", () => {
		const a = parseArgs(["http://x", "--type", "#i", "hello world"]);
		expect(a.steps[0]).toEqual({ kind: "type", selector: "#i", text: "hello world" });
	});

	test("--viewport parses WxH; --full-page + --timeout", () => {
		const a = parseArgs(["http://x", "--viewport", "1440x900", "--full-page", "--timeout", "5000"]);
		expect(a.viewport).toEqual({ width: 1440, height: 900 });
		expect(a.fullPage).toBe(true);
		expect(a.timeout).toBe(5000);
	});

	test("rejects bad viewport, missing arg, unknown flag", () => {
		expect(() => parseArgs(["http://x", "--viewport", "nope"])).toThrow("WxH");
		expect(() => parseArgs(["http://x", "--assert"])).toThrow("needs an argument");
		expect(() => parseArgs(["http://x", "--frobnicate"])).toThrow("unknown flag");
	});
});
