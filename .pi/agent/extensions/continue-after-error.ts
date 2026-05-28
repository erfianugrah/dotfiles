/**
 * continue-after-error — recovery affordance for provider 401/402/429.
 *
 * Three parts:
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
 *  3. The error state is STICKY — only cleared on the next 2xx from
 *     after_provider_response, by /continue or /model invocation, or
 *     on session_shutdown. The previous version cleared on agent_start
 *     after a 1-second guard, which raced badly: the failed-turn's own
 *     agent_start was within 1s so it got preserved, but a subsequent
 *     /continue would fire agent_start AGAIN >1s later and stomp the
 *     state, then the retry's 401 would fire too late for the slash
 *     command to see it (visible to the user as the stale "no recent
 *     provider error recorded" warning even when the screen literally
 *     shows the 401 body two lines above).
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
  /** how many same-status errors we've seen in a row (for "switch model" suggestion) */
  consecutiveSameStatus: number;
};

const sessions = new Map<string, SessionState>();

function stateFor(key: string): SessionState {
  let s = sessions.get(key);
  if (!s) {
    s = {
      lastErrorStatus: null,
      lastErrorAt: 0,
      lastErrorMessage: "",
      consecutiveSameStatus: 0,
    };
    sessions.set(key, s);
  }
  return s;
}

function clearState(key: string, ctx: ExtensionContext) {
  const s = sessions.get(key);
  if (!s || s.lastErrorStatus === null) return;
  s.lastErrorStatus = null;
  s.lastErrorMessage = "";
  s.consecutiveSameStatus = 0;
  if (ctx.hasUI) ctx.ui.setStatus("continue-after-error", "");
}

function sessionKey(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionFile?.() ?? "default";
  } catch {
    return "default";
  }
}

function describeStatus(
  status: number,
  headers: Record<string, string | undefined>,
  consecutive: number,
): { headline: string; suggest: string } {
  // After 2 consecutive same-status errors, the gateway/provider almost
  // certainly won't recover by itself — push the user toward /model rather
  // than another /continue.
  const switchHint = consecutive >= 2
    ? " — RETRY ALREADY FAILED, use /model to switch providers (Anthropic / OpenAI / local llama-server) before /continue"
    : "";

  switch (status) {
    case 401:
      return {
        headline: "Provider 401 (unauthorized).",
        suggest:
          "Likely opencode-zen credits exhausted (CreditsError body) OR an expired/invalid API key. " +
          "Top up at https://opencode.ai/billing OR rotate the key in ~/.pi/agent/auth.json, then /continue. " +
          "If credits stay 0 and you need to keep working, /model to swap to a non-opencode-zen provider" +
          switchHint,
      };
    case 402:
      return {
        headline: "Provider 402 (payment required).",
        suggest:
          "Credits exhausted. Top up at the gateway OR /model to switch providers" + switchHint,
      };
    case 429: {
      const retryAfter = headers["retry-after"] ?? headers["x-ratelimit-reset"];
      const hint = retryAfter ? ` Retry-After: ${retryAfter}s.` : "";
      return {
        headline: `Provider 429 (rate-limited).${hint}`,
        suggest:
          "Wait the Retry-After window then /continue, OR /model to switch providers if rate-limit is structural" +
          switchHint,
      };
    }
    default:
      return {
        headline: `Provider ${status}.`,
        suggest: "Check the provider's billing/auth, then /continue, or /model to switch.",
      };
  }
}

// ── extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (DISABLED) return;

  pi.on("after_provider_response", (event, ctx) => {
    const status = (event as { status?: number }).status;
    if (typeof status !== "number") return;

    const key = sessionKey(ctx);

    // Successful response clears any prior error state. THIS is the right
    // place to clear — the model is healthy again, the badge can go away.
    if (status >= 200 && status < 300) {
      clearState(key, ctx);
      return;
    }

    if (!RECOVERABLE_STATUSES.has(status)) return;

    const headers = (event as { headers?: Record<string, string | undefined> }).headers ?? {};
    const state = stateFor(key);
    const isRepeat = state.lastErrorStatus === status;
    state.consecutiveSameStatus = isRepeat ? state.consecutiveSameStatus + 1 : 1;
    state.lastErrorStatus = status;
    state.lastErrorAt = Date.now();

    const { headline, suggest } = describeStatus(status, headers, state.consecutiveSameStatus);
    state.lastErrorMessage = `${headline} ${suggest}`;

    if (ctx.hasUI) {
      ctx.ui.notify(state.lastErrorMessage, "error");
      const badge = state.consecutiveSameStatus >= 2
        ? `provider ${status} ×${state.consecutiveSameStatus} — try /model`
        : `provider ${status} — /continue or /model`;
      ctx.ui.setStatus("continue-after-error", badge);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    sessions.delete(sessionKey(ctx));
  });

  // /continue — explicit retry on the same provider.
  pi.registerCommand("continue", {
    description:
      "Resume the agent after a provider 401/402/429 (sends 'continue' as a user message). " +
      "Use /model first if /continue has already failed once on the same status.",
    handler: async (args, ctx) => {
      const key = sessionKey(ctx);
      const state = stateFor(key);

      const text = args.trim() || "continue";

      // No recent error → user probably wanted a different command, but
      // /continue still works as a generic "resume" trigger.
      if (state.lastErrorStatus === null && ctx.hasUI) {
        ctx.ui.notify(
          "No recent provider error recorded — /continue still fires as a generic resume, but you may have wanted a different command (e.g. /model).",
          "warning",
        );
      }

      // Special case: 2+ consecutive same-status errors mean retry on this
      // provider is almost certainly futile. Warn but don't block — the user
      // may have manually fixed something between attempts.
      if (state.consecutiveSameStatus >= 2 && ctx.hasUI) {
        ctx.ui.notify(
          `/continue invoked after ${state.consecutiveSameStatus} consecutive ${state.lastErrorStatus}s. ` +
          `If you haven't fixed the underlying issue (top up credits / rotate key / switch provider), this will fail again. ` +
          `Consider /model first.`,
          "warning",
        );
      }

      // Clear state BEFORE sending so the next 401's notification reads
      // cleanly (consecutive count resets too).
      clearState(key, ctx);

      // If pi is mid-stream, sendUserMessage throws without deliverAs. But
      // post-error pi should be idle (the assistant message was finalized
      // with stopReason). Use ctx.isIdle() to decide — if idle we send a
      // fresh turn; if streaming (unexpected) we ABORT the dead stream
      // first (it's likely the stuck-after-401 case) and then send.
      const idle = (await ctx.isIdle?.()) ?? true;
      if (!idle) {
        try {
          await ctx.abort?.();
        } catch { /* abort may throw if already aborted; ignore */ }
      }

      try {
        await pi.sendUserMessage(text);
      } catch (err) {
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

  // model_select event clears error state — switching providers is the
  // recovery, not a fresh provider call. Without this, the badge stays
  // stuck after a successful /model swap.
  pi.on("model_select", (_event, ctx) => {
    clearState(sessionKey(ctx), ctx);
  });
}
