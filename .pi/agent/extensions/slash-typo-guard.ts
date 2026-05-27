/**
 * slash-typo-guard — catch typo'd slash commands before they hit the LLM.
 *
 * When the user submits `/<word>` (e.g. `/qauit`, `/quti`, `/comapct`) and
 * it doesn't match any known command, we check Levenshtein distance against
 * built-in commands + extension commands + skill/template commands. If
 * there's a close match (distance ≤ 2), we ask "did you mean /quit?" and
 * either rewrite the input or block the send entirely.
 *
 * Why this exists: pi sends unmatched slash text to the model as a normal
 * user message. With a 401 from the provider that puts you in a retry
 * loop you can't easily escape (esp. before keybindings.json fixed the
 * Ctrl+C → app.interrupt rebind). Catching `/qauit` → `/quit` here saves
 * the round trip and the loop.
 *
 * Pass-through cases (no intercept):
 *   - text doesn't start with `/`
 *   - first token IS a known command (extension, skill, template, builtin)
 *   - first token is `/skill:foo`, `/template:foo` (already routed)
 *   - no built-in/extension command within distance 2 of the typo
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Built-in interactive commands. pi.getCommands() does NOT include these
// (the docs explicitly note `/model`, `/settings`, etc. are excluded
// because they'd be no-ops if delivered via prompt). Sourced from
// /opt/pi-coding-agent/docs/usage.md as of pi 0.75.5.
const BUILT_IN_COMMANDS: readonly string[] = [
  "login", "logout", "model", "scoped-models", "settings",
  "resume", "new", "name", "session", "tree", "fork", "clone",
  "compact", "copy", "export", "share", "reload", "hotkeys",
  "changelog", "quit",
];

// Levenshtein on short ASCII strings. Iterative two-row DP, no allocations
// in the inner loop after the initial array.
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a.charCodeAt(i - 1) === b.charCodeAt(j - 1)
        ? prev
        : 1 + Math.min(prev, dp[j - 1], dp[j]);
      prev = tmp;
    }
  }
  return dp[n];
}

// Find the closest match within `maxDist` edits. Returns null if nothing
// is close enough. Ties broken by shortest distance, then by command name
// for stability.
export function closestCommand(
  cmd: string,
  known: ReadonlySet<string>,
  maxDist = 2,
): { name: string; dist: number } | null {
  let best: { name: string; dist: number } | null = null;
  for (const name of known) {
    // Quick reject: lengths too far apart to be within maxDist edits.
    if (Math.abs(name.length - cmd.length) > maxDist) continue;
    const d = levenshtein(cmd, name);
    if (d > maxDist) continue;
    if (!best || d < best.dist || (d === best.dist && name < best.name)) {
      best = { name, dist: d };
    }
  }
  return best;
}

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    // Skip non-interactive sources and headless modes — confirm() needs a UI.
    if (event.source === "extension") return { action: "continue" };
    if (!ctx.hasUI) return { action: "continue" };

    const text = event.text;

    // First token must look like `/<word>` — bail on anything else.
    // Captures: m[0] = full slash token (e.g. "/qauit"), m[1] = bare name.
    const m = text.match(/^\/([a-zA-Z][a-zA-Z0-9-]*)/);
    if (!m) return { action: "continue" };

    // Skill / template namespaces (`/skill:foo`, `/template:foo`) are handled
    // by pi's own expansion pipeline. The match above stops at `:` because
    // `:` isn't in the char class — guard against the case where the user
    // typed `/skill` alone (which would slip through as an unknown name).
    if (text.startsWith("/skill:") || text.startsWith("/template:")) {
      return { action: "continue" };
    }

    const cmd = m[1].toLowerCase();

    // Build the universe of known command names.
    const known = new Set<string>(BUILT_IN_COMMANDS);
    for (const c of pi.getCommands()) {
      const full = c.name.toLowerCase();
      known.add(full);
      // Commands like "review:1" — also register the base "review" so
      // typing `/review` (without the suffix) resolves cleanly.
      const base = full.split(":")[0];
      if (base) known.add(base);
    }

    if (known.has(cmd)) return { action: "continue" };

    // Short commands (≤3 chars) need stricter matching — every 3-letter
    // typo is within 2 edits of /fork, /new, /name etc., which would
    // false-positive on intentional `/foo`-style messages. Length 4+
    // gets the full 2-edit window which covers single transpositions.
    const maxDist = cmd.length <= 3 ? 1 : 2;
    const best = closestCommand(cmd, known, maxDist);
    if (!best) return { action: "continue" };

    const ok = await ctx.ui.confirm(
      `Unknown command /${cmd}`,
      `Did you mean /${best.name}?`,
    );

    if (ok) {
      // Replace the typo'd command; preserve any trailing args verbatim.
      const rest = text.slice(m[0].length);
      return { action: "transform", text: `/${best.name}${rest}` };
    }

    // User said no — drop the message rather than send `/qauit` to the LLM
    // as plain text. Notify so they know we ate it.
    ctx.ui.notify(`/${cmd} not sent (would have been treated as plain text)`, "warning");
    return { action: "handled" };
  });
}
