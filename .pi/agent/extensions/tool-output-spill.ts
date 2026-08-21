// .pi/agent/extensions/tool-output-spill.ts
/**
 * tool-output-spill - keep oversized plain-text tool results out of context.
 *
 * Port of deepseek-harness packages/spill/spill-policy to pi's tool_result
 * event (which natively supports content replacement). Complements
 * tool-output-prune: prune reclaims OLD results at the context event; spill
 * bounds a FRESH oversized result the moment it lands.
 *
 * Primary targets are the extension tools without provider-side caps:
 * webfetch (5MB), codesearch / context7_query_docs (50k tokens), task,
 * sg_dossier, video_doc. Built-in bash/read self-cap at 50KB/2000 lines,
 * so they rarely trigger this.
 *
 * Semantics (matching dsh):
 *   - Only all-text results are spillable (mixed/image content untouched).
 *   - `read` is skipped: spilling a read result forces a read-again loop.
 *   - Best-effort: any persistence failure leaves the original inline; a
 *     spill failure never turns a success into an error.
 *   - The replacement (preview + notice) never exceeds the byte cap.
 *
 * Env:
 *   PI_SPILL_MAX_BYTES  default 51200 (matches built-in tool caps)
 *   PI_SPILL_DIR        default ~/.pi/agent/spill
 *   PI_SPILL_OFF=1      disable
 *   PI_SPILL_VERBOSE=1  notify on each spill
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	buildReplacement,
	byteLen,
	flattenText,
	isPlainTextContent,
} from "./lib/tool-output-spill-core.ts";

const MAX_BYTES = Math.max(
	1024,
	Number(process.env.PI_SPILL_MAX_BYTES ?? "51200"),
);
const SPILL_DIR =
	process.env.PI_SPILL_DIR ?? join(homedir(), ".pi", "agent", "spill");
const OFF = process.env.PI_SPILL_OFF === "1";
const VERBOSE = process.env.PI_SPILL_VERBOSE === "1";

// `read` spilling would force a read -> spill -> read-again loop.
const SKIP_TOOLS = new Set(["read"]);

const HINT =
	"Use read with offset/limit, or grep this path to search within it.";

function safe(s: string): string {
	return s.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
}

export default function (pi: ExtensionAPI) {
	if (OFF) return;

	pi.on("tool_result", async (event, ctx) => {
		if (SKIP_TOOLS.has(event.toolName)) return;
		if (!isPlainTextContent(event.content)) return;

		const full = flattenText(event.content);
		if (byteLen(full) <= MAX_BYTES) return;

		let sessionId = "ephemeral";
		try {
			sessionId = ctx.sessionManager.getSessionId() ?? "ephemeral";
		} catch {
			// headless / early-boot: keep the fallback
		}
		const dir = join(SPILL_DIR, safe(sessionId));
		const file = join(
			dir,
			`${safe(event.toolCallId)}-${safe(event.toolName)}.txt`,
		);

		try {
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, full);
		} catch {
			return; // best-effort: never hide the inline result
		}

		const repl = buildReplacement(full, MAX_BYTES, file, HINT);
		if (!repl) return; // notice cannot fit: leave original inline

		if (VERBOSE) {
			ctx.ui.notify(
				`tool-output-spill: ${event.toolName} (${repl.omittedBytes}B) -> ${file}`,
				"info",
			);
		}
		return { content: [{ type: "text", text: repl.text }] };
	});
}
