/**
 * ai-tell-core - pure detection of high-precision AI-prose tells. ZERO
 * harness imports. Source of truth for the pi adapter (../ai-tell-guard.ts)
 * and the Claude Code hook (../../../.claude/hooks/ai-tell-guard.ts).
 *
 * Motivating evidence (2026-08-27): a Reddit thread roasting an AI-written
 * post itemised the tells readers flag on sight - negative parallelism
 * ("It's not X, it's Y"), the compressed aphorism ("No X, no Y. Just Z."),
 * mystery-tease framing ("hides a classic movie trick"), decorative bold,
 * and slop vocabulary. Readers now pattern-match these instantly; prose
 * carrying them reads as generated regardless of who wrote it.
 *
 * PRECISION IS THE DESIGN CONSTRAINT. Unlike ascii-core (deterministic:
 * a code point either is mojibake-prone or it isn't), these patterns are
 * probabilistic - "not just X, but Y" can appear in honest prose. So:
 *   - Only the highest-signal shapes are rules; anything fuzzy (decorative
 *     bold, participle tails, triplets, cross-sentence parallelism) stays in
 *     the erfi-voice skill's guidance, NOT here. A guard that false-positives
 *     gets disabled; a guard that only fires on unambiguous tells survives.
 *   - Code spans and double-quoted spans are masked before matching, so docs
 *     that QUOTE a tell as an example (erfi-voice's own kill-list) pass.
 *   - Prose paths only (.md/.txt/docs/); code files never flagged.
 *   - The adapter caps blocks at 2 per rule per session, so a model that
 *     cannot rephrase does not loop forever.
 */

import * as path from "node:path";

// Mask code spans and double-quoted spans: quoted examples are documentation
// ABOUT the tell, not instances of it. Single quotes are NOT masked - the
// apostrophe in "isn't" is a normal prose character and masking spans between
// apostrophes eats arbitrary text.
const MASK_RE = /`[^`\n]*`|"[^"\n]*"/g;

const PROSE_EXT = new Set([".md", ".mdx", ".txt", ".rst", ".adoc", ".org", ".markdown"]);
export function isProsePath(p: string): boolean {
  return PROSE_EXT.has(path.extname(p).toLowerCase()) || /(^|\/)docs?\//i.test(p);
}

export type TellRule = {
  id: string;
  pattern: RegExp;
  reason: string;
};

// [^.\n!?]{1,80}-style gaps keep the pattern inside one sentence so a
// far-apart "not ... but" pairing in ordinary argumentation is not matched.
export const TELL_RULES: TellRule[] = [
  {
    id: "negative_parallelism_not_just",
    pattern: /\bnot just\b[^.\n!?]{0,80}?,?\s*\bbut\b/gi,
    reason:
      'negative parallelism ("not just X, but Y") - an AI-prose tell readers flag on sight. State the Y fact plainly, or make the contrast with a real clause ("unlike X, Y" / "X, but Y" without the "not just" scaffold).',
  },
  {
    id: "negative_parallelism_isnt_about",
    pattern:
      /\b(?:isn'?t|is not|aren'?t|are not|wasn'?t|was not)\s+about\b[^.\n!?]{0,80}?\bit'?s\s+about\b/gi,
    reason:
      'negative parallelism ("it isn\'t about X, it\'s about Y"). State what it IS about; drop the negation scaffold.',
  },
  {
    id: "aphorism_no_x_no_y_just_z",
    pattern: /\bNo\s[^.,\n!?]{1,30},\s*no\s[^.\n!?]{1,30}\.\s*Just\b/gi,
    reason:
      'the aphorism fill-in-the-blank ("No X, no Y. Just Z.") - a template sentence with the nouns swapped, not a thought. Delete it or state the fact it gestures at.',
  },
  {
    id: "negative_parallelism_cross_sentence",
    pattern: /\bIt'?s not\s[^.\n!?]{1,50}\.\s+It'?s\s/gi,
    reason:
      'cross-sentence negative parallelism ("It\'s not X. It\'s Y."). State Y; drop the "It\'s not X" setup unless the reader demonstrably believes X.',
  },
  {
    id: "mystery_tease",
    pattern:
      /\bwhat (?:they|you) don'?t tell you\b|\byou may not know\b|\bhides a (?:classic|well-known|hidden)\b|\ba little-known\b|\bthe secret (?:to|:)\b/gi,
    reason:
      'mystery-tease framing ("what they don\'t tell you", "hides a classic X") - engagement-bait that withholds the mechanism one beat to manufacture curiosity. State the mechanism in the main clause.',
  },
  {
    id: "slop_watchlist",
    pattern: /\bdelve\b|\btapestry\b|\btestament\b|\bpivotal\b|\bgame-chang(?:er|ing)\b|\bcutting-edge\b|\bfoster\b/gi,
    reason:
      "slop vocabulary that essentially never appears in this user's technical prose (delve, tapestry, testament, pivotal, game-changer, cutting-edge, foster). Replace with the plain word or the number.",
  },
];

export type TellHit = {
  rule: TellRule;
  count: number;
  sample: string; // first match, masked context
};

// Detect tells in prose text. Returns hits (possibly empty). `minWords` (of
// the whole text) guards against flagging two-word fragments where a "hit"
// is really the whole content being an example (e.g. a grep result echo).
export function scanTells(text: string, minWords = 6): TellHit[] {
  if (!text) return [];
  const masked = text.replace(MASK_RE, " ");
  if (masked.split(/\s+/).filter(Boolean).length < minWords) return [];
  const out: TellHit[] = [];
  for (const rule of TELL_RULES) {
    rule.pattern.lastIndex = 0;
    const matches = masked.match(rule.pattern);
    if (!matches) continue;
    const idx = masked.search(rule.pattern);
    const a = Math.max(0, idx - 24);
    const b = Math.min(masked.length, idx + 48);
    const sample = masked.slice(a, b).replace(/\s+/g, " ").trim();
    out.push({ rule, count: matches.length, sample });
  }
  return out;
}

export function tellReason(hits: TellHit[], where: string, extra = ""): string {
  const lines = hits
    .map((h) => `  - [${h.rule.id}] x${h.count} -> ${h.rule.reason}\n    near: ${h.sample}`)
    .join("\n");
  return (
    `ai-tell-guard: blocked - ${where} contains AI-prose tells that readers flag on sight.\n` +
    `${lines}\n` +
    "Quoting a tell as an example is fine - wrap it in double quotes or backticks and the guard skips it. " +
    `${extra}Full catalogue: erfi-voice skill, \"Structural AI tells\".\n` +
    "Kill switch: PI_AI_TELL_GUARD_OFF=1"
  );
}
