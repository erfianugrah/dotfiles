/**
 * memledger-seed - event-driven seeding of the central memledger store.
 *
 * The systemd timer syncs all session stores every 5 min, which means a
 * session can be up to 5 min invisible to memledger_search / the web UI /
 * cross-client search. This extension closes the gap for the LIVE session:
 * on turn_end (rate-limited) and session_shutdown it fires
 *
 *   memledger sync --file <current-session.jsonl>
 *
 * detached and fire-and-forget. The --file fast path fetches only that
 * file's checkpoint row (not the whole ingest_state table) and ingests
 * just the new lines, so a no-op run is one GET + one stat and a real run
 * is a handful of upserts - seconds, fully async, zero TUI impact.
 *
 * Safety: concurrent with the 5-min timer is fine - upserts are idempotent
 * (session_key+ordinal), and a clobbered older checkpoint only causes a
 * harmless re-read of the overlap. All failures are swallowed; the timer
 * is the backstop.
 *
 * Credentials: sourced from ~/.config/memledger/env (same EnvironmentFile
 * the systemd unit uses) - never written anywhere by this extension.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SeedThrottle } from "./lib/memledger-seed-core.ts";

const MIN_INTERVAL_MS = 10_000;
const ENV_FILE = join(homedir(), ".config/memledger", "env");
const LOCAL_BIN = join(homedir(), "bin", "memledger");

function memledgerBin(): string {
	return existsSync(LOCAL_BIN) ? LOCAL_BIN : "memledger"; // PATH fallback
}

function fireSync(sessionFile: string, throttle: SeedThrottle, trackDone: boolean): void {
	// bash wrapper solely to source the env file the way systemd's
	// EnvironmentFile does; exec replaces the shell so no extra process
	// lingers. stdio ignored + detached + unref: the child outlives pi on
	// session_shutdown and never blocks the event loop.
	const child = spawn(
		"bash",
		["-c", `set -a; . "${ENV_FILE}" 2>/dev/null; set +a; exec "$1" sync --file "$2"`, "memledger-seed", memledgerBin(), sessionFile],
		{ detached: true, stdio: "ignore" },
	);
	child.unref();
	if (trackDone) {
		child.on("close", () => throttle.done());
		child.on("error", () => throttle.done());
	}
}

export default function (pi: ExtensionAPI) {
	const throttle = new SeedThrottle(MIN_INTERVAL_MS);

	pi.on("turn_end", async (_event, ctx) => {
		try {
			const sessionFile = ctx.sessionManager.getSessionFile?.();
			if (!sessionFile || !existsSync(sessionFile)) return;
			if (!throttle.tryFire()) return;
			fireSync(sessionFile, throttle, true);
		} catch {
			throttle.done(); /* best-effort */
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			const sessionFile = ctx.sessionManager.getSessionFile?.();
			if (!sessionFile || !existsSync(sessionFile)) return;
			const track = throttle.fireFinal();
			fireSync(sessionFile, throttle, track);
		} catch {
			/* best-effort */
		}
	});
}
