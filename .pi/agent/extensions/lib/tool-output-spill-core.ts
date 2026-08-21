// .pi/agent/extensions/lib/tool-output-spill-core.ts
/**
 * tool-output-spill core - pure decision + rendering logic.
 *
 * Port of deepseek-harness packages/spill/spill-policy: when a plain-text
 * tool result exceeds the inline byte budget, persist the full text and
 * replace the model-facing content with a bounded head/tail preview plus a
 * locator notice. The notice's byte cost is reserved out of the budget, so
 * the replacement NEVER exceeds the cap; when the notice alone cannot fit
 * the function returns null and the caller leaves the original inline.
 */

export interface TextPart {
	type: "text";
	text: string;
}

export function isPlainTextContent(content: unknown): content is TextPart[] {
	if (!Array.isArray(content) || content.length === 0) return false;
	return content.every(
		(p) =>
			typeof p === "object" &&
			p !== null &&
			(p as { type?: unknown }).type === "text" &&
			typeof (p as { text?: unknown }).text === "string",
	);
}

export function flattenText(parts: TextPart[]): string {
	return parts.map((p) => p.text).join("\n");
}

export function byteLen(s: string): number {
	return Buffer.byteLength(s, "utf-8");
}

/** Truncate to at most n UTF-8 bytes without splitting a code point. */
export function sliceBytes(s: string, n: number): string {
	const bytes = new TextEncoder().encode(s);
	if (bytes.byteLength <= n) return s;
	let out = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, n));
	while (out.endsWith("�")) out = out.slice(0, -1);
	return out;
}

/** Take the last n UTF-8 bytes without splitting a code point. */
export function sliceBytesTail(s: string, n: number): string {
	const bytes = new TextEncoder().encode(s);
	if (bytes.byteLength <= n) return s;
	let out = new TextDecoder("utf-8", { fatal: false }).decode(
		bytes.subarray(bytes.byteLength - n),
	);
	while (out.startsWith("�")) out = out.slice(1);
	return out;
}

export interface Replacement {
	/** Full model-facing replacement; guaranteed <= maxBytes. */
	text: string;
	omittedBytes: number;
}

const SEP = "\n\n";
const MIDDLE_MARKER = "\n\n[... middle omitted ...]\n\n";

export function buildReplacement(
	fullText: string,
	maxBytes: number,
	locator: string,
	hint: string,
): Replacement | null {
	const omittedBytes = byteLen(fullText);
	const notice = `(Omitted ${omittedBytes} bytes. Full result stored at: ${locator}. ${hint})`;
	const budget = maxBytes - byteLen(notice) - byteLen(SEP);
	if (budget <= 0) return null; // notice alone exceeds the cap: leave original inline

	const previewBudget = budget - byteLen(MIDDLE_MARKER);
	if (previewBudget < 2) {
		// Tiny budget: head-only preview, no marker.
		const head = sliceBytes(fullText, budget);
		return { text: head + SEP + notice, omittedBytes };
	}

	const headBudget = Math.floor(previewBudget * 0.7);
	const tailBudget = previewBudget - headBudget;
	const head = sliceBytes(fullText, headBudget);
	const tail = sliceBytesTail(fullText, tailBudget);
	return { text: head + MIDDLE_MARKER + tail + SEP + notice, omittedBytes };
}
