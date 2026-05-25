/**
 * local-model-rules — model-aware system prompt injection for local models.
 *
 * When the active model is from the llm-compose proxy (gemma, qwen families
 * via llama-server provider), prepend the local-model-specific rules from
 * `~/.pi/agent/prompts/local-model-rules.md`. These rules correct for common
 * local-model quirks:
 *
 * - LaTeX emission (Gemma especially loves `\$`, `\rightarrow`, `\frac`)
 * - Under-batching of tool calls (sequential when they could be parallel)
 * - Reasoning loops on retry
 * - Tool selection confusion (bash vs native tools)
 *
 * The opencode fork applied this via per-model gemma.txt prompt routing in
 * packages/opencode/src/session/system.ts. In Pi the equivalent is hooking
 * the `context` event and conditionally prepending a system message based
 * on `ctx.model`.
 *
 * Model family detection — applies when:
 *   - provider === "llama-server" (our custom proxy provider), OR
 *   - model id matches /gemma|qwen/i (covers cases where the same model is
 *     used through a different provider, e.g. Anthropic / OpenAI inference
 *     of an open-weight via API).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const RULES_PATH = join(homedir(), ".pi/agent/prompts/local-model-rules.md");
const MARKER = "<!-- local-model-rules-injected -->";

let cachedRules: string | null | undefined = undefined;

function loadRules(): string | null {
  if (cachedRules !== undefined) return cachedRules;
  if (!existsSync(RULES_PATH)) {
    cachedRules = null;
    return null;
  }
  try {
    const body = readFileSync(RULES_PATH, "utf-8");
    cachedRules = `${MARKER}\n${body.trim()}`;
  } catch {
    cachedRules = null;
  }
  return cachedRules;
}

function shouldApply(provider: string, modelId: string): boolean {
  if (provider === "llama-server") return true;
  if (/gemma|qwen/i.test(modelId)) return true;
  return false;
}

type PiMessage = { role: string; content: unknown };

export default function (pi: ExtensionAPI) {
  pi.on("context", async (event, ctx) => {
    const messages = (event as { messages: PiMessage[] }).messages;
    if (!messages?.length) return undefined;

    // Pi exposes ctx.model as a getter that calls into the active session.
    // After a session reload (/reload, /resume, switchSession, fork) the
    // ctx captured by pi's event dispatcher can be stale, and accessing
    // .model throws an `assertActive` error
    // (see opencode-fork ctx lifecycle: a getter on the captured ctx may
    // outlive the session it was captured against). Guard the access so
    // a stale-ctx call doesn't crash the extension — we just skip the
    // injection on this turn; the next event call gets a fresh ctx.
    let provider = "";
    let modelId = "";
    try {
      const model = (ctx as { model?: { id?: string; provider?: string } }).model;
      if (!model) return undefined;
      provider = model.provider ?? "";
      modelId = model.id ?? "";
    } catch {
      return undefined;
    }

    if (!shouldApply(provider, modelId)) return undefined;

    const rules = loadRules();
    if (!rules) return undefined;

    // Idempotency
    const alreadyInjected = messages.some((m) => {
      if (m.role !== "system") return false;
      const c = m.content;
      return typeof c === "string" && c.includes(MARKER);
    });
    if (alreadyInjected) return undefined;

    return { messages: [{ role: "system" as const, content: rules }, ...messages] };
  });
}
