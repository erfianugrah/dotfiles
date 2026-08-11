/**
 * ascii-core - pure smart-punctuation detection + folding. ZERO harness
 * imports. Source of truth for both the pi adapter
 * (../ascii-punctuation-guard.ts, block-only tool_call hook) and the Claude
 * Code hook (../../../.claude/hooks/ascii-guard.ts, which can AUTO-REWRITE via
 * PreToolUse updatedInput - a capability pi's hook lacks).
 *
 * Detection tables copied from the original ascii-punctuation-guard.ts so the
 * pi test suite stays behaviourally identical; foldToAscii is new (the CC
 * auto-rewrite path). Code points are \uXXXX escapes - the unambiguous form
 * for a class of visually-confusable dash/quote characters. See
 * .pi/agent/docs/pi-to-claude-code-port.md.
 */

import * as path from "node:path";

// -- smart-punctuation -> ASCII map ------------------------------------------
const REPLACEMENTS: Array<{ re: RegExp; name: string; ascii: string }> = [
  { re: /—/g, name: "em dash (U+2014)", ascii: "-" },
  { re: /–/g, name: "en dash (U+2013)", ascii: "-" },
  { re: /[‒―]/g, name: "figure/horizontal bar (U+2012/2015)", ascii: "-" },
  { re: /[‐‑]/g, name: "unicode/non-breaking hyphen (U+2010/2011)", ascii: "-" },
  { re: /[‘’‚‛]/g, name: "smart single quote (U+2018-201B)", ascii: "'" },
  { re: /[“”„‟]/g, name: "smart double quote (U+201C-201F)", ascii: '"' },
  { re: /…/g, name: "ellipsis (U+2026)", ascii: "..." },
  { re: / /g, name: "non-breaking space (U+00A0)", ascii: " " },
  { re: /′/g, name: "prime (U+2032)", ascii: "'" },
  { re: /″/g, name: "double prime (U+2033)", ascii: '"' },
  { re: /[«»‹›]/g, name: "guillemet (U+00AB/BB/2039/203A)", ascii: '"' },
];

// Single combined test for the fast-path "is there anything to check?".
const ANY = /[‐-―‘-‟… ′″«»‹›]/;

const PROSE_EXT = new Set([".md", ".mdx", ".txt", ".rst", ".adoc", ".org", ".markdown"]);
export function isProsePath(p: string): boolean {
  return PROSE_EXT.has(path.extname(p).toLowerCase()) || /(^|\/)docs?\//i.test(p);
}

// bash commands that persist text (so smart punctuation in them lands somewhere)
export const WRITE_BASH = /(\bgit\s+commit\b|\bgit\s+(?:tag|notes)\b|\btee\b|>>?|<<-?\s*['"]?\w|\bsd\b|\bsed\s+-i\b|\bperl\s+-i\b)/;

export interface Found {
  name: string;
  ascii: string;
  count: number;
  sample: string; // masked context snippet of first hit
}

export function scan(text: string): Found[] {
  if (!text || !ANY.test(text)) return [];
  const out: Found[] = [];
  for (const { re, name, ascii } of REPLACEMENTS) {
    re.lastIndex = 0;
    const matches = text.match(re);
    if (!matches) continue;
    const idx = text.search(re);
    const a = Math.max(0, idx - 20);
    const b = Math.min(text.length, idx + 20);
    const snippet = (a > 0 ? "…" : "") + text.slice(a, b).replace(/\s+/g, " ") + (b < text.length ? "…" : "");
    out.push({ name, ascii, count: matches.length, sample: snippet });
  }
  return out;
}

/**
 * Fold every smart-punctuation char to its ASCII equivalent. Used by the CC
 * hook to auto-rewrite instead of blocking. Idempotent; no-op fast-path when
 * there is nothing to fold.
 */
export function foldToAscii(text: string): string {
  if (!text || !ANY.test(text)) return text;
  let out = text;
  for (const { re, ascii } of REPLACEMENTS) {
    re.lastIndex = 0;
    out = out.replace(re, ascii);
  }
  return out;
}

export function reason(found: Found[], where: string): string {
  const lines = found
    .map((f) => `  - ${f.name} x${f.count} -> replace with ${JSON.stringify(f.ascii)}`)
    .join("\n");
  const ctx = found[0]?.sample ?? "";
  return (
    `ascii-punctuation-guard: blocked - ${where} contains "smart" punctuation that ` +
    `mojibakes when copy-pasted. Resubmit with ASCII:\n${lines}\n` +
    (ctx ? `Near: ${ctx}\n` : "") +
    `Kill switch: PI_ASCII_GUARD_OFF=1 - prose-only: PI_ASCII_GUARD_SCOPE=prose`
  );
}
