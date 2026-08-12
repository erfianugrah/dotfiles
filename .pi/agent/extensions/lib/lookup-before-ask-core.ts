/**
 * lookup-before-ask-core - pure detection for "the agent is asking the USER
 * for a fact it could have looked up". ZERO harness imports (node stdlib only;
 * the only local dependency is the harness-agnostic sentence splitter). Source
 * of truth for BOTH the pi adapter (../lookup-before-ask.ts, message_end hook)
 * AND the Claude Code hook (../../../.claude/hooks/lookup-before-ask.ts, a
 * PreToolUse hook on the AskUserQuestion tool).
 *
 * The failure this exists for (observed 2026-08-10, cabling session): the
 * agent asked the user to re-record iperf numbers for his own 10G link and
 * invented a test date - while memledger held the actual run. Nothing was
 * broken; the lookup simply never happened.
 *
 * Scope, deliberately narrow. The detector fires only when the ask is
 * FACT-shaped (a measurement, spec, identifier, date, or past decision) AND
 * anchored to the user's own kit. A preference/design question ("Option A or
 * B?") is NOT this failure - the user is the only source, and nudging there
 * would train the model to stop asking, which is worse.
 *
 * pi vs CC event mapping:
 *   - pi has no dedicated "ask the user" tool, so the pi adapter scans the
 *     assistant's own message text at message_end and appends a nudge line.
 *   - CC surfaces the ask as a tool call (AskUserQuestion). The CC hook runs
 *     PreToolUse on that tool, pulls the question text out of tool_input, and -
 *     because a false deny would strand the model with no way to ask - emits an
 *     ADVISORY additionalContext nudge (never a deny). Same detector, both.
 */

import { anySentence } from "./sentences.ts";

/** Tools that would have answered the question. Any one call disarms (pi). */
export const LOOKUP_TOOLS = new Set([
  "memledger_search",
  "semantic_search",
  "search_messages",
  "search_ledger",
  "search_memories",
  "list_sessions",
  "session_search",
  "ledger_search",
  "ledger_sql",
]);

/**
 * Asking shapes. A question mark alone is too loose - the model ends plenty
 * of turns with a rhetorical or offer-shaped question - so an explicit
 * request verb counts too.
 */
const ASK_RE =
  /\?|\b(can you|could you|would you|please (?:run|check|measure|confirm|paste|send)|let me know|tell me|paste|send me|worth recording|if you (?:still )?have|do you (?:still )?(?:have|know|remember))\b/i;

/**
 * FACT-shaped: a measurement, spec, identifier, date, or recorded past event.
 * Deliberately excludes opinion/preference nouns.
 */
const FACT_RE =
  /\b(measure(?:d|ment)?|reading|length|diameter|width|depth|clearance|size|speed|throughput|bandwidth|latency|rate|temperature|capacity|model|make|brand|serial|part number|sku|version|firmware|revision|spec(?:s|ification)?|category|rating|ip|address|subnet|hostname|port|interface|nic|mac|uuid|ref|id\b|output|result|log|numbers?|figures?|stats?|baseline|report(?:s|ed|ing)?|shows?|says?|when did|what did|how long|how many|how much|which (?:one|model|version|port|interface|nic|card|switch|box|host))\b/i;

/**
 * Anchored to the user's own estate. Without this, ordinary technical
 * questions about third-party systems would trip the fact vocabulary.
 */
const OWN_POSSESSIVE_RE =
  /\b(your|yours|you have|you've|you run|you ran|you tested|you measured|on your|in your)\b/i;

/**
 * Physical-kit and diagnostic-tool nouns. These essentially only appear when
 * the subject is the user's own hardware.
 */
const OWN_KIT_RE =
  /\b(pc|rack|switch|router|nas|mobo|motherboard|nic|keystone|faceplate|patch panel|uplink|trunk|jack|cable|penetration|conduit|iperf\d?|fio|smartctl|ethtool|speedtest|traceroute)\b/i;

/**
 * Ambiguous words that are also common verbs. Only count them as kit when a
 * determiner marks them as a concrete thing the user possesses.
 */
const OWN_DETERMINED_RE =
  /\b(?:the|that|this|both|each)\s+(run|link|port|box|host|server|machine|drive|disk|node|card|board|line|socket)\b/i;

export function anchoredToOwnEstate(text: string): boolean {
  return OWN_POSSESSIVE_RE.test(text) || OWN_KIT_RE.test(text) || OWN_DETERMINED_RE.test(text);
}

/**
 * Did this message ask the user for a fact about their own infrastructure?
 * Pure so the decision is unit-testable without a session. Evaluated per
 * SENTENCE (via anySentence) - matched across a whole answer the conjunction
 * is vacuous.
 */
export function asksForOwnInfraFact(text: string): boolean {
  return anySentence(
    text,
    (s) => ASK_RE.test(s),
    (s) => FACT_RE.test(s),
    anchoredToOwnEstate,
  );
}

export const NUDGE_LINE =
  "lookup-before-ask: you asked for a fact about the user's own setup without searching first. " +
  "memledger_search / search_ledger / session_search hold prior sessions across pi, opencode and claude - " +
  "measurements, part numbers, commit SHAs, what was decided and when. Search before asking, " +
  "and before writing a date or number for something they said they already did. " +
  "Ask only once the lookup comes back empty, and say that it did. (LOOKUP_NUDGE_OFF=1)";

// -- CC AskUserQuestion payload projection -----------------------------------

/**
 * Pull the askable text out of a Claude Code AskUserQuestion tool_input.
 * The CC question tool carries a `questions` array (each with a `question`
 * string and `options`); older/simpler shapes may carry a bare `question` or
 * `prompt`. Concatenate every question + its option labels so the FACT/ASK/
 * anchor detectors see the whole ask. Harness-agnostic: takes plain objects.
 */
export function questionTextFromInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const parts: string[] = [];

  const pushOptions = (opts: unknown) => {
    if (!Array.isArray(opts)) return;
    for (const o of opts) {
      if (typeof o === "string") parts.push(o);
      else if (o && typeof o === "object") {
        const label = (o as Record<string, unknown>).label ?? (o as Record<string, unknown>).value;
        if (typeof label === "string") parts.push(label);
      }
    }
  };

  if (Array.isArray(obj.questions)) {
    for (const q of obj.questions) {
      if (typeof q === "string") {
        parts.push(q);
      } else if (q && typeof q === "object") {
        const qo = q as Record<string, unknown>;
        if (typeof qo.question === "string") parts.push(qo.question);
        if (typeof qo.header === "string") parts.push(qo.header);
        pushOptions(qo.options);
      }
    }
  }
  if (typeof obj.question === "string") parts.push(obj.question);
  if (typeof obj.prompt === "string") parts.push(obj.prompt);
  if (typeof obj.header === "string") parts.push(obj.header);
  pushOptions(obj.options);

  return parts.join("\n");
}

/**
 * Full CC decision for a PreToolUse hook on AskUserQuestion. Advisory only:
 * returns an additionalContext nudge when the ask is a lookup-able own-infra
 * fact, otherwise null (allow silently). Never denies - a false deny would
 * strand the model with no way to ask the user at all.
 */
export function decideAskContext(input: unknown): { additionalContext: string } | null {
  const text = questionTextFromInput(input);
  if (!text || !asksForOwnInfraFact(text)) return null;
  return { additionalContext: NUDGE_LINE };
}
