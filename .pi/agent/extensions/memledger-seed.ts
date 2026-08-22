/**
 * memledger-seed - event-driven seeding of the central memledger store.
 *
 * This extension is the portable scheduler for memledger ingest, anywhere
 * pi runs (no systemd user timers needed). It fires two detached,
 * fire-and-forget syncs:
 *
 *   - fast path, on turn_end (10 s rate-limit) and session_shutdown:
 *     `memledger sync --file <current-session.jsonl>` - fetches only that
 *     file's checkpoint row (not the whole ingest_state table) and ingests
 *     just the new lines, so a no-op run is one GET + one stat and a real
 *     run is a handful of upserts - seconds, fully async, zero TUI impact.
 *   - full sweep, on turn_end (15 min rate-limit, env-overridable via
 *     MEMLEDGER_SEED_FULL_MS) and session_shutdown: `memledger sync` -
 *     ledger.db, memories.json, and any other changed session files.
 *
 * On Linux the 5-min systemd user timer remains as a belt-and-braces
 * backstop (boot-time and no-session-active windows); it is not
 * load-bearing for freshness.
 *
 * Safety: concurrent runs (timer + extension) are fine - upserts are
 * idempotent (session_key+ordinal), and a clobbered older checkpoint only
 * causes a harmless re-read of the overlap. All failures are swallowed;
 * the backstop catches anything missed.
 *
 * Credentials: the memledger CLI loads ~/.config/memledger/env itself
 * (since the 2026-08-22 envfile change); this extension passes nothing.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SeedThrottle } from "./lib/memledger-seed-core.ts";

const MIN_INTERVAL_MS = 10_000;
// Full-sweep cadence: the extension is the portable scheduler (anywhere pi
// runs - no systemd user units needed). On the dev box the 5-min systemd
// timer remains as backstop for boot-time and no-session windows; this
// interval only bounds how often ONE live session re-sweeps everything.
// Env-overridable for verification (e.g. MEMLEDGER_SEED_FULL_MS=5000).
const FULL_INTERVAL_MS =
	Number(process.env.MEMLEDGER_SEED_FULL_MS) || 15 * 60_000;
const LOCAL_BIN = join(homedir(), "bin", "memledger");

function memledgerBin(): string {
	return existsSync(LOCAL_BIN) ? LOCAL_BIN : "memledger"; // PATH fallback
}

function fireSync(
	args: string[],
	throttle: SeedThrottle,
	trackDone: boolean,
): void {
	// Direct spawn: the CLI loads ~/.config/memledger/env itself (since
	// the 2026-08-22 envfile change), so no bash sourcing wrapper is
	// needed - which also removes the bash dependency for portability.
	// stdio ignored + detached + unref: the child outlives pi on
	// session_shutdown and never blocks the event loop.
	const child = spawn(memledgerBin(), args, {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	if (trackDone) {
		child.on("close", () => throttle.done());
		child.on("error", () => throttle.done());
	}
}

export default function (pi: ExtensionAPI) {
	const throttle = new SeedThrottle(MIN_INTERVAL_MS);
	const fullThrottle = new SeedThrottle(FULL_INTERVAL_MS);

	pi.on("turn_end", async (_event, ctx) => {
		try {
			const sessionFile = ctx.sessionManager.getSessionFile?.();
			if (!sessionFile || !existsSync(sessionFile)) return;
			if (throttle.tryFire()) {
				fireSync(["sync", "--file", sessionFile], throttle, true);
			}
			// Periodic full sweep: ledger.db, memories.json, and any other
			// changed session files - everything the timer used to be the
			// only path for. Cheap (measured 10-55ms); skipped turns are
			// caught by the next one or the systemd backstop.
			if (fullThrottle.tryFire()) {
				fireSync(["sync"], fullThrottle, true);
			}
		} catch {
			throttle.done(); /* best-effort */
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			const sessionFile = ctx.sessionManager.getSessionFile?.();
			if (!sessionFile || !existsSync(sessionFile)) return;
			const track = throttle.fireFinal();
			fireSync(["sync", "--file", sessionFile], throttle, track);
			// Full sweep on shutdown too (best-effort: if the shutdown
			// ledger row lands after this spawn, the timer or the next
			// session's sweep catches it).
			const trackFull = fullThrottle.fireFinal();
			fireSync(["sync"], fullThrottle, trackFull);
		} catch {
			/* best-effort */
		}
	});
}
