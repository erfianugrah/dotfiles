/**
 * cost-guard - proactive spend + context-cost warnings.
 *
 * The failure mode this exists for (2026-08-10/11 sessions): a session
 * quietly grows to 30M-140M input tokens; the per-turn price climbs with
 * context (every turn re-bills uncached input at the model's rate), and the
 * first signal anything is wrong is an OpenRouter 402 ("requested 131072
 * tokens, can only afford 125984") that kills the session mid-task. By then
 * the session has already cost $45-$370.
 *
 * trigger-compact handles context SIZE (compacts at 85% of the window) but
 * says nothing about MONEY, and compaction on an expensive model at huge
 * context is itself expensive. This extension adds the cost dimension:
 *
 *   1. Cumulative spend ladder - sums usage.cost.total from assistant
 *      message_end events and notifies the first time the session crosses
 *      each rung ($5, $10, $20, ... - see PI_COST_WARN_LADDER).
 *   2. Expensive single turn - if one turn's spend exceeds
 *      PI_COST_TURN_WARN, say so and suggest /trigger-compact or a cheaper
 *      model.
 *   3. Expensive model at big context - when context exceeds
 *      PI_COST_CTX_WARN and the active model's input price is >=
 *      PI_COST_EXPENSIVE_INPUT ($/M), notify with concrete cheaper
 *      alternatives priced at the CURRENT context size (only models whose
 *      contextWindow actually fits). Re-warns only when spend doubles, not
 *      every turn. Also fires on model_select if you switch INTO an
 *      expensive model while context is already large.
 *   4. /cost - cumulative spend, last-turn spend, and a per-turn price
 *      comparison across available models at the current context size.
 *
 * Warn-only by design: it never blocks a model switch or a turn. Blocking
 * the user's explicit /model choice is worse than the spend.
 *
 * Accuracy caveats (this is a gauge, not an invoice):
 *   - Only assistant message_end usage is summed. Compaction-summary usage
 *     and tool-reported nested usage are NOT counted here, so the true
 *     session total (footer, /session) is somewhat higher.
 *   - State resets on resume; the ladder re-arms from $0 in a resumed
 *     session even though the provider has already billed the earlier turns.
 *
 * Env:
 *   PI_COST_GUARD_OFF=1        disable entirely
 *   PI_COST_WARN_LADDER        default "5,10,20,35,50,75,100" ($ crossings)
 *   PI_COST_WARN_STEP          default 50 ($ step after the ladder ends)
 *   PI_COST_TURN_WARN          default 1.00 ($ per single turn)
 *   PI_COST_CTX_WARN           default 150000 (context tokens that arm the
 *                              expensive-model warning)
 *   PI_COST_EXPENSIVE_INPUT    default 3 ($/M input = "expensive")
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// -- pure helpers (unit-tested) --------------------------------------------

export interface ModelCost {
  input: number; // $/M
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface CostedModel {
  provider: string;
  id: string;
  contextWindow: number;
  cost: ModelCost;
}

export interface Alternative {
  ref: string; // "provider/id"
  perTurnUSD: number; // cold-input estimate at the given context size
  inputPerM: number;
}

export function parseLadder(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback;
  const parsed = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  return parsed.length > 0 ? parsed : fallback;
}

/**
 * Every threshold crossed moving spend from prev to curr: the ladder rungs,
 * then every `step` dollars beyond the last rung. Returns [] when nothing
 * was crossed (including when curr <= prev).
 */
export function thresholdsCrossed(
  prev: number,
  curr: number,
  ladder: number[],
  step: number,
): number[] {
  if (curr <= prev) return [];
  const crossed = ladder.filter((t) => prev < t && curr >= t);
  const ladderMax = ladder.length > 0 ? ladder[ladder.length - 1] : 0;
  if (curr > ladderMax && step > 0) {
    const from = Math.max(prev, ladderMax);
    // First step threshold strictly above ladderMax: ladderMax + step.
    for (let t = ladderMax + step; t <= curr; t += step) {
      if (t > from) crossed.push(t);
    }
  }
  return crossed;
}

/** Cold-cache per-turn input cost at a given context size. */
export function perTurnCostUSD(cost: ModelCost, contextTokens: number): number {
  return (contextTokens * cost.input) / 1_000_000;
}

/**
 * Cheaper models that can actually hold this context, sorted by per-turn
 * cost ascending. Models with input price >= the current model's are
 * excluded (not cheaper); models whose contextWindow can't hold the
 * context are excluded (the suggestion would be unusable).
 */
export function cheaperAlternatives(
  models: CostedModel[],
  current: CostedModel,
  contextTokens: number,
  limit = 3,
): Alternative[] {
  return models
    .filter(
      (m) =>
        !(m.provider === current.provider && m.id === current.id) &&
        m.cost.input < current.cost.input &&
        m.contextWindow >= contextTokens,
    )
    .map((m) => ({
      ref: `${m.provider}/${m.id}`,
      perTurnUSD: perTurnCostUSD(m.cost, contextTokens),
      inputPerM: m.cost.input,
    }))
    .sort((a, b) => a.perTurnUSD - b.perTurnUSD)
    .slice(0, limit);
}

export function fmtUSD(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n)}`;
}

// -- extension --------------------------------------------------------------

const OFF = process.env.PI_COST_GUARD_OFF === "1";
const LADDER = parseLadder(process.env.PI_COST_WARN_LADDER, [5, 10, 20, 35, 50, 75, 100]);
const STEP = Math.max(1, Number(process.env.PI_COST_WARN_STEP ?? "50"));
const TURN_WARN = Math.max(0, Number(process.env.PI_COST_TURN_WARN ?? "1"));
const CTX_WARN = Math.max(0, Number(process.env.PI_COST_CTX_WARN ?? "150000"));
const EXPENSIVE_INPUT = Math.max(0, Number(process.env.PI_COST_EXPENSIVE_INPUT ?? "3"));

interface SessionState {
  cumulative: number;
  turnStart: number; // cumulative at the start of the in-flight turn
  lastRung: number; // highest rung already notified
  // modelRef -> cumulative spend when we last warned about that model at
  // big context; re-warn only after spend doubles.
  expensiveWarnedAt: Map<string, number>;
}

export default function (pi: ExtensionAPI) {
  if (OFF) return;

  let state: SessionState = {
    cumulative: 0,
    turnStart: 0,
    lastRung: 0,
    expensiveWarnedAt: new Map(),
  };

  const notify = (ctx: ExtensionContext, msg: string) => {
    if (ctx.hasUI) ctx.ui.notify(msg, "warning");
  };

  const modelCostOf = (ctx: ExtensionContext): CostedModel | null => {
    const m = ctx.model as
      | { provider?: string; id?: string; contextWindow?: number; cost?: ModelCost }
      | undefined;
    if (!m?.provider || !m.id || !m.cost) return null;
    return {
      provider: m.provider,
      id: m.id,
      contextWindow: m.contextWindow ?? 0,
      cost: m.cost,
    };
  };

  const availableModels = (ctx: ExtensionContext): CostedModel[] => {
    const list =
      (ctx.modelRegistry as { getAvailable?: () => unknown[] }).getAvailable?.() ?? [];
    const out: CostedModel[] = [];
    for (const m of list) {
      const mm = m as { provider?: string; id?: string; contextWindow?: number; cost?: ModelCost };
      if (mm.provider && mm.id && mm.cost) {
        out.push({
          provider: mm.provider,
          id: mm.id,
          contextWindow: mm.contextWindow ?? 0,
          cost: mm.cost,
        });
      }
    }
    return out;
  };

  const alternativesText = (ctx: ExtensionContext, contextTokens: number): string => {
    const current = modelCostOf(ctx);
    if (!current) return "";
    const alts = cheaperAlternatives(availableModels(ctx), current, contextTokens);
    if (alts.length === 0) return " no cheaper model in the registry fits this context.";
    const parts = alts.map((a) => `${a.ref} ~${fmtUSD(a.perTurnUSD)}/turn`);
    return ` cheaper here: ${parts.join(", ")}.`;
  };

  const checkExpensiveModel = (ctx: ExtensionContext) => {
    const current = modelCostOf(ctx);
    if (!current || current.cost.input < EXPENSIVE_INPUT) return;
    const usage = ctx.getContextUsage();
    const tokens = usage?.tokens ?? 0;
    if (tokens < CTX_WARN) return;

    const ref = `${current.provider}/${current.id}`;
    const lastWarn = state.expensiveWarnedAt.get(ref);
    if (lastWarn !== undefined && state.cumulative < lastWarn * 2) return;
    state.expensiveWarnedAt.set(ref, Math.max(state.cumulative, 0.01));

    const perTurn = perTurnCostUSD(current.cost, tokens);
    notify(
      ctx,
      `cost-guard: ${ref} at ${Math.round(tokens / 1000)}k context costs ~${fmtUSD(perTurn)}/turn uncached.` +
        alternativesText(ctx, tokens) +
        ` /trigger-compact shrinks the bill too.`,
    );
  };

  pi.on("session_start", (_event, _ctx) => {
    state = { cumulative: 0, turnStart: 0, lastRung: 0, expensiveWarnedAt: new Map() };
  });

  pi.on("turn_start", (_event, _ctx) => {
    state.turnStart = state.cumulative;
  });

  pi.on("message_end", async (event, ctx) => {
    const msg = (event as { message?: { role?: string; usage?: { cost?: { total?: number } } } })
      .message;
    if (!msg || msg.role !== "assistant") return undefined;
    const total = msg.usage?.cost?.total;
    if (typeof total !== "number" || total <= 0) return undefined;

    const prev = state.cumulative;
    state.cumulative += total;

    const crossed = thresholdsCrossed(prev, state.cumulative, LADDER, STEP).filter(
      (t) => t > state.lastRung,
    );
    if (crossed.length > 0) {
      state.lastRung = crossed[crossed.length - 1];
      const usage = ctx.getContextUsage();
      const ctxNote = usage?.tokens ? ` at ${Math.round(usage.tokens / 1000)}k context` : "";
      notify(
        ctx,
        `cost-guard: session spend crossed ${fmtUSD(state.lastRung)} (now ~${fmtUSD(state.cumulative)}${ctxNote}, this session only).` +
          ` Consider /trigger-compact or wrapping up.`,
      );
    }
    return undefined;
  });

  pi.on("turn_end", (_event, ctx) => {
    const turnCost = state.cumulative - state.turnStart;
    if (TURN_WARN > 0 && turnCost >= TURN_WARN) {
      const usage = ctx.getContextUsage();
      const tokens = usage?.tokens ?? 0;
      const current = modelCostOf(ctx);
      const modelNote = current ? ` on ${current.provider}/${current.id}` : "";
      notify(
        ctx,
        `cost-guard: that turn cost ${fmtUSD(turnCost)}${modelNote}` +
          (tokens ? ` at ${Math.round(tokens / 1000)}k context.` : `.`) +
          (tokens >= CTX_WARN ? alternativesText(ctx, tokens) : ""),
      );
    }
    checkExpensiveModel(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    // Switching INTO an expensive model with a big context already loaded is
    // the expensive decision; warn immediately instead of after a turn burns.
    const m = ctx.model as { provider?: string; id?: string } | undefined;
    if (m?.provider && m.id) state.expensiveWarnedAt.delete(`${m.provider}/${m.id}`);
    checkExpensiveModel(ctx);
  });

  pi.registerCommand("cost", {
    description: "Session spend gauge + per-turn price across models at current context",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const usage = ctx.getContextUsage();
      const tokens = usage?.tokens ?? 0;
      const current = modelCostOf(ctx);
      const lines: string[] = [
        `session spend (this session, assistant turns only): ~${fmtUSD(state.cumulative)}`,
        `context: ${tokens ? `${Math.round(tokens / 1000)}k / ${Math.round((usage?.contextWindow ?? 0) / 1000)}k` : "unknown"}`,
      ];
      if (current && tokens > 0) {
        lines.push(
          `current model ${current.provider}/${current.id}: ~${fmtUSD(perTurnCostUSD(current.cost, tokens))}/turn uncached ($${current.cost.input}/M in)`,
        );
        const alts = cheaperAlternatives(availableModels(ctx), current, tokens, 5);
        if (alts.length > 0) {
          lines.push("cheaper per-turn at this context:");
          for (const a of alts) {
            lines.push(`  ${a.ref}  ~${fmtUSD(a.perTurnUSD)}/turn ($${a.inputPerM}/M in)`);
          }
        } else {
          lines.push("no cheaper model in the registry fits this context.");
        }
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
