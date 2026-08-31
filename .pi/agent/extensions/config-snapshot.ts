/**
 * config-snapshot - drift detection for the live agent config surface.
 *
 * What stow-drift can't see (ruflo MetaHarness eval 2026-08-31): an
 * extension file that is present AND correctly symlinked yet silently not
 * loading (bad factory export, syntax error - pi logs the error at startup
 * and CONTINUES, so the first signal is missing behaviour), plus settings /
 * skills / hooks drift between sessions.
 *
 * Mechanism: on session_start, hash the live config surface under
 * ~/.pi/agent (extensions + prompts content, settings/models/keybindings/
 * APPEND_SYSTEM content, skills name-only) into a manifest at
 * ~/.pi/agent/config-snapshots/manifest.json (runtime state, NOT tracked).
 * Diff against the previous manifest; notify (TUI) or print (headless,
 * one line to stderr) only when something changed. Then persist the new
 * manifest - every session becomes the baseline for the next.
 *
 * pi's loaded-vs-on-disk extension list is NOT introspectable from inside
 * an extension (checked 2026-08-31: no ExtensionAPI surface; the TUI header
 * is the only consumer of the loader's list), so this is disk-state only.
 * "Loads OK" is approximated by content-stability + the test suite; a file
 * that breaks at load but is never edited will not be caught here - that's
 * the remaining gap, acceptable vs MetaHarness's 100-point theatre.
 *
 * Kill switch: PI_CONFIG_SNAPSHOT_OFF=1
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildManifest,
	diffManifests,
	renderDriftNotice,
	type FileSystemLike,
	type SnapshotManifest,
} from "./lib/config-snapshot-core.ts";

const OFF = process.env.PI_CONFIG_SNAPSHOT_OFF === "1";
const SNAP_DIR = () => join(getAgentDir(), "config-snapshots");
const MANIFEST_PATH = () => join(SNAP_DIR(), "manifest.json");

/** Real filesystem view rooted at a dir, returning posix relpaths. */
function fsView(root: string): FileSystemLike {
	const list = (dir: string): string[] => {
		const abs = join(root, dir);
		if (!existsSync(abs)) return [];
		const out: string[] = [];
		const walk = (cur: string) => {
			for (const name of readdirSync(cur)) {
				if (name === "node_modules" || name.endsWith(".disabled")) continue;
				const full = join(cur, name);
				const st = statSync(full);
				if (st.isDirectory()) walk(full);
				else if (st.isFile()) out.push(relative(root, full).split(sep).join("/"));
			}
		};
		try {
			walk(abs);
		} catch {
			/* partial walk is fine */
		}
		return out;
	};
	return {
		listFiles: list,
		readFile: (p: string) => {
			try {
				return readFileSync(join(root, p));
			} catch {
				return null;
			}
		},
	};
}

function loadPrev(): SnapshotManifest | null {
	try {
		return JSON.parse(readFileSync(MANIFEST_PATH(), "utf8")) as SnapshotManifest;
	} catch {
		return null;
	}
}

function save(m: SnapshotManifest): void {
	try {
		mkdirSync(SNAP_DIR(), { recursive: true });
		writeFileSync(MANIFEST_PATH(), JSON.stringify(m));
	} catch {
		/* never block a session on snapshot state */
	}
}

export default function (pi: ExtensionAPI) {
	if (OFF) return;

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		try {
			const agentDir = getAgentDir();
			const next = buildManifest(fsView(agentDir));
			const prev = loadPrev();
			if (prev) {
				const lines = diffManifests(prev, next);
				if (lines.length > 0) {
					const notice = renderDriftNotice(lines);
					// TUI: notify. Headless: notify is a no-op, so stderr gets it
					// (a warning channel, not payload corruption).
					if (ctx.hasUI) ctx.ui.notify(notice, "warning");
					else process.stderr.write(`[config-snapshot] ${lines.length} config change(s) since last session\n`);
				}
			}
			save(next);
		} catch {
			/* snapshotting must never break session start */
		}
	});

	pi.registerCommand("config-snapshot", {
		description: "Show config drift since the last session baseline",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const prev = loadPrev();
			if (!prev) {
				ctx.ui.notify("config-snapshot: no baseline manifest yet", "info");
				return;
			}
			const next = buildManifest(fsView(getAgentDir()));
			const lines = diffManifests(prev, next);
			ctx.ui.notify(
				lines.length === 0 ? "config-snapshot: no drift vs baseline" : renderDriftNotice(lines, 30),
				lines.length === 0 ? "info" : "warning",
			);
		},
	});
}
