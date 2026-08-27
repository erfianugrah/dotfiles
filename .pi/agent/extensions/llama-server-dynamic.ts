/**
 * llama-server-dynamic - keep pi's local-model list in sync with the live
 * llm-compose proxy, instead of the hand-maintained static list in
 * `models.json`.
 *
 * Problem (2026-08-27): the static `providers["llama-server"].models` array
 * drifted - 6 deleted presets (qwen3, qwen3-coder, qwen3-vl, qwen36*),
 * stale context windows (qwen38 listed at 196608 while the preset is 262144),
 * and 6 missing presets. Hand-editing that list is a recurring chore.
 *
 * Fix: pi supports dynamic model discovery via an async extension factory
 * (see docs/custom-provider.md). The llm-compose proxy already serves
 * `GET /v1/models` with per-preset metadata: `meta.preset` (the human key),
 * `meta.name`, `meta.context`, `meta.reasoning`, `meta.capabilities.vision`.
 * This extension fetches that on startup and registers the provider with the
 * LIVE list - so preset adds/removes/context changes propagate with zero
 * manual edits.
 *
 * Fallback: if the proxy is down or the fetch fails, the extension does
 * nothing and the (corrected) static list in models.json stands. So the
 * status-bar context window is never left blank, just possibly stale.
 *
 * Kill switch: PI_NO_LLAMA_SERVER_DYNAMIC=1
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = "http://127.0.0.1:11434/v1";
const FETCH_TIMEOUT_MS = 3000;

type ProxyModel = {
  id: string;
  meta?: {
    alias?: boolean;
    preset?: string;
    name?: string;
    context?: number;
    reasoning?: boolean;
    capabilities?: { vision?: boolean };
  };
};

export default async function (pi: ExtensionAPI) {
  if (process.env.PI_NO_LLAMA_SERVER_DYNAMIC === "1") return;

  let payload: { data: ProxyModel[] };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const resp = await fetch(`${BASE_URL}/models`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return; // proxy down/erroring - keep the static list
    payload = (await resp.json()) as { data: ProxyModel[] };
  } catch {
    return; // connection refused / timeout - keep the static list
  }

  const models = payload.data
    .filter((m) => !m.meta?.alias)
    .map((m) => {
      const meta = m.meta ?? {};
      const vision = meta.capabilities?.vision === true;
      return {
        id: meta.preset ?? m.id,
        name: meta.name ?? meta.preset ?? m.id,
        reasoning: meta.reasoning === true,
        input: vision ? ["text", "image"] : ["text"],
        contextWindow: meta.context ?? 128000,
        // The proxy does not expose a per-preset max-output-tokens field
        // (llama-server defaults n_predict=-1). pi's own default is 16384;
        // the static list relied on it, but registerProvider does NOT apply
        // the default (omitting maxTokens makes `pi --list-models` crash in
        // formatTokenCount). Pin it to pi's default to match old behavior.
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    });

  if (models.length === 0) return;

  // Registering with `models` REPLACES the static list in models.json.
  // The provider-level settings (baseUrl/api/apiKey/compat) must be
  // re-declared here since registerProvider is a full replace.
  pi.registerProvider("llama-server", {
    baseUrl: BASE_URL,
    api: "openai-completions",
    apiKey: "llmc",
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
      thinkingTokenBudgetField: "thinking_budget_tokens",
    },
    models,
  });
}
