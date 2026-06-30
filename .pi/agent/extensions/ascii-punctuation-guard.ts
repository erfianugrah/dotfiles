/**
 * ascii-punctuation-guard — keep mojibake-prone "smart" punctuation out of
 * files, commits, and heredocs the user copy-pastes elsewhere.
 *
 * Motivating incident (2026-06-30): the agent emitted em dashes into a GitHub
 * issue draft; pasted into a web composer they rendered as `ÔÇö` (UTF-8 em-dash
 * bytes mis-decoded as CP437/Latin-1). The user can't cleanly copy-paste.
 *
 * The harness `tool_call` hook can only block (no input rewrite), so this guard
 * BLOCKS a write/edit/apply_patch/commit whose payload contains a smart-
 * punctuation character and reports exactly which chars to swap for ASCII. The
 * agent then resubmits with the ASCII equivalents — one-shot, deterministic.
 *
 * Scope:
 *   - write / edit / write_stream / apply_patch: payload content (all files).
 *   - bash: ONLY commands that write/commit (git commit, tee, >>, heredoc, …),
 *     matching the confidential-write-guard's WRITE_BASH idiom — so ordinary
 *     bash that merely PRINTS unicode (e.g. echoing search results) is ignored.
 *
 * Chat text is NOT guardable (no assistant-output hook) — a companion memory
 * handles the agent's prose register.
 *
 * Env:
 *   PI_ASCII_GUARD_OFF=1       disable entirely.
 *   PI_ASCII_GUARD_SCOPE=prose limit file checks to prose (.md/.txt/docs/…);
 *                              code files then pass (em dash in a string literal
 *                              stays allowed). Default: all files.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

// ── smart-punctuation → ASCII map ───────────────────────────────────────────
// Curated to chars that (a) have a clean ASCII equivalent and (b) routinely
// mojibake on paste. Deliberately excludes things like • or → where the unicode
// is often the intended glyph.
const REPLACEMENTS: Array<{ re: RegExp; name: string; ascii: string }> = [
  { re: /\u2014/g, name: "em dash (U+2014)", ascii: "-" },
  { re: /\u2013/g, name: "en dash (U+2013)", ascii: "-" },
  { re: /[\u2012\u2015]/g, name: "figure/horizontal bar (U+2012/2015)", ascii: "-" },
  { re: /[\u2010\u2011]/g, name: "unicode/non-breaking hyphen (U+2010/2011)", ascii: "-" },
  { re: /[\u2018\u2019\u201A\u201B]/g, name: "smart single quote (U+2018-201B)", ascii: "'" },
  { re: /[\u201C\u201D\u201E\u201F]/g, name: "smart double quote (U+201C-201F)", ascii: '"' },
  { re: /\u2026/g, name: "ellipsis (U+2026)", ascii: "..." },
  { re: /\u00A0/g, name: "non-breaking space (U+00A0)", ascii: " " },
  { re: /\u2032/g, name: "prime (U+2032)", ascii: "'" },
  { re: /\u2033/g, name: "double prime (U+2033)", ascii: '"' },
  { re: /[\u00AB\u00BB\u2039\u203A]/g, name: "guillemet (U+00AB/BB/2039/203A)", ascii: '"' },
];

// Single combined test for the fast-path "is there anything to check?".
const ANY = /[\u2010-\u2015\u2018-\u201F\u2026\u00A0\u2032\u2033\u00AB\u00BB\u2039\u203A]/;

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

function reason(found: Found[], where: string): string {
  const lines = found
    .map((f) => `  • ${f.name} ×${f.count} → replace with ${JSON.stringify(f.ascii)}`)
    .join("\n");
  const ctx = found[0]?.sample ?? "";
  return (
    `ascii-punctuation-guard: blocked — ${where} contains "smart" punctuation that ` +
    `mojibakes when copy-pasted. Resubmit with ASCII:\n${lines}\n` +
    (ctx ? `Near: ${ctx}\n` : "") +
    `Kill switch: PI_ASCII_GUARD_OFF=1 · prose-only: PI_ASCII_GUARD_SCOPE=prose`
  );
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_ASCII_GUARD_OFF === "1") return;
  const proseOnly = process.env.PI_ASCII_GUARD_SCOPE === "prose";

  pi.on("tool_call", async (event) => {
    const tool = event.toolName;

    if (tool === "write" || tool === "edit" || tool === "write_stream") {
      const input = event.input as { path?: string; file_path?: string; content?: string; newText?: string };
      const target = input.path ?? input.file_path;
      if (typeof target !== "string") return undefined;
      if (proseOnly && !isProsePath(target)) return undefined;
      const found = scan(input.content ?? input.newText ?? "");
      if (found.length) return { block: true, reason: reason(found, `${tool} → ${target}`) };
      return undefined;
    }

    if (tool === "apply_patch") {
      const patchText = (event.input as { patchText?: string }).patchText ?? "";
      // only scan added/updated body lines (leading '+') so existing context isn't penalised
      const added = patchText
        .split(/\r?\n/)
        .filter((l) => l.startsWith("+"))
        .join("\n");
      const found = scan(added);
      if (found.length) return { block: true, reason: reason(found, "apply_patch") };
      return undefined;
    }

    if (tool === "bash") {
      const cmd = (event.input as { command?: string }).command;
      if (typeof cmd !== "string" || !WRITE_BASH.test(cmd)) return undefined;
      const found = scan(cmd);
      if (found.length) return { block: true, reason: reason(found, "bash (writes/commits)") };
      return undefined;
    }

    return undefined;
  });
}
