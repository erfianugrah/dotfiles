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
 *   3. Builds an ordered list of small/cheap authenticated candidate
 *      models from models.json (local llama-server first, then
 *      haiku/mini/flash name patterns, current session model last) and
 *      tries each in turn - an empty response or error falls through to
 *      the next candidate instead of giving up.
 *   4. Asks the model: "Generate a 3-6 word title". Strips quotes.
 *   5. Calls pi.setSessionName(title) and records a success marker via
 *      pi.appendEntry so we never re-name (manual /session-name wins).
 *
 * To disable: rename file to .ts.disabled or comment out the registration.
 */

// Root import, not /compat: the loader aliases root -> compat since 0.80.0,
// and the explicit /compat subpath fails to resolve in the Homebrew Mac
// build (crashes pi at launch). Root resolves on both platforms.
import { getModel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// models.json doesn't change at runtime (the user edits it, then /reload).
// Cache the parsed candidates list keyed by mtime so we don't re-read +
// re-parse on every session_start. Negligible on its own, but cheap to do.
let modelsCache: { mtimeMs: number; data: unknown } | null = null;
function loadModelsJson(): unknown {
  const path = join(process.env.HOME ?? "", ".pi", "agent", "models.json");
  try {
    const st = statSync(path);
    if (modelsCache && modelsCache.mtimeMs === st.mtimeMs) return modelsCache.data;
    const data = JSON.parse(readFileSync(path, "utf8"));
    modelsCache = { mtimeMs: st.mtimeMs, data };
    return data;
  } catch {
    return null;
  }
}

const MARKER_TYPE = "session-auto-title";
const MAX_INPUT_CHARS = 4000;
const MAX_TITLE_WORDS = 8;
// Total failed attempts across the session before we stop retrying.
const MAX_ATTEMPTS = 3;
// Cap on how many candidate models we authenticate per trigger.
const MAX_CANDIDATES = 4;

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
//   1. Read ~/.pi/agent/models.json directly to enumerate all configured
//      provider/model pairs.
//   2. Score each by 'smallness heuristic' - prefer local llama-server,
//      then haiku/mini/flash/nano name patterns, then anything else.
//   3. Authenticate each in priority order, keep the first MAX_CANDIDATES.
//   4. Append the current session model as last resort (heavyweight, but
//      always works).
async function pickTitleCandidates(ctx: ExtensionContext) {
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

  type Model = NonNullable<ReturnType<typeof getModel>>;
  type Picked = { model: Model; auth: unknown };

  const candidates: Array<{ provider: string; id: string; weight: number }> = [];
  const data = loadModelsJson() as
    | { providers?: Record<string, { models?: Array<{ id?: string }> }> }
    | null;
  if (data) {
    for (const [prov, pd] of Object.entries(data.providers ?? {})) {
      for (const m of pd.models ?? []) {
        if (!m.id) continue;
        candidates.push({ provider: prov, id: m.id, weight: weightOf(prov, m.id) });
      }
    }
  }
  candidates.sort((a, b) => a.weight - b.weight);

  const picked: Picked[] = [];
  for (const c of candidates) {
    if (picked.length >= MAX_CANDIDATES) break;
    const m = getModel(c.provider, c.id);
    if (!m) continue;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
    if (auth?.ok && auth.apiKey) picked.push({ model: m, auth });
  }

  // Last resort: current session model (heavyweight, but always works)
  const current = (ctx as { model?: { id: string; provider: string } }).model;
  if (current) {
    const m = getModel(current.provider, current.id);
    if (m && !picked.some((p) => p.model.id === m.id && p.model.provider === m.provider)) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
      if (auth?.ok && auth.apiKey) picked.push({ model: m, auth });
    }
  }
  return picked;
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (event, ctx) => {
    const state = getMarkerState(ctx);
    if (state.kind === "done") return;
    if (state.attempts >= MAX_ATTEMPTS) return;

    // event.messages contains the messages from THIS prompt - find the user message
    const messages = (event as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
    const userMsg = messages.find((m) => m.role === "user");
    if (!userMsg) return;
    const userText = extractText(userMsg.content).trim();
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
