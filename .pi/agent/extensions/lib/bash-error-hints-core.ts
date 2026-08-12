/**
 * bash-error-hints-core - pure footgun-hint detection. ZERO harness imports.
 * Source of truth for both the pi adapter (../bash-error-hints.ts, tool_result
 * mutation hook) and the Claude Code hook (../../../.claude/hooks/
 * bash-error-hints.ts, a PostToolUse annotation via additionalContext).
 *
 * All logic here is pure: the {pattern -> hint} table, the $-substitution
 * renderer, the matcher, and the oncePerSession splitter. The harness adapters
 * own the session-keyed fired-set state and the actual injection; this module
 * just makes the matching/rendering/filtering unit-testable and shared.
 *
 * Adding hints: append a {pattern, hint} pair to HINTS. Pattern matches the
 * combined bash output (stdout + stderr, and for pi the leading command echo).
 * Hint should be one line, actionable, name the next probe.
 */

export const HINT_MARKER = "[bash-error-hints]";

export interface Hint {
  /** Regex tested against the combined bash output (stdout + stderr). */
  pattern: RegExp;
  /**
   * Hint text. May reference capture groups from `pattern` via `$1`, `$2`, …
   * Keep to one line; the model only needs the next-probe pointer.
   */
  hint: string;
  /**
   * If true, this hint fires at most once per session. Use for tool-ROUTING
   * hints (as opposed to error-recovery hints): the first fire teaches the
   * routing rule, every repeat is pure noise. Error hints stay repeatable -
   * a second TSIG leak deserves a second rotation reminder.
   */
  oncePerSession?: boolean;
}

export const HINTS: Hint[] = [
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
    // `error: gpg failed to sign the data` / `signing failed: No pinentry`
    pattern: /gpg failed to sign the data|signing failed: No pinentry/,
    hint:
      "GPG signing is REQUIRED here - NEVER bypass with `--no-gpg-sign` or `-c commit.gpgsign=false`. " +
      "The gpg-agent cache is cold and this shell has no TTY for pinentry. " +
      "Warm it with `zsh -ic 'gpg_unlock'` (seeds from Vaultwarden via bw serve, no TTY needed), then retry the SAME command unchanged.",
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

  // ── git-author override (caught 2026-05-28: ~/discord-wipe has 7 commits
  //    with author=erfi@erfi.io because an agent freelanced the override and
  //    every subsequent agent saw the prior commits as precedent). Detects
  //    `git -c user.name=` or `git -c user.email=` in successful commands
  //    too — the hint is preventative, not just for failures. The combined
  //    bash output starts with the command echo when run through pi's
  //    bash tool, so the regex matches the command itself.
  {
    pattern: /git\s+-c\s+user\.(?:name|email)\s*=/,
    hint:
      "Author/committer override detected (`-c user.name=` / `-c user.email=`). DO NOT do this. The user's ~/.gitconfig is authoritative — it has `Erfi Anugrah <erfi.anugrah@gmail.com>` plus a GPG signing key. Past sessions invented `erfi@erfi.io` and the pattern propagated across 7 discord-wipe commits before being caught. Re-run as plain `git commit` (or `git commit -F <file>`) and let the global config apply.",
  },

  // ── secret-leak hazards (output captured into session log) ──────────────
  {
    // dig prints a `; TSIG: <key>` header line when -y is used. With stderr
    // unredirected this lands in the session log verbatim. Caught
    // 2026-05-25 leaking the erfi.io AXFR TSIG; rotation required after.
    pattern: /;\s*TSIG\s*[:=]\s*\S+/,
    hint:
      "dig leaked the TSIG key into stdout/stderr (`; TSIG: <name>` header line). The full base64 secret is now in the session JSONL on disk. " +
      "Rotate now: `openssl rand -base64 32`, push as Fly secret, update via knotc, save new value to Vaultwarden. " +
      "Future calls: `dig ... -y \"hmac-sha256:<key>:$SECRET\" 2>/dev/null` to suppress, or use `kdig --tsig=<file>` which doesn't echo the secret.",
  },
  {
    // Common shape: Authorization headers captured into curl -v / -i output.
    pattern: /Authorization:\s*(Bearer|token)\s+[A-Za-z0-9_\-.~+/]{20,}/,
    hint:
      "Authorization header captured into output — token now in the session log. " +
      "Rotate at the issuer (`gh auth refresh`, `flyctl tokens revoke`, etc.). " +
      "Future curl calls: avoid `-v` with secret headers, or pipe through `sed 's/Bearer [A-Za-z0-9._-]*/Bearer REDACTED/'`.",
  },

  // ── pi / agent internals ────────────────────────────────────────────────
  {
    // Reading a pi session JSONL via bash (cat/head/tail/jq/grep) — the
    // agent should be using `session_search` instead. Caught 2026-05-28 in a
    // prior session AND the meta-session reviewing it (recursive whoops).
    // Trigger: any path under ~/.pi/agent/sessions/ ending in .jsonl shows
    // up in bash output (either the command echo or the listing). Gated to
    // bash tool only (see hook below) so session_search's own output, which
    // also contains these paths, never self-triggers.
    //
    // oncePerSession: this is a routing hint, not an error. It used to fire
    // on EVERY bash output mentioning a session .jsonl - including the
    // legitimate forensics the hint text itself carves out (block-event
    // grep, tool-call sequencing), so a forensics-heavy session collected a
    // ~60-token nag on every single command. First fire teaches the rule;
    // repeats in the same session add nothing.
    oncePerSession: true,
    pattern: /\/\.pi\/agent\/sessions\/[^\s'"]+\.jsonl/,
    hint:
      "Path under ~/.pi/agent/sessions/ is a pi session log — use the `session_search` tool, not jq/cat/grep on the .jsonl. " +
      "session_search is FTS5-backed (sub-50ms, multi-word OR semantics, role filtering) and returns scored snippets. " +
      "Bash on the .jsonl is for one-off forensics the index can't answer (raw timestamps, model_change events, tool-call sequencing).",
  },
  {
    // Anthropic stream cutoff (already auto-retries in pi 0.74.1+, but
    // when the retry budget is exhausted the model still sees this)
    pattern: /Anthropic stream ended before message_stop/,
    hint:
      "Upstream stream-cutoff. Pi 0.74.1+ auto-retries this; if it's still surfacing, the retry budget was exhausted. " +
      "Just retry the same prompt — different edge node usually succeeds. If it persists, file at earendil-works/pi referencing #4433.",
  },
  {
    // Fly cert validation pending — common retry-loop trap. Caught 2026-05-25.
    pattern: /Status\s*[:=]\s*Awaiting (?:configuration|certificates)|No (?:A|AAAA) records were found/i,
    hint:
      "Fly cert validation pending — do NOT loop `flyctl certs check`/`remove`/`add`. Let's Encrypt rate-limits per-domain orders (5/week per registered base+domain), and Fly's verifier polls every ~5-10 min anyway. Most common cause is the recursive resolver caching the old answer for the full TTL window. Wait 15-20 min, then check ONCE.",
  },
];

/**
 * Render a hint by substituting $1..$9 from the regex match.
 * Mirrors String.prototype.replace's $-handling so authors can use familiar
 * syntax (`$1`) inside hint text without us reaching for a templating lib.
 */
export function renderHint(template: string, match: RegExpMatchArray): string {
  return template.replace(/\$([1-9])/g, (_, idx) => match[Number(idx)] ?? "");
}

export interface HintMatch {
  hint: Hint;
  rendered: string;
}

/**
 * Structured variant of matchHints - returns each hit paired with its Hint
 * so the hook can apply per-hint policy (oncePerSession) without losing the
 * association. Pure, exported for unit tests.
 */
export function matchHintsDetailed(text: string): HintMatch[] {
  const out: HintMatch[] = [];
  for (const hint of HINTS) {
    const m = text.match(hint.pattern);
    if (m) out.push({ hint, rendered: renderHint(hint.hint, m) });
  }
  return out;
}

/**
 * Run all HINT patterns against `text` and return the rendered hint strings
 * (in HINTS-array order). Pure function exposed for unit testing.
 */
export function matchHints(text: string): string[] {
  return matchHintsDetailed(text).map((m) => m.rendered);
}

/**
 * Split matches into (kept, newly-fired-once-hints) given the set of
 * once-hint pattern sources already fired this session. Pure - the caller
 * owns the state; this just makes the filtering unit-testable.
 */
export function applyOncePerSession(
  matches: HintMatch[],
  alreadyFired: ReadonlySet<string>,
): { kept: HintMatch[]; newlyFired: string[] } {
  const kept: HintMatch[] = [];
  const newlyFired: string[] = [];
  for (const m of matches) {
    if (m.hint.oncePerSession) {
      const key = m.hint.pattern.source;
      if (alreadyFired.has(key)) continue;
      newlyFired.push(key);
    }
    kept.push(m);
  }
  return { kept, newlyFired };
}

/**
 * Combined stdout+stderr text from a tool_result content array.
 * Pi's bash tool emits a single text part with the merged output, but be
 * defensive — concatenate any text parts we find. Also accepts a plain string.
 */
export function extractText(content: unknown): string {
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

/**
 * Build the decorated tool-output body. Pure: given the original text and the
 * kept matches, return the original with a marker-delimited hint block appended.
 * Returns null if there is nothing to add (no matches, or already decorated).
 */
export function decorate(text: string, kept: HintMatch[]): string | null {
  if (!text) return null;
  if (text.includes(HINT_MARKER)) return null;
  if (kept.length === 0) return null;
  return `${text.trimEnd()}\n\n${HINT_MARKER}\n${kept.map((m) => `• ${m.rendered}`).join("\n")}`;
}
