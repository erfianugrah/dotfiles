/**
 * transcript-timestamps - dim timestamp + elapsed-time rows in the transcript.
 *
 * Pi records a Unix-ms timestamp on every session message but only surfaces
 * them as /tree label timestamps (Shift+T). This extension renders them in
 * the live transcript: one dim row under each user message and one under each
 * completed turn, persisted as custom "ts" entries (NOT in LLM context) so
 * they survive reload/resume/branching.
 *
 *   [19:42:03] you
 *   [19:42:17] assistant · 14s
 *   [19:43:01] assistant · 9s · 58s since prompt
 *
 * Ordering notes (verified empirically against pi 0.80.x, /tmp probe):
 *   - message_end fires BEFORE the message is appended to the session, so an
 *     appendEntry there lands above its message. Don't do that.
 *   - At assistant message_start the user message IS in the session: that is
 *     where the user row is flushed (it lands between user and assistant).
 *   - At turn_end all of the turn's messages (assistant + toolResults) are in
 *     the session: that is where the turn row is appended.
 *   - agent_end is the fallback flush for aborted runs (row marked "partial").
 *
 * Kill switch: PI_TIMESTAMPS_OFF=1
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	renderRow,
	sameDay,
	type TsRowData,
} from "./lib/transcript-timestamps-core.ts";

const CUSTOM_TYPE = "ts";

interface ScanState {
	lastRowAt: number;
	lastUserAt: number;
}

/** Restore continuity state (idle-gap anchor, last user prompt) from the
 *  session entries so reloaded/resumed sessions keep correct gaps. */
function scanEntries(entries: unknown[]): ScanState {
	let lastRowAt = 0;
	let lastUserAt = 0;
	for (const raw of entries) {
		const e = raw as {
			type?: string;
			customType?: string;
			data?: TsRowData;
			message?: { role?: string; timestamp?: number };
		};
		if (e.type === "custom" && e.customType === CUSTOM_TYPE && e.data?.at) {
			lastRowAt = e.data.at;
		}
		if (e.type === "message" && e.message?.role === "user" && e.message.timestamp) {
			lastUserAt = e.message.timestamp;
		}
	}
	return { lastRowAt, lastUserAt };
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_TIMESTAMPS_OFF === "1") return;

	// -- renderer -------------------------------------------------------------
	pi.registerEntryRenderer<TsRowData>(CUSTOM_TYPE, (entry, _opts, theme) => {
		const data = entry.data ?? { kind: "user", at: Date.now() };
		return new Text(theme.fg("dim", renderRow(data)), 1, 0);
	});

	// -- state ----------------------------------------------------------------
	let lastRowAt = 0;
	let lastUserAt = 0;
	let pendingUser: number | undefined; // user message ts awaiting a row
	let turnStartAt = 0; // current turn's turn_start ts
	let turnOpen = false; // turn_start seen, turn_end not yet

	const append = (row: TsRowData) => {
		row.showDate = lastRowAt !== 0 && !sameDay(row.at, lastRowAt);
		lastRowAt = row.at;
		pi.appendEntry<TsRowData>(CUSTOM_TYPE, row);
	};

	// -- events ---------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		const s = scanEntries(ctx.sessionManager.getEntries() as unknown[]);
		lastRowAt = s.lastRowAt;
		lastUserAt = s.lastUserAt;
		pendingUser = undefined;
		turnStartAt = 0;
		turnOpen = false;
	});

	// User message finalized (not yet in session). Remember it; flush on the
	// next assistant message_start, when the user entry is safely below us.
	pi.on("message_end", async (event) => {
		const msg = event.message as { role?: string; timestamp?: number };
		if (msg?.role !== "user") return;
		const at = msg.timestamp ?? Date.now();
		pendingUser = at;
		lastUserAt = at;
	});

	pi.on("message_start", async (event) => {
		const msg = event.message as { role?: string };
		if (msg?.role !== "assistant") return;
		if (pendingUser === undefined) return;
		const at = pendingUser;
		pendingUser = undefined;
		append({
			kind: "user",
			at,
			idleMs: lastRowAt ? at - lastRowAt : undefined,
		});
	});

	pi.on("turn_start", async (event) => {
		turnStartAt = (event as { timestamp?: number }).timestamp ?? Date.now();
		turnOpen = true;
	});

	pi.on("turn_end", async () => {
		if (!turnOpen) return;
		turnOpen = false;
		const at = Date.now();
		append({
			kind: "turn",
			at,
			turnMs: turnStartAt ? at - turnStartAt : undefined,
			sincePromptMs: lastUserAt ? at - lastUserAt : undefined,
		});
	});

	// Aborted runs: flush what never got a natural row. A partial turn row
	// only makes sense if the turn actually started.
	pi.on("agent_end", async () => {
		if (pendingUser !== undefined) {
			const at = pendingUser;
			pendingUser = undefined;
			append({
				kind: "user",
				at,
				idleMs: lastRowAt ? at - lastRowAt : undefined,
			});
		}
		if (turnOpen) {
			turnOpen = false;
			const at = Date.now();
			append({
				kind: "turn",
				at,
				turnMs: turnStartAt ? at - turnStartAt : undefined,
				sincePromptMs: lastUserAt ? at - lastUserAt : undefined,
				partial: true,
			});
		}
	});
}
