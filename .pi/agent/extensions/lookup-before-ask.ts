/**
 * lookup-before-ask - nudge when the agent asks the USER for a fact about
 * the user's own infrastructure without first checking the stores that
 * already hold it.
 *
 * The failure this exists for (observed 2026-08-10, cabling session): the
 * agent asked the user to re-record iperf numbers for his own 10G link and
 * invented a test date from "I've tested it" - while memledger held the
 * actual run ("9.10 Gbps avg", "9.39 Gbps SUM", jumbo 9014, the NIC model and
 * the two commits that persisted it). Nothing was broken; the lookup simply
 * never happened.
 *
 * Why a nudge and not a rule alone: memledger_search / search_ledger /
 * session_search are PULL tools with no trigger. The routing rules fire them
 * when the USER references past work ("how did we do X last time?"), so when
 * the AGENT is the one with the gap there is nothing to fire on, and the two
 * cheapest paths are both wrong - ask the user (spends their turn on
 * something already recorded) or recall it (fabricates the specific, which
 * epistemic-guard then catches downstream, after the fact).
 *
 * Scope, deliberately narrow. This fires only when ALL of:
 *   1. no lookup tool has been called this session,
 *   2. the assistant message asks for something,
 *   3. what it asks for is FACT-shaped (a measurement, spec, identifier,
 *      date, or past decision) AND anchored to the user's own kit.
 *
 * A preference or design question ("Option A or B?", "which way do you want
 * to go?") is NOT this failure - the user is the only source for those, and
 * nudging them would train the model to stop asking, which is worse. The
 * fact-vocabulary + possessive-anchor conjunction is what keeps those out.
 *
 * Advisory only: appends one line to the assistant's own message, once per
 * session, never blocks. Silent in unattended runs (pi -p) where the
 * assistant text is a machine-readable payload.
 *
 * Kill switch: PI_LOOKUP_NUDGE_OFF=1
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Tools that would have answered the question. Any one call disarms. */
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
 *
 * Possessives are the obvious anchor but the WEAK one: real asks about the
 * user's own kit rarely say "your". The two that prompted this extension were
 * "how long is that run?" and "worth recording the specifics if still to
 * hand" - no possessive anywhere, ownership carried entirely by context. So
 * the kit vocabulary below does most of the work.
 */
const OWN_POSSESSIVE_RE =
  /\b(your|yours|you have|you've|you run|you ran|you tested|you measured|on your|in your)\b/i;

/**
 * Physical-kit and diagnostic-tool nouns. These essentially only appear when
 * the subject is the user's own hardware - nobody asks about "the faceplate"
 * or "iperf" in the abstract.
 */
const OWN_KIT_RE =
  /\b(pc|rack|switch|router|nas|mobo|motherboard|nic|keystone|faceplate|patch panel|uplink|trunk|jack|cable|penetration|conduit|iperf\d?|fio|smartctl|ethtool|speedtest|traceroute)\b/i;

/**
 * Ambiguous words that are also common verbs ("does Supabase run...", "link
 * to the docs"). Only count them as kit when a determiner marks them as a
 * concrete thing the user possesses.
 */
const OWN_DETERMINED_RE =
  /\b(?:the|that|this|both|each)\s+(run|link|port|box|host|server|machine|drive|disk|node|card|board|line|socket)\b/i;

function anchoredToOwnEstate(text: string): boolean {
  return OWN_POSSESSIVE_RE.test(text) || OWN_KIT_RE.test(text) || OWN_DETERMINED_RE.test(text);
}

/**
 * Did this message ask the user for a fact about their own infrastructure?
 * Pure so the decision is unit-testable without a session.
 */
export function asksForOwnInfraFact(text: string): boolean {
  if (!text.trim()) return false;
  return ASK_RE.test(text) && FACT_RE.test(text) && anchoredToOwnEstate(text);
}

export const NUDGE_LINE =
  "lookup-before-ask: you asked for a fact about the user's own setup without searching first. " +
  "memledger_search / search_ledger / session_search hold prior sessions across pi, opencode and claude - " +
  "measurements, part numbers, commit SHAs, what was decided and when. Search before asking, " +
  "and before writing a date or number for something they said they already did. " +
  "Ask only once the lookup comes back empty, and say that it did. (PI_LOOKUP_NUDGE_OFF=1)";

type TextBlock = { type?: string; text?: string };

interface State {
  searched: boolean;
  nudged: boolean;
}

function answerText(msg: unknown): string {
  const content = (msg as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as TextBlock[])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_LOOKUP_NUDGE_OFF === "1") return;

  const states = new Map<string, State>();

  const sessionKey = (ctx: unknown): string => {
    try {
      const sm = (ctx as { sessionManager?: { getSessionFile?: () => string } }).sessionManager;
      return sm?.getSessionFile?.() ?? "default";
    } catch {
      return "default";
    }
  };

  const stateFor = (ctx: unknown): State => {
    const key = sessionKey(ctx);
    let s = states.get(key);
    if (!s) {
      s = { searched: false, nudged: false };
      states.set(key, s);
    }
    return s;
  };

  // Any lookup disarms for the rest of the session: once the model has shown
  // it reaches for these, repeating the nudge is noise.
  pi.on("tool_call", async (event, ctx) => {
    const name = (event as { toolName?: string }).toolName;
    if (name && LOOKUP_TOOLS.has(name)) stateFor(ctx).searched = true;
    return undefined;
  });

  pi.on("message_end", async (event, ctx) => {
    // pi -p: the assistant text is the return payload of a subagent or loop
    // iteration. Appending advice there corrupts it.
    if ((ctx as { hasUI?: boolean }).hasUI === false) return undefined;

    const msg = (event as { message?: { role?: string; content?: unknown } }).message;
    if (!msg || msg.role !== "assistant") return undefined;

    const s = stateFor(ctx);
    if (s.searched || s.nudged) return undefined;

    const text = answerText(msg);
    if (!asksForOwnInfraFact(text)) return undefined;

    const content = msg.content as TextBlock[];
    let lastText = -1;
    for (let i = content.length - 1; i >= 0; i--) {
      if (content[i]?.type === "text" && typeof content[i]?.text === "string") {
        lastText = i;
        break;
      }
    }
    if (lastText === -1) return undefined;

    s.nudged = true;
    return {
      message: {
        ...msg,
        content: content.map((b, i) =>
          i === lastText ? { ...b, text: `${b.text}\n\n${NUDGE_LINE}` } : b,
        ),
      },
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    states.delete(sessionKey(ctx));
  });
}
