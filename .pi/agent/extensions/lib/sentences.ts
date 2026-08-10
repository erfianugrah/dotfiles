/**
 * Sentence segmentation for message-scanning nudges.
 *
 * Why this exists: a nudge that ANDs several signals together must evaluate
 * them within one sentence. Matched across a whole message the conjunction is
 * meaningless - a long assistant answer contains a question mark somewhere, a
 * spec noun somewhere, and a possessive somewhere, so the guard fires on every
 * long message and the channel becomes noise. Observed live 2026-08-10: the
 * lookup-before-ask nudge fired on a message that was DISCUSSING how to detect
 * asks, because the three signals appeared in three unrelated paragraphs.
 *
 * Markdown-aware in the only way that matters here: each line is its own unit,
 * so list items and headings never merge with their neighbours. Within a line,
 * split on sentence terminators.
 */

/** Split prose into sentence-ish units. Never returns empty strings. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const part of trimmed.split(/(?<=[.!?])\s+/)) {
      const s = part.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/** Does any single sentence satisfy every predicate? */
export function anySentence(text: string, ...predicates: ((s: string) => boolean)[]): boolean {
  if (!text.trim()) return false;
  return sentences(text).some((s) => predicates.every((p) => p(s)));
}
