/**
 * bash-error-hints — decorate bash tool results with one-line hints when
 * stderr matches a known footgun pattern.
 *
 * Background: every time the agent fumbles on a recoverable error (e.g.
 * `git mv` on a gitignored file, "pathspec did not match", Anthropic stream
 * cutoff) we lose 30s-5min to investigation that should have been
 * "check .gitignore first". Prompts go stale. Skill descriptions don't
 * trigger reliably. The cheapest intervention is to inject the hint
 * exactly when relevant — the next turn after the error appears.
 *
 * Cost model:
 *   - zero context tokens for runs that don't hit any pattern
 *   - ~30 tokens of injected hint when a pattern fires
 *   - hint is plain text appended to the existing tool output, never
 *     replaces it — model still sees the original stderr verbatim
 *
 * Adding hints: append a {pattern, hint} pair to HINTS. Pattern matches
 * either stdout or stderr (combined output). Hint should be one line,
 * actionable, name the next probe. Don't include guesses or analysis;
 * leave reasoning to the model.
 *
 * Idempotency: hints are wrapped in a [bash-error-hints] marker so we
 * never stack duplicates if the handler runs twice.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HINT_MARKER = "[bash-error-hints]";

interface Hint {
  /** Regex tested against the combined bash output (stdout + stderr). */
  pattern: RegExp;
  /**
   * Hint text. May reference capture groups from `pattern` via `$1`, `$2`, …
   * Keep to one line; the model only needs the next-probe pointer.
   */
  hint: string;
}

const HINTS: Hint[] = [
  // ── git tracking footguns ───────────────────────────────────────────────
  {
    // `fatal: not under version control, source=FILE.md, destination=...`
    pattern: /fatal:\s*not under version control,\s*source=(\S+?),/,
    hint:
      "'$1' is likely matched by a .gitignore rule (a blanket `*.md` or similar). " +
      "Verify with `git check-ignore -v $1`. " +
      "Fix by either editing .gitignore, force-tracking with `git add -f $1`, or using plain `mv` if you don't need rename history.",
  },
  {
    // `error: pathspec 'X' did not match any file(s) known to git`
    pattern: /error:\s*pathspec '([^']+)' did not match any file/,
    hint:
      "'$1' is unknown to git in this cwd. Likely causes (in order): file is in .gitignore, file is untracked, you're in the wrong cwd, or the path has a typo. " +
      "Probe with `git check-ignore -v $1; git ls-files | rg -F $1; pwd`.",
  },
  {
    // `fatal: refusing to lose untracked file at 'X'`
    pattern: /fatal:\s*refusing to lose untracked file at '([^']+)'/,
    hint:
      "Destination '$1' is an untracked file. Move/remove it first, or use `--force` if you intend to overwrite. " +
      "Don't use `git rm` — that errors on untracked.",
  },
  {
    // `fatal: not a git repository`
    pattern: /fatal:\s*not a git repository/,
    hint:
      "Wrong cwd. Probe with `pwd; git rev-parse --show-toplevel 2>&1`. " +
      "Most likely you forgot a `cd` step earlier in this session.",
  },
  {
    // `fatal: <branch>: not a valid object name`
    pattern: /fatal:\s*([^\s:]+):\s*not a valid object name/,
    hint:
      "'$1' isn't a known ref/commit/branch. " +
      "Probe with `git branch -a; git tag --list; git log --oneline -5` to find the actual name.",
  },

  // ── filesystem ──────────────────────────────────────────────────────────
  {
    // `mv: cannot stat 'X': No such file or directory`
    pattern: /mv:\s*cannot stat '([^']+)':\s*No such file or directory/,
    hint:
      "Source '$1' doesn't exist at that path. " +
      "Probe with `ls -la $(dirname '$1')` to see what's actually there. Often a typo or stale path from earlier in session.",
  },
  {
    // Generic `command not found` from bash
    pattern: /bash:\s*([^\s:]+):\s*command not found/,
    hint:
      "'$1' isn't in PATH. " +
      "Check with `command -v $1; which $1; type $1`. May need install (pacman/apt/brew) or a different binary name.",
  },
  {
    // Permission denied on file write/read
    pattern: /([^\s:]+):\s*Permission denied/,
    hint:
      "Permission issue on '$1'. " +
      "Probe with `ls -la $1; stat $1; id` to see ownership vs current user. Don't blanket-sudo — fix the perms or run as the owning user.",
  },

  // ── pi / agent internals ────────────────────────────────────────────────
  {
    // Anthropic stream cutoff (already auto-retries in pi 0.74.1+, but
    // when the retry budget is exhausted the model still sees this)
    pattern: /Anthropic stream ended before message_stop/,
    hint:
      "Upstream stream-cutoff. Pi 0.74.1+ auto-retries this; if it's still surfacing, the retry budget was exhausted. " +
      "Just retry the same prompt — different edge node usually succeeds. If it persists, file at earendil-works/pi referencing #4433.",
  },
];

/**
 * Render a hint by substituting $1..$9 from the regex match.
 * Mirrors String.prototype.replace's $-handling so authors can use familiar
 * syntax (`$1`) inside hint text without us reaching for a templating lib.
 */
function renderHint(template: string, match: RegExpMatchArray): string {
  return template.replace(/\$([1-9])/g, (_, idx) => match[Number(idx)] ?? "");
}

/**
 * Combined stdout+stderr text from a tool_result content array.
 * Pi's bash tool emits a single text part with the merged output, but be
 * defensive — concatenate any text parts we find.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
      out += String((part as { text: unknown }).text ?? "");
      out += "\n";
    }
  }
  return out;
}

interface ToolResultContent {
  type: "text";
  text: string;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash") return undefined;

    const text = extractText(event.content);
    if (!text) return undefined;

    // Idempotency — never stack hints if we somehow run twice.
    if (text.includes(HINT_MARKER)) return undefined;

    const hits: string[] = [];
    for (const { pattern, hint } of HINTS) {
      const m = text.match(pattern);
      if (m) hits.push(renderHint(hint, m));
    }
    if (hits.length === 0) return undefined;

    const decorated = `${text.trimEnd()}\n\n${HINT_MARKER}\n${hits.map((h) => `• ${h}`).join("\n")}`;

    const newContent: ToolResultContent[] = [{ type: "text", text: decorated }];
    return { content: newContent };
  });
}
