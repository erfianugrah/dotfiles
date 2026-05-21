/**
 * inline-bash — expand `!{cmd}` patterns inside user prompts.
 *
 * Type things like:
 *   what's in !{pwd}?
 *   branch !{git branch --show-current} / status !{git status --short}
 *   node !{node --version} / kubectl !{kubectl config current-context}
 *
 * The `!{...}` patterns are executed via bash and replaced with their stdout
 * (trimmed) before the prompt is sent to the LLM. Whole-line `!command`
 * (the built-in bash shorthand) is left alone so the two don't fight.
 *
 * Timeout: 30s per command. Failures are inlined as `[error: ...]` so the
 * model can still see what was attempted.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const PATTERN = /!\{([^}]+)\}/g;
  const TIMEOUT_MS = 30_000;

  pi.on("input", async (event, ctx) => {
    const text = typeof event?.text === "string" ? event.text : "";
    if (!text) return { action: "continue" };

    // Skip whole-line bash shorthand (`!cmd`) but NOT `!{cmd}`
    const trimmed = text.trimStart();
    if (trimmed.startsWith("!") && !trimmed.startsWith("!{")) {
      return { action: "continue" };
    }

    if (!PATTERN.test(text)) return { action: "continue" };
    PATTERN.lastIndex = 0;

    // Collect matches up front to avoid mutating-while-iterating
    const matches: Array<{ full: string; command: string }> = [];
    let m = PATTERN.exec(text);
    while (m) {
      matches.push({ full: m[0], command: m[1] });
      m = PATTERN.exec(text);
    }

    let result = text;
    const expansions: Array<{ command: string; output: string; error?: string }> = [];

    for (const { full, command } of matches) {
      try {
        const r = await pi.exec("bash", ["-c", command], { timeout: TIMEOUT_MS });
        const out = (r.stdout || r.stderr || "").trim();
        if (r.code !== 0 && r.stderr) {
          expansions.push({ command, output: out, error: `exit ${r.code}` });
        } else {
          expansions.push({ command, output: out });
        }
        result = result.replace(full, out);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expansions.push({ command, output: "", error: msg });
        result = result.replace(full, `[error: ${msg}]`);
      }
    }

    if (ctx.hasUI && expansions.length > 0) {
      const summary = expansions
        .map((e) => {
          const status = e.error ? ` (${e.error})` : "";
          const preview = e.output.length > 50 ? `${e.output.slice(0, 50)}…` : e.output;
          return `!{${e.command}}${status} → "${preview}"`;
        })
        .join("\n");
      ctx.ui.notify(`Expanded ${expansions.length} inline command(s):\n${summary}`, "info");
    }

    return { action: "transform", text: result, images: event.images };
  });
}
