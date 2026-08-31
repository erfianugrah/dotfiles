// .pi/agent/tests/config-snapshot.test.ts
import { describe, expect, test } from "bun:test";
import {
	buildManifest,
	diffManifests,
	fnv1aHex,
	renderDriftNotice,
	type FileSystemLike,
} from "../extensions/lib/config-snapshot-core.ts";

const enc = new TextEncoder();

function fakeFs(files: Record<string, string>): FileSystemLike {
	return {
		listFiles: (dir: string) =>
			Object.keys(files).filter((p) => p.startsWith(`${dir}/`)),
		readFile: (p: string) => (p in files ? enc.encode(files[p]) : null),
	};
}

describe("fnv1aHex", () => {
	test("deterministic, content-sensitive", () => {
		const a = fnv1aHex(enc.encode("hello"));
		expect(a).toBe(fnv1aHex(enc.encode("hello")));
		expect(a).not.toBe(fnv1aHex(enc.encode("hello!")));
		expect(a).toMatch(/^[0-9a-f]{8}$/);
	});
});

describe("buildManifest", () => {
	test("hashes extensions/prompts content, lists skills name-only", () => {
		const m = buildManifest(
			fakeFs({
				"extensions/foo.ts": "export default () => {}",
				"extensions/lib/helper.ts": "export const x = 1;",
				"prompts/tool-routing.md": "rules",
				"skills/research/SKILL.md": "---\nname: research\n---",
				"settings.json": "{}",
			}),
			123,
		);
		expect(m.takenAt).toBe(123);
		expect(m.files["extensions/foo.ts"]).toMatch(/^[0-9a-f]{8}$/);
		expect(m.files["extensions/lib/helper.ts"]).toMatch(/^[0-9a-f]{8}$/);
		expect(m.files["prompts/tool-routing.md"]).toMatch(/^[0-9a-f]{8}$/);
		expect(m.files["settings.json"]).toMatch(/^[0-9a-f]{8}$/);
		expect(m.files["skills/research/SKILL.md"]).toBe("listed");
	});

	test("missing files are skipped, not errors", () => {
		const m = buildManifest(fakeFs({}), 1);
		expect(Object.keys(m.files)).toEqual([]);
	});
});

describe("diffManifests", () => {
	const base = buildManifest(fakeFs({ "extensions/a.ts": "v1", "settings.json": "{}" }), 1);

	test("identical manifests -> no drift", () => {
		expect(diffManifests(base, base)).toEqual([]);
	});

	test("new, removed, and changed files each reported", () => {
		const next = buildManifest(
			fakeFs({ "extensions/a.ts": "v2", "extensions/b.ts": "new" }),
			2,
		);
		const lines = diffManifests(base, next);
		expect(lines.some((l) => l.startsWith("~ extensions/a.ts"))).toBe(true);
		expect(lines.some((l) => l.startsWith("+ extensions/b.ts"))).toBe(true);
		expect(lines.some((l) => l.startsWith("- settings.json"))).toBe(true);
	});

	test("skill appearing/disappearing is drift (listed, not hashed)", () => {
		const prev = buildManifest(fakeFs({ "skills/x/SKILL.md": "a" }), 1);
		const next = buildManifest(fakeFs({}), 2);
		expect(diffManifests(prev, next).some((l) => l.includes("skills/x/SKILL.md"))).toBe(true);
	});

	test("skill CONTENT change alone is NOT drift (name-only by design)", () => {
		const prev = buildManifest(fakeFs({ "skills/x/SKILL.md": "a" }), 1);
		const next = buildManifest(fakeFs({ "skills/x/SKILL.md": "rewritten" }), 2);
		expect(diffManifests(prev, next)).toEqual([]);
	});
});

describe("renderDriftNotice", () => {
	test("caps lines and counts the remainder", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `~ f${i}`);
		const out = renderDriftNotice(lines, 12);
		expect(out).toContain("config-snapshot");
		expect(out).toContain("... and 8 more");
	});
});
