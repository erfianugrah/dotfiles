/**
 * config-snapshot-core - pure manifest build + diff logic for config-snapshot.
 *
 * The failure this exists for (ruflo MetaHarness eval 2026-08-31): stow-drift
 * verifies symlinks, but nothing catches "extension file present and linked
 * yet silently not loading" (bad factory export, jiti syntax error - pi
 * logs the error and CONTINUES, so the first signal is missing behaviour)
 * or settings/skills drift between sessions.
 *
 * Design:
 *   - Manifest = { files: {relpath: sha256-12} } over the live agent config
 *     surface (extensions, prompts, settings/models, skills listing, CC
 *     hooks). Pure: the adapter injects a listFiles/readFile pair so tests
 *     need no filesystem.
 *   - diffManifests(prev, next) -> human-readable change lines; empty = no
 *     drift.
 *   - Hash covers CONTENT (not just names), so an edit to an already-linked
 *     file also shows up - the "edited but broken at load" precursor.
 */

export interface FileSystemLike {
	/** Recursively list files under dir, repo-relative posix paths. */
	listFiles(dir: string): string[];
	/** Read file bytes; null when unreadable (race, perms). */
	readFile(path: string): Uint8Array | null;
}

export interface SnapshotManifest {
	takenAt: number;
	files: Record<string, string>;
}

/** Directories hashed file-by-file (content-sensitive). */
export const HASHED_DIRS = ["extensions", "prompts"] as const;
/** Single files hashed when present. */
export const HASHED_FILES = [
	"settings.json",
	"models.json",
	"keybindings.json",
	"APPEND_SYSTEM.md",
] as const;
/** Directories recorded name-only (SKILL.md bodies change often; the drift
 * signal is skills appearing/disappearing, not their prose). */
export const LISTED_DIRS = ["skills"] as const;

export function fnv1aHex(bytes: Uint8Array): string {
	// FNV-1a 32-bit - not crypto, just a drift checksum. stdlib-only so the
	// same code runs in pi (bun) and the CC hook without a hasher dep.
	let h = 0x811c9dc5;
	for (const b of bytes) {
		h ^= b;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/** Build the manifest from an injected filesystem view of the agent dir. */
export function buildManifest(fs: FileSystemLike, now = Date.now()): SnapshotManifest {
	const files: Record<string, string> = {};

	for (const dir of HASHED_DIRS) {
		for (const p of fs.listFiles(dir).sort()) {
			const bytes = fs.readFile(p);
			if (bytes) files[p] = fnv1aHex(bytes);
		}
	}
	for (const f of HASHED_FILES) {
		const bytes = fs.readFile(f);
		if (bytes) files[f] = fnv1aHex(bytes);
	}
	for (const dir of LISTED_DIRS) {
		for (const p of fs.listFiles(dir).sort()) {
			files[p] = "listed";
		}
	}
	return { takenAt: now, files };
}

/** Diff two manifests. Empty array = no drift. Lines are human-readable. */
export function diffManifests(prev: SnapshotManifest, next: SnapshotManifest): string[] {
	const out: string[] = [];
	const keys = new Set([...Object.keys(prev.files), ...Object.keys(next.files)]);
	for (const k of [...keys].sort()) {
		const a = prev.files[k];
		const b = next.files[k];
		if (a === b) continue;
		if (a === undefined) out.push(`+ ${k} (new)`);
		else if (b === undefined) out.push(`- ${k} (removed)`);
		else out.push(`~ ${k} (changed ${a} -> ${b})`);
	}
	return out;
}

/** Render the change notification block. */
export function renderDriftNotice(lines: string[], maxLines = 12): string {
	const shown = lines.slice(0, maxLines);
	const more = lines.length > shown.length ? `\n... and ${lines.length - shown.length} more` : "";
	return (
		"config-snapshot: live agent config changed since last session:\n" +
		shown.join("\n") +
		more
	);
}
