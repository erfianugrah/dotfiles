/**
 * entity-qualifier-nudge - a bare device identifier used as EVIDENCE must
 * name the host it belongs to.
 *
 * Why this exists. On 2026-08-10 the agent argued for buying better 10G
 * cabling by citing a flap-and-downshift incident "on eth0". That eth0 is an
 * onboard 1G Realtek on a bridge; the 10G path under discussion is a
 * different card entirely. The cited fact was real, the argument built from
 * it was fabricated, and the record it came from HAD the qualifiers - they
 * were dropped in the retelling.
 *
 * This cannot check whether the right entity was picked; that is the
 * reasoning being policed, and no mechanical check can do that. What it CAN
 * do is force the disambiguation: writing "servarr's eth0" instead of bare
 * "eth0" is the moment a cross-host mix-up becomes visible to a human
 * reader, which is exactly the moment the original mistake would have been
 * caught.
 *
 * The one precise trap this guards against: a DATE sitting next to the
 * identifier looks like it qualifies something ("on 2026-08-08") but does
 * not - a date says WHEN, not WHICH BOX. That distinction is the entire
 * defect in the sentence that motivated this file, so "on/at/for <token>"
 * only counts as a qualifier when `<token>` is a name, never a date or a
 * generic determiner.
 *
 * Scope, deliberately narrow (same shape as lookup-before-ask.ts):
 *   1. a device identifier is present (eth0, enp2s0f0np0, br0, nvme0n1,
 *      sda1, or a switch port like eth0/1/1),
 *   2. evidential/incident vocabulary is present nearby - the identifier is
 *      being cited as EVIDENCE, not merely named,
 *   3. no host qualifier accompanies it.
 *
 * Naming an interface without making a claim from it (config, command
 * lines, plain description) must stay silent - the failure is retelling an
 * incident without the host, not mentioning hardware.
 *
 * Advisory only: appends one line to the assistant's own message, once per
 * session, never blocks. Silent in unattended runs (pi -p) where the
 * assistant text is a machine-readable payload.
 *
 * Kill switch: PI_ENTITY_NUDGE_OFF=1
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { anySentence } from "./lib/sentences.ts";

// ── device identifiers ───────────────────────────────────────────────────────

/**
 * Interface / block-device naming schemes worth disambiguating:
 *   - eth0, and switch ports written the same way (eth0/1/1)
 *   - predictable network names: eno1, ens5, enp2s0f0np0, enx...
 *   - wlan0, br0, bond0 (bridges/bonds are the classic "which box" trap)
 *   - nvme0n1 (optionally partitioned: nvme0n1p1)
 *   - sda, sdb1
 */
const DEVICE_ID_CORE = String.raw`(?:eth\d+(?:\/\d+){0,2}|en(?:o|s|p|x)\w*\d\w*|wlan\d+|br\d+|bond\d+|nvme\d+n\d+(?:p\d+)?|sd[a-z]\d*)`;

const RE_DEVICE_ID = new RegExp(String.raw`\b` + DEVICE_ID_CORE + String.raw`\b`, "i");

/**
 * `sd[a-z]` is indistinguishable from ordinary three-letter words: `sdk` parses
 * as a disk exactly as well as `sda` does. Nothing lexical separates them, so
 * the common false friends are listed. Caught by an adversarial pass, not by
 * the spec - "the SDK errors last week" fired the nudge.
 */
const NOT_A_DEVICE = new Set(["sdk", "sdn", "sdr", "sdl", "sdm", "sdp", "sds"]);

/** Any real device identifier here, false friends excluded? */
function hasDeviceId(text: string): boolean {
  const re = new RegExp(String.raw`\b` + DEVICE_ID_CORE + String.raw`\b`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!NOT_A_DEVICE.has(m[0].toLowerCase())) return true;
  }
  return false;
}

/**
 * Evidential / incident vocabulary - the identifier is being used to back up
 * a claim, not just named in a config line or a description.
 */
const RE_EVIDENTIAL =
  /\b(flap(?:s|ped|ping)?|downshift\w*|incident\w*|outage\w*|dropped|drops?|dropping|retrain\w*|errors?|crash(?:ed|es|ing)?|you had|we saw|last week|the earlier|back in)\b/i;

/** Month names are dates, never host names - kept out of the qualifier check. */
const MONTH_NAMES = new Set([
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
]);

/**
 * Determiners and relative-time words that can precede "on/at/for" without
 * naming anything ("on the switch", "last week"). Treating these as host
 * names would defeat the whole check on ordinary prose.
 */
const NOT_A_NAME = new Set([
  "the",
  "a",
  "an",
  "this",
  "that",
  "these",
  "those",
  "last",
  "next",
  "today",
  "yesterday",
  "tomorrow",
  // Possessive determiners name a person, not a box: "errors on my br0" still
  // leaves the host unstated.
  "my",
  "our",
  "your",
  "their",
  "its",
  "his",
  "her",
  // Verbs and connectives that can sit directly before an interface name and
  // would otherwise be read as the hostname in the bare-adjacency form.
  "saw",
  "see",
  "seen",
  "had",
  "has",
  "have",
  "got",
  "and",
  "or",
  "but",
  "when",
  "while",
  "after",
  "before",
  "during",
  "both",
  "all",
  "some",
  "any",
  "one",
  "two",
  "if",
  "is",
  "was",
  "were",
  "then",
  "also",
  // Adjectives and time words that commonly sit directly before an interface
  // name ("the earlier eth0 outage"). Without these the adjacency rule reads
  // the adjective as the hostname and silences a real citation.
  "earlier",
  "later",
  "recent",
  "previous",
  "prior",
  "old",
  "new",
  "same",
  "other",
  "another",
  "current",
  "existing",
  "affected",
  "failing",
  "first",
  "second",
  "third",
  "only",
  "single",
  "whole",
  "entire",
  "main",
  "primary",
  "secondary",
]);

/**
 * A device identifier immediately possessed by a name ("servarr's eth0") or
 * addressed as host:iface ("servarr:eth0").
 */
const RE_POSSESSIVE_HOST =
  /\b[a-z][\w-]*'s\s+(?=(?:eth\d|en(?:o|s|p|x)|wlan\d|br\d|bond\d|nvme\d|sd[a-z]))/i;
const RE_HOST_COLON = /\b[a-z][\w-]*:(?:eth\d|en(?:o|s|p|x)|wlan\d|br\d|bond\d|nvme\d|sd[a-z])/i;

/**
 * Does the text carry a NAME qualifying which box the identifier belongs to?
 * "on <name>" / "at <name>" / "for <name>" only count when `<name>` is an
 * actual name - not a date (starts with a digit, so the pattern already
 * excludes it) and not a determiner/month masquerading as one.
 */
function hasHostQualifier(text: string): boolean {
  if (RE_POSSESSIVE_HOST.test(text) || RE_HOST_COLON.test(text)) return true;

  const prepositional = /\b(?:on|at|for)\s+([A-Za-z][\w.-]*)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = prepositional.exec(text)) !== null) {
    if (isHostName(m[1])) return true;
  }

  // Bare adjacency - `servarr eth0` - is the most natural way to name the box
  // and an earlier version missed it entirely, silencing nothing while looking
  // correct against a spec that only used the possessive form. The stopword
  // list is what keeps `we saw eth0` from reading "saw" as a hostname; it is a
  // heuristic, and an unusual verb directly before an interface name will slip
  // through as a false qualifier.
  const adjacent = new RegExp(
    String.raw`\b([A-Za-z][\w.-]*)\s+(?=` + DEVICE_ID_CORE + String.raw`)`,
    "gi",
  );
  while ((m = adjacent.exec(text)) !== null) {
    if (isHostName(m[1])) return true;
  }
  return false;
}

/** A candidate token is a host name only if it is not a date, determiner or common verb. */
function isHostName(raw: string): boolean {
  const word = raw.toLowerCase();
  if (MONTH_NAMES.has(word)) return false;
  if (NOT_A_NAME.has(word)) return false;
  return true;
}

/**
 * Does this text cite a device identifier as evidence without naming its
 * host? Pure so the decision is unit-testable without a session.
 */
export function needsHostQualifier(text: string): boolean {
  if (!text || !text.trim()) return false;
  // Per SENTENCE: an interface named in one paragraph and an incident
  // described in another are not the same claim, and ANDing across a whole
  // message makes the conjunction vacuous on any long answer.
  return anySentence(
    text,
    hasDeviceId,
    (s) => RE_EVIDENTIAL.test(s),
    (s) => !hasHostQualifier(s),
  );
}

export const NUDGE_LINE =
  "entity-qualifier-nudge: a device identifier was cited as evidence with no host qualifier. " +
  "eth0/br0/nvme0n1/etc. are not unique across boxes - a fact about one interface can silently " +
  "become an argument about a different one on a different host. Name the box (\"servarr's eth0\", " +
  "\"on nixos\") before drawing a conclusion from it. A date does not qualify - \"on 2026-08-08\" " +
  "says when, not which box. (PI_ENTITY_NUDGE_OFF=1)";

// ── extension ─────────────────────────────────────────────────────────────

type TextBlock = { type?: string; text?: string };

interface State {
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
  if (process.env.PI_ENTITY_NUDGE_OFF === "1") return;

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
      s = { nudged: false };
      states.set(key, s);
    }
    return s;
  };

  pi.on("message_end", async (event, ctx) => {
    // pi -p: the assistant text is the return payload of a subagent or loop
    // iteration. Appending advice there corrupts it.
    if ((ctx as { hasUI?: boolean }).hasUI === false) return undefined;

    const msg = (event as { message?: { role?: string; content?: unknown } }).message;
    if (!msg || msg.role !== "assistant") return undefined;

    const s = stateFor(ctx);
    if (s.nudged) return undefined;

    const text = answerText(msg);
    if (!needsHostQualifier(text)) return undefined;

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
