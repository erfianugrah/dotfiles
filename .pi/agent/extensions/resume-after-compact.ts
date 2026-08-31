/**
 * resume-after-compact - resume interrupted or clean turns that auto-compaction stopped.
 *
 * Two distinct scenarios:
 *
 * 1. ERROR INTERRUPTION (pi issue #8409): ESC during tool execution leaves
 *    pi's abort signal tripped, so the NEXT model request dies instantly at
 *    lazyStream setup and is recorded as stopReason "error" ("The operation
 *    was aborted.") instead of "aborted". _checkCompaction only skips
 *    clean-aborted turns, so when context sits near the threshold pi runs
 *    threshold auto-compaction on the bogus error turn - and threshold
 *    compaction NEVER resumes the interrupted turn. Net effect: the session
 *    compacted, then dead-stopped with zero visible error.
 *
 * 2. CLEAN-TURN COMPACTION (no bug, a design gap): A clean turn completes
 *    (stopReason "stop"), threshold compaction fires with willRetry=false
 *    (nothing to retry -- the turn finished), session compacts correctly
 *    but pi idles instead of continuing. In the TUI the user can type
 *    /continue; in headless pi -p mode there is nobody to do that.
 *    The extension now handles this path.
 *
 * This extension restores the missing resume:
 *
 *  1. agent_end records whether the run's last assistant message ended
 *     unfinished (stopReason "error" or "aborted"). Clean turns ("stop")
 *     arm cleanCompactArmed instead.
 *
 *  2. session_compact with willRetry=false (pi will NOT resume on its own):
 *     - Error turn + recorded interruption -> arms one-shot error resume.
 *     - Clean turn + cleanCompactArmed -> headless: arms resume; TUI: notify only.
 *     willRetry=true (overflow recovery) is left alone - pi re-runs the turn
 *     itself. reason="manual" means user /compact and is left alone TOO,
 *     except when trigger-compact appended its trigger-compact:auto marker
 *     entry before firing (its ctx.compact() call arrives as reason "manual"
 *     by pi-binding fiat); the marker entry tells the two apart. A lib/
 *     singleton would NOT work here - pi's loader gives each extension its
 *     own copy of shared modules (probed 2026-08-31).
 *
 * Note: on this box pi core's own threshold compaction never fires these
 * events - every auto-compaction is trigger-compact.ts crossing 0.85 of
 * contextWindow on turn_end. The marker path is therefore the ONLY path
 * by which auto-resume can fire at all (incident 2026-08-31).
 *
 *  3. agent_settled fires the resume: a synthetic user message. Error case
 *     tells the agent to pick up where it stopped; clean case just says
 *     "continue working." One attempt per event (circuit breaker); re-armed
 *     only by a clean turn or real user message.
 *
 * Deliberate limits:
 *  - stopReason "aborted" (a REAL user Escape, not the #8409 misrecord)
 *    only gets a notification pointing at /continue - auto-resuming after
 *    a deliberate cancel fights the user.
 *  - Auth/quota/rate-limit errors (401/402/403/429, billing, quota) are
 *    notify-only: compaction changes nothing about them and an instant
 *    re-hit is futile. continue-after-error owns that recovery flow.
 *  - Clean-turn resume fires only in headless mode (ctx.hasUI === false);
 *    in the TUI the user sees a notification and continues manually.
 *
 * Disable via `PI_NO_RESUME_AFTER_COMPACT=1`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DISABLED = process.env.PI_NO_RESUME_AFTER_COMPACT === "1";

/**
 * Custom session-entry type trigger-compact.ts appends right before an
 * automatic (threshold-crossing) compaction. resume-after-compact uses it to
 * tell trigger-compact's auto-fire apart from a genuine user /compact, since
 * pi's ctx.compact() binding reports both as reason "manual".
 */
const AUTO_MARKER_TYPE = "trigger-compact:auto";
/** A marker this old cannot belong to the compaction at hand. */
const AUTO_MARKER_MAX_AGE_MS = 5 * 60_000;

// Errors where auto-resume is futile - the identical request fails again.
// Everything else (aborts, stream drops, 5xx) is worth one retry.
const NO_RESUME_PATTERN =
  /\b(401|402|403|429)\b|unauthorized|payment|insufficient_quota|billing|quota exceeded|rate.?limit/i;

type Interruption = {
  stopReason: string;
  errorMessage: string;
  /** true = auto-resume allowed; false = notify-only (deliberate ESC, auth/quota) */
  resumable: boolean;
};

type SessionState = {
  interrupted: Interruption | null;
  resumeArmed: boolean;
  /** one auto-resume per interruption; reset by a clean turn or real user input */
  resumeAttempted: boolean;
  /** suppress our own synthetic user message from the input handler */
  sendingResume: boolean;
  /** clean-turn compaction: last turn completed, compaction fired, no resume mechanism in pi core */
  cleanCompactArmed: boolean;
  /** session_compact fired while a sendResume is still awaiting the resumed turn */
  resuming: boolean;
  /** id of the last consumed trigger-compact:auto marker entry */
  lastConsumedMarkerId: string | null;
};

const sessions = new Map<string, SessionState>();

function stateFor(key: string): SessionState {
  let s = sessions.get(key);
  if (!s) {
    s = { interrupted: null, resumeArmed: false, resumeAttempted: false, sendingResume: false, cleanCompactArmed: false, resuming: false, lastConsumedMarkerId: null };
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

function notify(ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error" = "info") {
  if (ctx.hasUI) ctx.ui.notify(msg, level);
}

function lastAssistantStop(messages: unknown[]): { stopReason: string; errorMessage: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; stopReason?: string; errorMessage?: string };
    if (m?.role === "assistant") {
      return { stopReason: m.stopReason ?? "", errorMessage: m.errorMessage ?? "" };
    }
  }
  return null;
}

/**
 * True when the most recent trigger-compact:auto marker entry is fresh enough
 * to belong to the compaction that just ran, and has not been consumed yet.
 * Consumes by id (one marker, one compaction).
 */
function consumeAutoMarker(ctx: ExtensionContext, s: SessionState): boolean {
  try {
    const entries = ctx.sessionManager.getEntries?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as {
        id?: string;
        type?: string;
        customType?: string;
        timestamp?: string;
        data?: { at?: number };
      };
      if (e.type !== "custom" || e.customType !== AUTO_MARKER_TYPE) continue;
      if (e.id && s.lastConsumedMarkerId === e.id) return false;
      const at = e.data?.at ?? Date.parse(e.timestamp ?? "");
      if (!Number.isFinite(at) || Date.now() - at > AUTO_MARKER_MAX_AGE_MS) return false;
      s.lastConsumedMarkerId = e.id ?? null;
      return true;
    }
  } catch {
    // getEntries unavailable or shape mismatch - fail closed (treat as user /compact)
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  if (DISABLED) return;

  async function sendResume(ctx: ExtensionContext, s: SessionState): Promise<void> {
    let text: string;
    if (!s.interrupted) {
      // Clean-turn compaction (no interruption): task completed, just continue.
      s.resumeAttempted = true;
      notify(ctx, "Auto-resuming after compaction", "info");
      text =
        "The session was compacted to stay within the context window. " +
        "The previous turn completed successfully. Continue working on the task;";
    } else {
      s.resumeAttempted = true;
      const cause = s.interrupted.errorMessage
        ? ` (${s.interrupted.errorMessage.slice(0, 120)})`
        : "";
      notify(ctx, `Auto-resuming turn interrupted by compaction${cause}`, "info");
      text =
        "The previous turn was interrupted before completing: the model request failed" +
        ` (stopReason: ${s.interrupted.stopReason}${cause}) and auto-compaction ran without resuming it. ` +
        "Resume the task from exactly where it stopped. Do not redo work that already completed; " +
        "check tool results above the compaction summary first.";
    }

    s.sendingResume = true;
    s.resuming = true;
    try {
      // pi.sendUserMessage's extension binding is fire-and-forget: it returns
      // as soon as the nested prompt() STARTS, and prompt() passes several
      // awaits (input handlers, auth check, compaction check) before
      // _runAgentPrompt flips _isAgentRunActive. In headless pi -p, print mode
      // disposes the session the moment this event handler returns, so the
      // resumed turn must be provably in flight before this handler may
      // finish - otherwise it is aborted before its first event and nothing
      // persists (run15/run16 repro, 2026-08-31). waitForIdle() alone does
      // not fix this: _emitAgentSettled clears the active flag BEFORE
      // emitting, so waitForIdle sees an idle agent and returns instantly.
      await pi.sendUserMessage(text);

      // Phase 1: poll until the resumed run has actually started. The send
      // can also reject out-of-band (the fire-and-forget .catch emits an
      // Extension error we never see), so cap the wait.
      const deadline = Date.now() + 30_000;
      let started = false;
      while (Date.now() < deadline) {
        const idle = (await ctx.isIdle?.()) ?? true;
        if (!idle) {
          started = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!started) {
        notify(ctx, "Auto-resume did not start a turn within 30s - /continue by hand.", "error");
        return;
      }
      // Phase 2: hold this handler (and with it prompt(), and the process)
      // open until the resumed turn settles.
      await ctx.waitForIdle?.();
    } catch (err) {
      notify(
        ctx,
        `Auto-resume failed to send: ${err instanceof Error ? err.message : String(err)}. /continue by hand.`,
        "error",
      );
    } finally {
      s.sendingResume = false;
      s.resuming = false;
    }
  }

  pi.on("agent_end", (event, ctx) => {
    const s = stateFor(sessionKey(ctx));
    const last = lastAssistantStop((event as { messages?: unknown[] }).messages ?? []);
    if (!last) return;

    if (last.stopReason === "error") {
      const resumable = !NO_RESUME_PATTERN.test(last.errorMessage);
      s.interrupted = { ...last, resumable };
    } else if (last.stopReason === "aborted") {
      // Real user Escape: record but never auto-resume.
      s.interrupted = { ...last, resumable: false };
    } else {
      // Clean turn (stop/toolUse completed): interruption is over, re-arm breaker.
      s.interrupted = null;
      s.resumeArmed = false;
      s.resumeAttempted = false;
      // Arm clean-turn compaction resume for headless mode.
      // In the TUI the user sees the compaction notification and can continue;
      // in headless pi -p mode there is no user to hit /continue.
      s.cleanCompactArmed = true;
    }
  });

  pi.on("message_start", (event, ctx) => {
    const s = stateFor(sessionKey(ctx));
    if (s.sendingResume) return;
    const m = (event as { message?: { role?: string } }).message;
    if (m?.role !== "user") return;
    // Real user input supersedes any pending interruption/resume.
    s.interrupted = null;
    s.resumeArmed = false;
    s.resumeAttempted = false;
    s.cleanCompactArmed = false;
  });

  pi.on("session_compact", async (event, ctx) => {
    const s = stateFor(sessionKey(ctx));
    const e = event as { reason?: string; willRetry?: boolean };

    if (e.willRetry) {
      // Overflow recovery: pi re-runs the turn itself.
      s.interrupted = null;
      s.resumeArmed = false;
      return;
    }
    if (e.reason === "manual") {
      // trigger-compact's automatic threshold fire also arrives as reason
      // "manual" (pi's ctx.compact() binding hardcodes it) - find its marker
      // session entry to tell it apart from a genuine user /compact, which
      // stays untouched. Incident 2026-08-31: every auto-compaction on this
      // box goes through trigger-compact, so without the marker no
      // auto-resume ever fired.
      if (!consumeAutoMarker(ctx, s)) return;
    }

    // Clean-turn compaction: arm resume for headless mode only.
    // TUI mode shows a notification; the user can continue manually.
    if (!s.interrupted && s.cleanCompactArmed) {
      s.cleanCompactArmed = false;
      if (ctx.hasUI) {
        notify(ctx, "Session compacted. Continue to pick up the task.", "info");
        return;
      }
      s.resumeAttempted = false; // re-arm for this path
      if ((await ctx.isIdle?.()) ?? true) {
        // Extension-triggered compaction: agent settled BEFORE session_compact
        // fired, so no agent_settled is coming - fire the resume now.
        await sendResume(ctx, s);
      } else {
        // Pi-core mid-run compaction: agent_settled arrives after the run
        // unwinds; arm for it.
        s.resumeArmed = true;
      }
      return;
    }

    if (!s.interrupted) return;

    if (!s.interrupted.resumable) {
      notify(
        ctx,
        `Auto-compaction (${e.reason}) followed an unfinished turn (${s.interrupted.stopReason}). Not auto-resuming - /continue to pick it up by hand.`,
        "warning",
      );
      return;
    }
    if (s.resumeAttempted) {
      notify(
        ctx,
        "Turn interrupted again after the auto-resume; not retrying (circuit breaker). Investigate or /continue by hand.",
        "error",
      );
      return;
    }
    if ((await ctx.isIdle?.()) ?? true) {
      // Same ordering: extension-triggered, agent already settled - fire now.
      await sendResume(ctx, s);
    } else {
      s.resumeArmed = true;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const s = stateFor(sessionKey(ctx));
    if (!s.resumeArmed) return;
    // The resumed turn settles with its own agent_settled while the original
    // handler is still awaiting waitForIdle - do not re-enter.
    if (s.resuming) return;
    s.resumeArmed = false;

    const idle = (await ctx.isIdle?.()) ?? true;
    if (!idle) return; // another extension started work; don't pile on

    await sendResume(ctx, s);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    sessions.delete(sessionKey(ctx));
  });
}
