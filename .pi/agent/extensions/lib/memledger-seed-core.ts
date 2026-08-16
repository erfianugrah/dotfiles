/**
 * memledger-seed-core - pure decision logic for the memledger-seed
 * extension's fire policy. Kept separate from the spawn side effects so
 * the bun test suite can cover it.
 *
 * The policy:
 *   - turn_end: at most one sync per minIntervalMs, never concurrent.
 *     Each sync is offset-checkpointed, so a skipped turn is picked up by
 *     the next one (or by the 5-min systemd timer backstop).
 *   - session_shutdown: always fire. A second concurrent sync of the same
 *     file is idempotent (upserts on session_key+ordinal), and pi is
 *     exiting - there is no "next turn" to catch the final messages.
 */
export class SeedThrottle {
	private lastFired = Number.NEGATIVE_INFINITY; // never fired: any `now` passes the interval check
	private inFlight = false;

	constructor(private readonly minIntervalMs = 10_000) {}

	/** Returns true when a sync may fire now; marks it in-flight. */
	tryFire(now = Date.now()): boolean {
		if (this.inFlight) return false;
		if (now - this.lastFired < this.minIntervalMs) return false;
		this.inFlight = true;
		this.lastFired = now;
		return true;
	}

	/** Shutdown path: always fire, but only mark in-flight if free. */
	fireFinal(now = Date.now()): boolean {
		this.lastFired = now;
		if (this.inFlight) return false; // still fire, just don't flip state
		this.inFlight = true;
		return true;
	}

	/** Mark the in-flight sync finished (process exited / spawn failed). */
	done(): void {
		this.inFlight = false;
	}
}
