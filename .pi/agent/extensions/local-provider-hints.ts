/**
 * local-provider-hints - name the culprit when a LOCAL provider refuses the
 * connection, instead of leaving the user with bare "Connection error."
 *
 * Observed 2026-08-26: the llm-compose proxy (model_proxy_go) had been dead
 * for ~12h after a container-init failure (exit 127, stale Docker Desktop
 * bind-mount on /volumes.toml). A prompt against the llama-server provider
 * rendered:
 *
 *     Error: Connection error.            (x4, ~1.3s each)
 *     Error: Retry failed after 3 attempts: Connection error.
 *
 * Nothing named the provider, the URL, or the fact that a local container was
 * simply not running - and retrying a refused TCP connection cannot help.
 *
 * Why not continue-after-error.ts: that hooks `after_provider_response`, which
 * requires an HTTP response. A refused connection has none. Verified with a
 * probe extension (2026-08-26, pi 0.84.3): on connection-refused ONLY
 * `message_end` / `agent_end` / `agent_settled` fire, and the message carries
 * `stopReason: "error"` with the error text; on success
 * `after_provider_response` fires with status=200. So this extension watches
 * `message_end`.
 *
 * Behaviour: notify (UI) once per session per provider, and log to stderr in
 * headless runs so `pi -p` output isn't silently useless. Advisory only -
 * never blocks, never mutates the conversation.
 *
 * Kill switch: PI_NO_LOCAL_PROVIDER_HINTS=1
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildHint, probeLocalProvider } from "./lib/local-provider-hints-core.ts";

// Re-export for the unit suite.
export { buildHint, isConnectionError, isLocalProvider, probeLocalProvider, HINT_MARKER } from "./lib/local-provider-hints-core.ts";

function errorTextOf(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as { stopReason?: string; error?: unknown; errorMessage?: unknown };
  if (m.stopReason !== "error") return "";
  const raw = m.error ?? m.errorMessage ?? "";
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "message" in raw) {
    const inner = (raw as { message?: unknown }).message;
    return typeof inner === "string" ? inner : "";
  }
  return "";
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_NO_LOCAL_PROVIDER_HINTS === "1") return;

  // One notify per provider per session - the retry loop repeats the error.
  const warned = new Set<string>();

  pi.on("message_end", async (event, ctx) => {
    const text = errorTextOf((event as { message?: unknown }).message);
    if (!text) return;

    // ctx.model getters can throw on a stale ctx after a session reload
    // (same hazard local-model-rules.ts guards). Skip rather than crash.
    let provider = "";
    let baseUrl: string | undefined;
    try {
      const model = (ctx as { model?: { provider?: string; baseUrl?: string } }).model;
      provider = model?.provider ?? "";
      baseUrl = model?.baseUrl;
    } catch {
      return;
    }
    if (!provider) return;

    // Probe to distinguish boot race (alive now) from genuinely dead.
    const probeResult = await probeLocalProvider({ provider, baseUrl });

    const hint = buildHint(text, { provider, baseUrl }, probeResult);
    if (!hint) return;

    // Boot race: the service refused earlier but is alive now.
    // Show the hint and auto-retry via a queued follow-up message.
    // The original user prompt is already in the session, so "continue"
    // tells the agent to pick up from the failed turn.
    if (probeResult === "alive") {
      if (!warned.has(provider)) {
        warned.add(provider);
        try {
          if (ctx.hasUI) {
            ctx.ui.notify(hint, "info");
          }
        } catch {
          // fall through
        }
        console.error(hint);
        pi.sendUserMessage("continue");
      }
      return;
    }

    // Genuinely dead - same behaviour as before.
    if (warned.has(provider)) return;
    warned.add(provider);

    try {
      if (ctx.hasUI) {
        ctx.ui.notify(hint, "error");
        return;
      }
    } catch {
      // fall through to stderr
    }
    // Headless: stderr is the only surface the operator will see.
    console.error(hint);
  });

  pi.on("session_shutdown", async (_event: unknown, _ctx: ExtensionContext) => {
    warned.clear();
  });
}
