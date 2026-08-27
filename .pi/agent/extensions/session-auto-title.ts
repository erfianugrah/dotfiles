/**
 * session-auto-title - auto-generate session names via LLM after first user
 * message (opencode parity / improvement).
 *
 * Opencode runs a dedicated "title" agent after the first real user message
 * lands. Pi has only the manual `/session-name <name>` command. Without
 * auto-naming, sessions appear in the picker as their first message
 * truncated - noisy when the first message is short ("yes", "continue",
 * "see screenshot").
 *
 * This extension:
 *   1. Hooks `agent_end` (fires once per user prompt).
 *   2. Walks branch entries for our marker. A success marker (or a
 *      manual-name marker) is terminal. A FAILURE marker records the
 *      attempt count - we retry on later agent_ends until MAX_ATTEMPTS,
 *      because failures are usually transient (empty completion from the
 *      cheap model, momentary auth hiccup) and the old behaviour of
 *      tombstoning on first failure permanently locked sessions out of
 *      ever getting a title.
 *   3. Builds the candidate list with the CURRENT SESSION MODEL FIRST
 *      (2026-08-25: local llama-server candidates fail whenever the GPU
 *      stack is busy or mode-swapped), then up to 3 cheap fallbacks from
 *      models.json - an empty response or error falls through to the next
 *      candidate instead of giving up.
 *   4. Asks the model: "Generate a 3-6 word title". Strips quotes.
 *   5. Calls pi.setSessionName(title) and records a success marker via
 *      pi.appendEntry so we never re-name (manual /session-name wins).
 *
 * To disable: rename file to .ts.disabled or comment out the registration.
 */

// Model discovery goes through ctx.modelRegistry.getAvailable() (see
// pickTitleCandidates) - NOT pi-ai's getModel() + models.json, which could
// not see custom providers and produced zero candidates. No pi-ai import and
// no models.json read is needed here any more.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MARKER_TYPE = "session-auto-title";
const MAX_INPUT_CHARS = 4000;
const MAX_TITLE_WORDS = 8;
// Total failed attempts across the session before we stop retrying.
const MAX_ATTEMPTS = 3;
// Cap on how many FALLBACK candidates we authenticate per trigger (the
// current session model is tried first and does not count against this).
const MAX_FALLBACKS = 3;

type ContentBlock = { type?: string; text?: string };

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const b = c as ContentBlock;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (typeof b === "string") parts.push(b as unknown as string);
  }
  return parts.join("\n");
}

export function cleanTitle(raw: string): string {
  let t = raw.trim();
  // Strip surrounding quotes (single or double, possibly with whitespace)
  t = t.replace(/^["'`\s]+|["'`\s]+$/g, "");
  // Strip leading "Title: " / "title - " / similar
  t = t.replace(/^(?:title|name|topic)\s*[-:]\s*/i, "");
  // Take only first line (model sometimes adds explanation)
  t = t.split("\n")[0].trim();
  // Collapse whitespace
  t = t.replace(/\s+/g, " ");
  // Cap word count
  const words = t.split(/\s+/);
  if (words.length > MAX_TITLE_WORDS) t = words.slice(0, MAX_TITLE_WORDS).join(" ");
  // Drop trailing period
  t = t.replace(/\.$/, "");
  return t;
}

// Marker payload shapes we write. Anything that isn't a success or
// manual-name skip counts as a failed (retryable) attempt - this also
// covers the legacy `skipped: "no-model" | "empty-response"` and
// `{error}` markers written by the pre-retry version, so sessions
// tombstoned by that bug get retried instead of staying nameless forever.
export type MarkerData = {
  title?: string;
  skipped?: string;
  failed?: boolean;
  attempts?: number;
  error?: string;
};

export type TitleState =
  | { kind: "done" } // success or manual name: never touch again
  | { kind: "retry"; attempts: number }; // failed before; attempts so far

export function markerState(markers: MarkerData[]): TitleState {
  let attempts = 0;
  for (const m of markers) {
    if (m.title || m.skipped === "manual-name-set") return { kind: "done" };
    attempts++;
  }
  return { kind: "retry", attempts };
}

// First user message on the branch - the stable title source regardless of
// which turn the attempt fires on.
function firstUserText(ctx: ExtensionContext): string {
  try {
    const entries = ctx.sessionManager.getBranch();
    for (const e of entries) {
      if (e.type !== "message") continue;
      const m = (e as { message?: { role?: string; content?: unknown } }).message;
      if (m?.role !== "user") continue;
      const t = extractText(m.content).trim();
      if (t) return t;
    }
  } catch {
    /* ignore */
  }
  return "";
}

function getMarkerState(ctx: ExtensionContext): TitleState {
  const markers: MarkerData[] = [];
  try {
    const entries = ctx.sessionManager.getBranch();
    for (const e of entries) {
      if (e.type !== "custom") continue;
      const c = e as { customType?: string; data?: unknown };
      if (c.customType === MARKER_TYPE) markers.push((c.data ?? {}) as MarkerData);
    }
  } catch {
    /* ignore */
  }
  return markerState(markers);
}

// Ordered small/cheap model candidates. Returns ALL authenticated
// candidates (capped), not just the first - the caller tries each in
// turn, so one model returning an empty response doesn't sink the title.
//
// Discovery strategy (handles user's models.json changing over time without
// hardcoded IDs going stale - prior version hard-coded model IDs that the
// user never had):
//
//   1. Enumerate ctx.modelRegistry.getAvailable() - every model with working
//      credentials, custom providers included.
//   2. Score each by 'smallness heuristic' - prefer local llama-server,
//      then haiku/mini/flash/nano name patterns, then anything else.
//   3. Keep the current session model first, then the cheapest fallbacks.
//
// 2026-08-26: do NOT go back to enumerating models.json + pi-ai getModel().
// That combination silently produced ZERO candidates (marker
// reason:"no-model") for every session whose model was a custom provider:
//   - getModel("llama-server", "qwen38") returns UNDEFINED - pi-ai's getModel
//     only knows its BUILT-IN catalogue, not user-defined providers, so all
//     10 llama-server entries were dropped at the `if (!m) continue` guard.
//   - providers.openrouter in models.json carries only modelOverrides (0
//     entries in `models`), so the cloud fallbacks were never enumerated
//     either - the real openrouter catalogue comes from pi's builtin list.
// Net effect: 627 untitled sessions in 2026-08 alone. getAvailable() returns
// resolved model objects for BOTH custom and builtin providers (verified: 572
// models, including all 10 llama-server ids), so no getModel() lookup is
// needed - and auth is already proven by getAvailable()'s own filtering.
export async function pickTitleCandidates(ctx: ExtensionContext) {
  // Pattern -> priority weight (lower = better)
  const PROVIDER_WEIGHTS: Array<[RegExp, number]> = [
    [/llama-server|ollama|lmstudio|vllm/i, 0],   // local & free
    [/anthropic/i, 30],
    [/openai/i, 30],
    [/google/i, 30],
    [/.+/, 50],                                   // anything else
  ];
  const NAME_WEIGHTS: Array<[RegExp, number]> = [
    [/haiku/i, 0],
    [/mini|nano|micro|small/i, 5],
    [/flash|turbo/i, 10],
    [/gemma|qwen.*(?:3|4)|phi|llama-?3.*8b|llama-?3.*1b|llama-?3.*3b/i, 15],
    [/.+/, 100],
  ];

  function weightOf(provider: string, id: string): number {
    let pw = 99;
    for (const [re, w] of PROVIDER_WEIGHTS) if (re.test(provider)) { pw = w; break; }
    let nw = 99;
    for (const [re, w] of NAME_WEIGHTS) if (re.test(id)) { nw = w; break; }
    return pw + nw;
  }

  type AnyModel = { id: string; provider?: string; providerID?: string };
  type Picked = { model: AnyModel };

  const provOf = (m: AnyModel) => m.provider ?? m.providerID ?? "";
  const sameModel = (a: AnyModel, b: AnyModel) =>
    a.id === b.id && provOf(a) === provOf(b);

  // Every model with working credentials - custom providers included.
  let available: AnyModel[] = [];
  try {
    available = (await ctx.modelRegistry.getAvailable()) as AnyModel[];
  } catch {
    available = [];
  }

  // Current session model FIRST (user directive 2026-08-25: same session, not
  // the local model - all-local candidate lists tombstoned most of the
  // 2026-08-25 sessions with empty-response when llama-server was busy or
  // GPU-mode-swapped). It just served this turn, so it is authenticated,
  // reachable, and not mid-swap.
  const picked: Picked[] = [];
  const current = (ctx as { model?: AnyModel }).model;
  if (current?.id) {
    // Prefer the registry's own object for the current model; fall back to
    // ctx.model itself (it just served a turn, so it is usable as-is).
    const m = available.find((a) => sameModel(a, current)) ?? current;
    picked.push({ model: m });
  }

  // Cheap fallbacks: for heavyweight current models or a failing endpoint.
  const ranked = available
    .filter((m) => m.id)
    .map((m) => ({ model: m, weight: weightOf(provOf(m), m.id) }))
    .sort((a, b) => a.weight - b.weight);

  for (const c of ranked) {
    if (picked.length >= 1 + MAX_FALLBACKS) break;
    if (picked.some((p) => sameModel(p.model, c.model))) continue;
    picked.push({ model: c.model });
  }
  return picked;
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (event, ctx) => {
    const state = getMarkerState(ctx);
    if (state.kind === "done") return;
    if (state.attempts >= MAX_ATTEMPTS) return;

    // Title from the session's FIRST user message, not the current turn's -
    // on a retry the current message is often a low-signal "ok"/"continue"
    // (observed: retro-titled a resumed session "Short headline for next
    // conversation" because the resume prompt was "ok").
    let userText = firstUserText(ctx);
    if (!userText) {
      const messages = (event as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
      const userMsg = messages.find((m) => m.role === "user");
      if (userMsg) userText = extractText(userMsg.content).trim();
    }
    if (!userText) return;

    const candidates = await pickTitleCandidates(ctx);
    if (candidates.length === 0) {
      pi.appendEntry(MARKER_TYPE, { failed: true, reason: "no-model", attempts: state.attempts + 1, at: Date.now() });
      return;
    }

    const userExcerpt = userText.length > MAX_INPUT_CHARS
      ? userText.slice(0, MAX_INPUT_CHARS) + "\n[... truncated]"
      : userText;

    const prompt =
      "Generate a 3-6 word title summarising this conversation request. " +
      "Use plain text (no quotes, no markdown, no period at the end). " +
      "Title only - no explanation.\n\n" +
      "---\n" +
      userExcerpt;

    // Try each candidate in turn; empty response or error falls through.
    let lastError = "empty-response";
    for (const c of candidates) {
      let title = "";
      try {
        // Runtime-dispatched complete (auth resolution + credential-resolved
        // endpoints owned by the model runtime since 0.84.0).
        const response = await ctx.modelRegistry.complete(
          c.model,
          { messages: [{ role: "user", content: prompt }] },
          { cacheRetention: "none" },
        );
        const rawTitle = response.content
          .filter((b: { type: string }): b is { type: "text"; text: string } => b.type === "text")
          .map((b: { text: string }) => b.text)
          .join("\n");
        title = cleanTitle(rawTitle);
      } catch (err) {
        lastError = (err as Error).message || "error";
        continue;
      }
      if (!title || title.length < 2) {
        lastError = "empty-response";
        continue;
      }

      // Don't override an existing manual name (user may have run /session-name first)
      const existing = pi.getSessionName();
      const looksManual = existing && !existing.startsWith(userText.slice(0, 30));
      if (looksManual) {
        pi.appendEntry(MARKER_TYPE, { skipped: "manual-name-set", existing, at: Date.now() });
        return;
      }

      pi.setSessionName(title);
      pi.appendEntry(MARKER_TYPE, {
        title,
        model: `${c.model.providerID ?? c.model.provider}/${c.model.id}`,
        at: Date.now(),
      });
      return;
    }

    // Every candidate failed - record a retryable failure marker.
    pi.appendEntry(MARKER_TYPE, { failed: true, reason: lastError, attempts: state.attempts + 1, at: Date.now() });
  });
}
