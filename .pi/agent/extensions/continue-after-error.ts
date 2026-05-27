/**
 * continue-after-error — recovery affordance for provider 401/402/429.
 *
 * Two parts:
 *
 *  1. `after_provider_response` hook detects non-OK provider responses
 *     (401 unauthorized, 402 payment required, 429 rate-limited) and
 *     surfaces a clear notification telling the user what happened and
 *     how to recover. Sets a session-scoped flag so the slash command
 *     knows recovery is appropriate.
 *
 *  2. `/continue` slash command sends a literal "continue" user message
 *     so the agent can pick up from wherever the failed turn left off.
 *     Works whether the failed turn was the very first message (in
 *     which case "continue" prompts the agent to read the existing
 *     conversation and act) or mid-flow (where it cleanly resumes
 *     from the last assistant tool result).
 *
 * Why a slash command and not a keybinding: opencode-zen 401s are a
 * recoverable state — the user typically needs to refresh credits in
 * another tab or rotate to a backup model first. A deliberate
 * `/continue` is what they actually want, not a one-key retry.
 *
 * The state survives extension reload but is reset per session.
 *
 * Disable via `PI_NO_CONTINUE_AFTER_ERROR=1`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DISABLED = process.env.PI_NO_CONTINUE_AFTER_ERROR === "1";

// HTTP statuses we care about. 401 = unauthorized, 402 = payment-required
// (some providers map credits exhaustion here), 429 = rate-limited.
const RECOVERABLE_STATUSES = new Set([401, 402, 429]);

// Session-scoped state. Keyed by session file path so /resume / /fork
// give each branch a clean slate. Module-scope survives across pi
// reloads of THIS extension but resets when pi itself restarts.
type SessionState = {
  lastErrorStatus: number | null;
  lastErrorAt: number;
  lastErrorMessage: string;
};

const sessions = new Map<string, SessionState>();

function stateFor(key: string): SessionState {
  let s = sessions.get(key);
  if (!s) {
    s = { lastErrorStatus: null, lastErrorAt: 0, lastErrorMessage: "" };
    sessions.set(key, s);
  }
  return s;
}

function sessionKey(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionFile?.() ?? "default";
  } catch {
    return "default";
  }
}

function describeStatus(status: number, headers: Record<string, string | undefined>): string {
  switch (status) {
    case 401:
      return "Provider returned 401 (unauthorized). Likely an expired/invalid API key OR opencode-zen credits exhausted.";
    case 402:
      return "Provider returned 402 (payment required). Credits exhausted — top up at the gateway.";
    case 429: {
      const retryAfter = headers["retry-after"] ?? headers["x-ratelimit-reset"];
      const hint = retryAfter ? ` Retry-After: ${retryAfter}s.` : "";
      return `Provider returned 429 (rate-limited).${hint}`;
    }
    default:
      return `Provider returned ${status}.`;
  }
}

// ── extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (DISABLED) return;

  pi.on("after_provider_response", (event, ctx) => {
    const status = (event as { status?: number }).status;
    if (typeof status !== "number") return;
    if (!RECOVERABLE_STATUSES.has(status)) return;

    const headers = (event as { headers?: Record<string, string | undefined> }).headers ?? {};
    const message = describeStatus(status, headers);
    const key = sessionKey(ctx);
    const state = stateFor(key);
    state.lastErrorStatus = status;
    state.lastErrorAt = Date.now();
    state.lastErrorMessage = message;

    if (ctx.hasUI) {
      ctx.ui.notify(`${message} Run /continue to resume after fixing.`, "error");
      ctx.ui.setStatus(
        "continue-after-error",
        `provider ${status} — /continue to resume`,
      );
    }
  });

  // Clear the status on the next agent_start (next user prompt resolves
  // the error implicitly — typing anything counts as the user moving on).
  pi.on("agent_start", (_event, ctx) => {
    const key = sessionKey(ctx);
    const state = sessions.get(key);
    if (!state || state.lastErrorStatus === null) return;

    // Only clear if the error is older than 1 second — same-tick agent_start
    // is the failed turn itself; we want to preserve the status so the user
    // sees it.
    if (Date.now() - state.lastErrorAt < 1000) return;

    state.lastErrorStatus = null;
    state.lastErrorMessage = "";
    if (ctx.hasUI) ctx.ui.setStatus("continue-after-error", "");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    sessions.delete(sessionKey(ctx));
  });

  pi.registerCommand("continue", {
    description: "Resume the agent after a provider 401/402/429 (sends 'continue' as a user message)",
    handler: async (args, ctx) => {
      const key = sessionKey(ctx);
      const state = stateFor(key);

      // Allow the user to provide custom continuation text:
      //   /continue please retry the last tool call
      // Default is the bare "continue" which is enough for most cases.
      const text = args.trim() || "continue";

      // If we never saw an error, the command still works — it's just a
      // generic "wake up" trigger. Warn so the user knows they probably
      // wanted a different command.
      if (state.lastErrorStatus === null && ctx.hasUI) {
        ctx.ui.notify(
          "No recent provider error recorded — /continue still fires, but you may have wanted a different command.",
          "warning",
        );
      }

      // Clear state BEFORE sending so the agent_start handler doesn't
      // immediately stomp the status (and so a second 401 on retry shows
      // up cleanly).
      state.lastErrorStatus = null;
      state.lastErrorMessage = "";
      if (ctx.hasUI) ctx.ui.setStatus("continue-after-error", "");

      try {
        await pi.sendUserMessage(text);
      } catch (err) {
        // sendUserMessage throws if pi is mid-stream without deliverAs.
        // Try again with deliverAs:"steer" — the user intent is clear.
        try {
          await pi.sendUserMessage(text, { deliverAs: "steer" });
        } catch (err2) {
          if (ctx.hasUI) {
            const msg = err2 instanceof Error ? err2.message : String(err2);
            ctx.ui.notify(`/continue failed: ${msg}`, "error");
          }
        }
      }
    },
  });
}
