/**
 * compaction-model — run pi's compaction summarizer on a cheaper, faster model.
 *
 * Pi's default compaction calls the session's CURRENT model (claude-opus-4-7
 * for this user) to summarize older turns. That's expensive and slow — opus
 * at 200k+ context emits its summary at ~50 tok/s after a 30-60s TTFT.
 *
 * Compaction is structurally a constrained text-rewriting task — it doesn't
 * need opus's reasoning. Haiku/sonnet do it just fine, much faster, much
 * cheaper. opencode's compaction agent uses exactly this trick (see
 * agents.get("compaction") in src/session/compaction.ts).
 *
 * This extension hooks `session_before_compact` and replaces the default
 * compaction with a custom run on the configured cheap model. It uses pi's
 * built-in serializeConversation + the same structured-summary template,
 * so the OUTPUT shape is identical to default compaction — only the
 * ENGINE producing it changes.
 *
 * Configurable via env:
 *   PI_COMPACT_PROVIDER   default "opencode"
 *   PI_COMPACT_MODEL      default "claude-haiku-4-5"
 *   PI_COMPACT_MAX_TOKENS default 8192
 *   PI_COMPACT_OFF        "1" disables (no-op — falls back to default)
 *
 * Falls back to default compaction (return undefined) if:
 *   - The configured model isn't registered.
 *   - Auth resolution fails (no API key for that provider).
 *   - The summary call errors or returns empty content.
 *
 * Inspired by pi's own examples/extensions/custom-compaction.ts but uses the
 * same SUMMARY_TEMPLATE shape pi's default compactor produces, so existing
 * tooling (compaction-progress widget, branch-summary inheritance) stays
 * compatible.
 */

import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  convertToLlm,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";

// ── tunables ──────────────────────────────────────────────────────────────

const PROVIDER = process.env.PI_COMPACT_PROVIDER ?? "opencode";
const MODEL_ID = process.env.PI_COMPACT_MODEL ?? "claude-haiku-4-5";
const MAX_TOKENS = Math.max(
  1024,
  Number(process.env.PI_COMPACT_MAX_TOKENS ?? "8192"),
);
const DISABLED = process.env.PI_COMPACT_OFF === "1";

// Same structured template pi's default compactor uses (see
// /opt/pi-coding-agent/docs/compaction.md "Summary Format" section). Keeping
// shape identical means downstream consumers (resume, branch-summary
// inheritance, /tree navigation) treat our summaries the same.
const SUMMARY_TEMPLATE = `Output the summary as Markdown with EXACTLY this section structure:

## Goal
[What the user is trying to accomplish — one or two sentences]

## Constraints & Preferences
- [Requirements, conventions, preferences mentioned by the user, or "(none)"]

## Progress
### Done
- [x] [Completed work or "(none)"]

### In Progress
- [ ] [Current work or "(none)"]

### Blocked
- [Issues or open questions or "(none)"]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [Ordered next actions or "(none)"]

## Critical Context
- [Technical facts, errors, identifiers, command outputs that matter for continuing work]

<read-files>
[absolute paths of files read in this conversation, one per line]
</read-files>

<modified-files>
[absolute paths of files written/edited in this conversation, one per line]
</modified-files>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose.
- Preserve EXACT file paths, identifiers, command outputs, error strings.
- Do not mention that you are summarizing or compacting.
- Do not include the conversation transcript itself — only the summary.`;

// ── extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (DISABLED) return;

  pi.on("session_before_compact", async (event, ctx) => {
    const ev = event as {
      preparation?: {
        messagesToSummarize?: unknown[];
        turnPrefixMessages?: unknown[];
        previousSummary?: string;
        firstKeptEntryId?: string;
        tokensBefore?: number;
        customInstructions?: string;
      };
      signal?: AbortSignal;
    };
    const prep = ev.preparation;
    if (!prep) return;

    const model = ctx.modelRegistry.find(PROVIDER, MODEL_ID);
    if (!model) {
      // Silently fall back to default compaction. Don't notify on every
      // turn_end-triggered compaction — only the failure-once warning.
      if (ctx.hasUI) {
        ctx.ui.notify(
          `compaction-model: ${PROVIDER}/${MODEL_ID} not registered, using default`,
          "warning",
        );
      }
      return;
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `compaction-model: no auth for ${PROVIDER}, using default`,
          "warning",
        );
      }
      return;
    }

    const allMessages = [
      ...(prep.messagesToSummarize ?? []),
      ...(prep.turnPrefixMessages ?? []),
    ];
    if (allMessages.length === 0) return;

    const conversationText = serializeConversation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      convertToLlm(allMessages as any),
    );

    const previousContext = prep.previousSummary
      ? `\n\nPrevious anchored summary (update with new history; preserve still-true facts, drop stale, merge new):\n${prep.previousSummary}`
      : "";

    const userInstructions = prep.customInstructions
      ? `\n\nUser-provided focus for this summary: ${prep.customInstructions}`
      : "";

    const prompt = `You are summarizing a coding-agent conversation so context can be reclaimed without losing the work's continuity.${previousContext}${userInstructions}

${SUMMARY_TEMPLATE}

<conversation>
${conversationText}
</conversation>`;

    if (ctx.hasUI) {
      const tokens = prep.tokensBefore?.toLocaleString() ?? "?";
      ctx.ui.notify(
        `compacting via ${MODEL_ID} (${allMessages.length} msgs, ${tokens} tokens)`,
        "info",
      );
    }

    try {
      const response = await complete(
        model,
        {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          maxTokens: MAX_TOKENS,
          signal: ev.signal,
        },
      );

      const summary = response.content
        .filter(
          (c): c is { type: "text"; text: string } => c.type === "text",
        )
        .map((c) => c.text)
        .join("\n")
        .trim();

      if (!summary) {
        if (ctx.hasUI && !ev.signal?.aborted) {
          ctx.ui.notify(
            `compaction-model: ${MODEL_ID} returned empty, using default`,
            "warning",
          );
        }
        return;
      }

      return {
        compaction: {
          summary,
          firstKeptEntryId: prep.firstKeptEntryId,
          tokensBefore: prep.tokensBefore,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (ctx.hasUI && !ev.signal?.aborted) {
        ctx.ui.notify(`compaction-model failed: ${msg}`, "error");
      }
      return;
    }
  });
}
