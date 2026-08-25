/**
 * local-model-rules - model-aware system prompt injection for local models.
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
 * Mechanism (fixed 2026-08-25): `before_agent_start` -> systemPrompt prepend,
 * the same pattern tool-routing.ts uses (proven to reach the model). The
 * previous implementation returned a `{role:"system"}` message from the
 * `context` event - but pi's AgentMessage union has no system role, so the
 * message was SILENTLY DROPPED before the provider request (empirically
 * verified 2026-08-25 via a probe extension; local-model rules likely never
 * reached the model at all in any session).
 *
 * Model family detection - applies when:
 *   - provider === "llama-server" (our custom proxy provider), OR
 *   - model id matches /gemma|qwen/i (covers cases where the same model is
 *     used through a different provider, e.g. Anthropic / OpenAI inference
 *     of an open-weight via API).
 *   - PI_LOCAL_MODEL_RULES_FORCE=1 forces injection regardless (testing).
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
  if (process.env.PI_LOCAL_MODEL_RULES_FORCE === "1") return true;
  if (provider === "llama-server") return true;
  if (/gemma|qwen/i.test(modelId)) return true;
  return false;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    // Idempotency: earlier before_agent_start handlers chain the system
    // prompt, so check what we've been handed before prepending.
    if (event.systemPrompt.includes(MARKER)) return undefined;

    // Pi exposes ctx.model as a getter that calls into the active session.
    // After a session reload (/reload, /resume, switchSession, fork) the
    // ctx captured by pi's event dispatcher can be stale, and accessing
    // .model throws an `assertActive` error
    // (see opencode-fork ctx lifecycle: a getter on the captured ctx may
    // outlive the session it was captured against). Guard the access so
    // a stale-ctx call doesn't crash the extension - we just skip the
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

    return { systemPrompt: `${rules}\n\n${event.systemPrompt}` };
  });
}
