/**
 * manifest-coverage: a SENSOR ON THE HARNESS ITSELF.
 *
 * The pi-package (`@erfianugrah/pi-harness`, root package.json `pi` manifest)
 * ships resources by GLOB. A glob that silently fails to match a resource
 * ships a broken package - which is exactly how v0.1.0 lost lsp, session-fts,
 * session-ledger (directory extensions whose entry is an index.ts one level
 * down, never matched by a top-level *.ts glob).
 *
 * This test asserts the manifest globs cover EVERY on-disk resource, so that
 * class of bug fails here instead of on someone else's machine.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", ".."); // tests -> agent -> .pi -> repo root
const manifest = JSON.parse(
	require("node:fs").readFileSync(join(ROOT, "package.json"), "utf8"),
).pi as {
	extensions: string[];
	skills: string[];
	prompts: string[];
	themes: string[];
};

/** Repo-relative paths matched by a manifest glob. */
function matched(glob: string): Set<string> {
	// dot:true because resources live under the .pi dot-directory (pi's own
	// manifest loader matches them; a default glob would skip dotdirs).
	return new Set(
		Array.from(new Bun.Glob(glob).scanSync({ cwd: ROOT, onlyFiles: true, dot: true })),
	);
}

/** Union of everything the extensions globs cover. */
function coveredExtensions(): Set<string> {
	const out = new Set<string>();
	for (const g of manifest.extensions) for (const p of matched(g)) out.add(p);
	return out;
}

const EXT_DIR = join(ROOT, ".pi/agent/extensions");

/** Ground truth: every loadable extension entry point on disk. */
function extensionsOnDisk(): string[] {
	const truth: string[] = [];
	for (const name of readdirSync(EXT_DIR)) {
		const full = join(EXT_DIR, name);
		const st = statSync(full);
		if (st.isFile() && name.endsWith(".ts") && !name.endsWith(".ts.disabled")) {
			truth.push(`.pi/agent/extensions/${name}`);
		} else if (st.isDirectory() && existsSync(join(full, "index.ts"))) {
			// directory extension: entry is <dir>/index.ts (docs/extensions.md)
			truth.push(`.pi/agent/extensions/${name}/index.ts`);
		}
	}
	return truth;
}

describe("pi-harness manifest coverage", () => {
	test("every extension on disk is matched by an extensions glob", () => {
		const covered = coveredExtensions();
		const missing = extensionsOnDisk().filter((p) => !covered.has(p));
		expect(missing).toEqual([]);
	});

	test("no disabled extension is shipped", () => {
		const covered = [...coveredExtensions()];
		expect(covered.filter((p) => p.endsWith(".disabled"))).toEqual([]);
	});

	test("skills / prompts / themes manifest paths exist and are non-empty", () => {
		for (const p of [...manifest.skills, ...manifest.prompts, ...manifest.themes]) {
			const full = join(ROOT, p);
			expect(existsSync(full)).toBe(true);
			expect(readdirSync(full).length).toBeGreaterThan(0);
		}
	});
});
