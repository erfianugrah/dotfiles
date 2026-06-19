/**
 * stuck-state-recovery — force-clean phantom-stream state on every user input.
 *
 * Background — the failure mode this addresses (caught 2026-05-28 across
 * three different sessions on the same dev box):
 *
 *   1. Pi sends a provider request.
 *   2. Provider returns a non-OK status (401 CreditsError, 429, network
 *      timeout, stream cut mid-flight, etc).
 *   3. Pi surfaces the error in the UI and finalizes the assistant
 *      message with `stopReason="error"`.
 *   4. **Pi's internal stream-state does not always reset cleanly.** The
 *      next user message gets accepted (input box clears), pi shows the
 *      "Working..." spinner, but no agent_start fires and no provider
 *      request goes out. The TUI hangs indefinitely until the user
 *      mashes ESC repeatedly OR restarts pi.
 *
 *   5. After ESC the prompt becomes available, the user types, and the
 *      cycle repeats — pi enters another phantom Working... state. The
 *      session shown to the user is "I keep typing things and nothing
 *      happens".
 *
 * The `/continue` slash command in continue-after-error.ts handles this
 * for the explicit-recovery path — it calls ctx.abort() before sending.
 * But that only works if the user types `/continue` (literally with the
 * slash). Most users type `continue` or `try again` or just describe
 * what they wanted, and those words don't trigger any extension's
 * abort path. They go straight into the wedged state.
 *
 * This extension fixes that by wrapping EVERY user input. Before pi
 * processes a typed message, we check if pi believes itself to be
 * mid-stream when it shouldn't be (the post-error wedge), and force
 * abort if so. The user's message then fires cleanly into a fresh turn.
 *
 * Why hook `input` rather than `before_agent_start`: input fires
 * earlier and synchronously — by the time before_agent_start runs, pi
 * has already committed to a turn. We want to clean up between the
 * user submitting and pi committing.
 *
 * Why not just always call ctx.abort() unconditionally on input: that
 * would kill legitimate steer-style mid-stream input (the user typing
 * "actually use grep instead" while pi is mid-thinking). We only abort
 * when pi is in a state that wouldn't naturally accept the input.
 *
 * Detection heuristic — abort if ALL of these hold:
 *   - event.source === "interactive" (typed by the user, not from
 *     extension/RPC)
 *   - !await ctx.isIdle() (pi believes a stream is active)
 *   - last activity was >LAST_ACTIVITY_GRACE_MS ago — i.e. the
 *     "stream" pi thinks is active hasn't produced anything recently,
 *     so it's almost certainly wedged rather than legitimately
 *     streaming
 *
 * Disable via `PI_NO_STUCK_STATE_RECOVERY=1`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DISABLED = process.env.PI_NO_STUCK_STATE_RECOVERY === "1";

// Time in ms since last observable agent activity — see ACTIVITY_EVENTS
// below for the full list of events that bump the timer. If pi claims to
// be streaming but no activity event has fired in this long, treat it as
// wedged.
//
// 8s default — long enough that mid-thinking-block input (which is rare but
// legitimate as steer) doesn't trigger abort, short enough that the
// post-401 wedge clears within a few seconds of the user typing.
export const LAST_ACTIVITY_GRACE_MS = 8_000;

/**
 * Pi events whose firing means "the agent did SOMETHING" — each one bumps
 * the per-session activity timer.
 *
 * Critical inclusions (lesson 2026-05-28):
 *   - `message_update` fires on every assistant text-delta token. Without it,
 *     a long streaming response (e.g. a multi-paragraph analysis with no
 *     tool calls) goes 10–20s without any other event firing, and the next
 *     user input gets force-aborted as "wedged". This was the bug a user hit
 *     mid-analysis of an slskd port script.
 *   - `tool_execution_start` and `tool_execution_update` cover the gap
 *     between a tool starting and `tool_execution_end` firing — a long bash
 *     call or read of a big file would otherwise look wedged.
 *   - `tool_call` is the gate event that fires after `tool_execution_start`
 *     but before the tool actually runs; included for belt-and-suspenders.
 *   - `agent_start` covers the gap between user input and the first
 *     `message_start`.
 *
 * Removing any of these events from this list re-exposes a class of
 * false-positive aborts on healthy streams. The `bash-error-hints`-style
 * regression test in extensions.test.ts asserts the critical entries.
 */
export const ACTIVITY_EVENTS = [
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_call",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "after_provider_response",
] as const;

/**
 * Pure decision: should the input handler force-abort the current stream?
 *
 * Exported for unit tests — the live extension calls this with values
 * derived from `event.source`, `await ctx.isIdle()`, and the per-session
 * activity tracker. Keeping this side-effect-free makes the logic
 * testable without mocking the whole pi event loop.
 */
export function shouldAbort(args: {
  source: string;
  idle: boolean;
  sinceActivityMs: number;
  graceMs?: number;
}): boolean {
  if (args.source !== "interactive") return false;
  if (args.idle) return false;
  if (args.sinceActivityMs < (args.graceMs ?? LAST_ACTIVITY_GRACE_MS)) return false;
  return true;
}

// Per-session activity tracker. Keyed by session file path.
const lastActivity = new Map<string, number>();

function sessionKey(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionFile?.() ?? "default";
  } catch {
    return "default";
  }
}

function bumpActivity(ctx: ExtensionContext) {
  lastActivity.set(sessionKey(ctx), Date.now());
}

function lastActivityFor(ctx: ExtensionContext): number {
  return lastActivity.get(sessionKey(ctx)) ?? 0;
}

export default function (pi: ExtensionAPI) {
  if (DISABLED) return;

  // Track every observable progress event so we can compute "time since
  // last sign of life". Each event in ACTIVITY_EVENTS means pi did SOMETHING
  // — if pi claims to be streaming but none of these have fired in 8s, it's
  // wedged. The pi.on overloads narrow `event`/`ctx` per literal name, but
  // iterating over the tuple loses that narrowing — we don't need it because
  // the handler only consults ctx via bumpActivity, which is type-erased.
  for (const eventName of ACTIVITY_EVENTS) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pi.on as any)(eventName, (_event: unknown, ctx: ExtensionContext) =>
      bumpActivity(ctx),
    );
  }

  pi.on("session_shutdown", (_event, ctx) => {
    lastActivity.delete(sessionKey(ctx));
  });

  pi.on("input", async (event, ctx) => {
    // Only intervene on user-typed input. Extension-injected messages
    // (via sendUserMessage) and RPC-driven messages should pass through —
    // those callers know what they're doing.
    if (event.source !== "interactive") return { action: "continue" };

    const idle = (await ctx.isIdle?.()) ?? true;
    const sinceActivity = Date.now() - lastActivityFor(ctx);
    if (!shouldAbort({ source: event.source, idle, sinceActivityMs: sinceActivity })) {
      return { action: "continue" };
    }

    // Wedged. Force-abort the dead stream so the user's message fires
    // cleanly into a fresh turn.
    try {
      await ctx.abort?.();
    } catch {
      // abort may throw if there's nothing to abort or if we raced with
      // pi's own cleanup — the goal is just to make sure state is clean
      // before pi processes the new input. Ignore.
    }

    if (ctx.hasUI) {
      ctx.ui.notify(
        `Detected wedged stream (${Math.round(sinceActivity / 1000)}s since last activity) — force-aborted before processing your message.`,
        "info",
      );
    }

    // Mark activity so a rapid second message doesn't double-abort.
    bumpActivity(ctx);

    return { action: "continue" };
  });
}
