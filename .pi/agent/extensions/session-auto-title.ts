/**
 * session-auto-title — auto-generate session names via LLM after first user
 * message (opencode parity / improvement).
 *
 * Opencode runs a dedicated "title" agent after the first real user message
 * lands. Pi has only the manual `/session-name <name>` command. Without
 * auto-naming, sessions appear in the picker as their first message
 * truncated — noisy when the first message is short ("yes", "continue",
 * "see screenshot").
 *
 * This extension:
 *   1. Hooks `agent_end` (fires once per user prompt).
 *   2. On the FIRST agent_end of a session, checks for our marker entry.
 *      If absent, generates a title from the first user message.
 *   3. Picks a small/cheap model from the registry. Tries (in order):
 *      anthropic/claude-haiku-* → openai/gpt-5-mini → current session
 *      model as fallback.
 *   4. Asks the model: "Generate a 3-6 word title". Strips quotes.
 *   5. Calls pi.setSessionName(title) and records a marker via
 *      pi.appendEntry so we never re-name (manual /session-name wins).
 *
 * To disable: rename file to .ts.disabled or comment out the registration.
 */

import { complete, getModel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MARKER_TYPE = "session-auto-title";
const MAX_INPUT_CHARS = 4000;
const MAX_TITLE_WORDS = 8;

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

function cleanTitle(raw: string): string {
  let t = raw.trim();
  // Strip surrounding quotes (single or double, possibly with whitespace)
  t = t.replace(/^["'`\s]+|["'`\s]+$/g, "");
  // Strip leading "Title: " / "title - " / similar
  t = t.replace(/^(?:title|name|topic)\s*[-:]\s*/i, "");
  // Collapse whitespace
  t = t.replace(/\s+/g, " ");
  // Take only first line (model sometimes adds explanation)
  t = t.split("\n")[0].trim();
  // Cap word count
  const words = t.split(/\s+/);
  if (words.length > MAX_TITLE_WORDS) t = words.slice(0, MAX_TITLE_WORDS).join(" ");
  // Drop trailing period
  t = t.replace(/\.$/, "");
  return t;
}

// Try to find a small/cheap model. Returns undefined if no auth available.
//
// Discovery strategy (handles user's models.json changing over time without
// hardcoded IDs going stale — prior version hard-coded model IDs that the
// user never had):
//
//   1. Read ~/.pi/agent/models.json directly to enumerate all configured
//      provider/model pairs.
//   2. Score each by 'smallness heuristic' — prefer local llama-server,
//      then haiku/mini/flash/nano name patterns, then anything else.
//   3. Try each in priority order. First one with valid auth wins.
//   4. Fall back to current session model only if no small model found.
async function pickTitleModel(ctx: ExtensionContext) {
  // Pattern → priority weight (lower = better)
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

  type Candidate = { provider: string; id: string; weight: number };
  const candidates: Candidate[] = [];
  try {
    const path = join(process.env.HOME ?? "", ".pi", "agent", "models.json");
    const data = JSON.parse(readFileSync(path, "utf8")) as {
      providers?: Record<string, { models?: Array<{ id?: string }> }>;
    };
    for (const [prov, pd] of Object.entries(data.providers ?? {})) {
      for (const m of pd.models ?? []) {
        if (!m.id) continue;
        candidates.push({ provider: prov, id: m.id, weight: weightOf(prov, m.id) });
      }
    }
  } catch {
    // No models.json or unreadable — fall through to current-model fallback
  }
  candidates.sort((a, b) => a.weight - b.weight);

  for (const c of candidates) {
    const m = getModel(c.provider, c.id);
    if (!m) continue;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
    if (auth?.ok && auth.apiKey) return { model: m, auth };
  }
  // Last resort: current session model (heavyweight, but always works)
  const current = (ctx as { model?: { id: string; provider: string } }).model;
  if (current) {
    const m = getModel(current.provider, current.id);
    if (m) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
      if (auth?.ok && auth.apiKey) return { model: m, auth };
    }
  }
  return undefined;
}

async function alreadyAutoTitled(ctx: ExtensionContext): Promise<boolean> {
  // Walk current branch entries; if we see our marker, skip
  try {
    const entries = ctx.sessionManager.getBranch();
    for (const e of entries) {
      if (e.type === "custom" && (e as { customType?: string }).customType === MARKER_TYPE) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (event, ctx) => {
    // Only act on the very first user-prompt agent_end
    // Sessions can branch; only auto-title the root session
    if (await alreadyAutoTitled(ctx)) return;

    // event.messages contains the messages from THIS prompt — find the user message
    const messages = (event as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
    const userMsg = messages.find((m) => m.role === "user");
    if (!userMsg) return;
    const userText = extractText(userMsg.content).trim();
    if (!userText) return;

    const picked = await pickTitleModel(ctx);
    if (!picked) {
      // Mark as attempted even when we couldn't run — avoid repeated retries
      pi.appendEntry(MARKER_TYPE, { skipped: "no-model", at: Date.now() });
      return;
    }

    const userExcerpt = userText.length > MAX_INPUT_CHARS
      ? userText.slice(0, MAX_INPUT_CHARS) + "\n[... truncated]"
      : userText;

    try {
      const response = await complete(
        picked.model,
        {
          messages: [
            {
              role: "user",
              content:
                "Generate a 3-6 word title summarising this conversation request. " +
                "Use plain text (no quotes, no markdown, no period at the end). " +
                "Title only — no explanation.\n\n" +
                "---\n" +
                userExcerpt,
            },
          ],
        },
        {
          apiKey: picked.auth.apiKey,
          headers: picked.auth.headers,
        },
      );

      const rawTitle = response.content
        .filter((c: { type: string }): c is { type: "text"; text: string } => c.type === "text")
        .map((c: { text: string }) => c.text)
        .join("\n");

      const title = cleanTitle(rawTitle);
      if (!title || title.length < 2) {
        pi.appendEntry(MARKER_TYPE, { skipped: "empty-response", at: Date.now() });
        return;
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
        model: `${picked.model.providerID ?? picked.model.provider}/${picked.model.id}`,
        at: Date.now(),
      });
    } catch (err) {
      pi.appendEntry(MARKER_TYPE, { error: (err as Error).message, at: Date.now() });
    }
  });
}
