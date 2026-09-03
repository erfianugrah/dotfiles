/**
 * tool-guard-core - pure anti-pattern detection for the tool-guard extension.
 * ZERO harness imports (no @earendil-works/*). node stdlib + globals only.
 *
 * Source of truth for both the pi adapter (../tool-guard.ts, block-with-reason
 * tool_call hook) and the Claude Code PreToolUse hook
 * (../../../.claude/hooks/tool-guard.ts, which DENYs with a reason). The two
 * harnesses share one detection table so a guarded anti-pattern behaves
 * identically in either.
 *
 * What lives here (pure):
 *   - BASH_RULES / WRITE_RULES: the anti-pattern regex tables + reasons.
 *   - splitSegments / stripAnsiCSpans: bash command tokenisation helpers.
 *   - evaluateBashCommand / evaluateWritePath / checkWebfetchDocs: the pure
 *     decision functions both harnesses call.
 *   - reformulation-loop + docs-first + research-route decision logic (pi-only
 *     surfaces, kept here so the pi test suite's imports resolve from one place).
 *
 * What stays in the harness adapters (NOT here):
 *   - Reading stdin / pi.on() wiring, per-session state maps, ctx.ui, the topic
 *     cache disk I/O and SSH refresh (side-effectful; pi-only).
 */

// ---- Reformulation-loop guard tables ----
const SEARCH_TOOLS = new Set([
  "websearch",
  "codesearch",
  "docs_search",
  "docs_find",
  "session_search",
  "context7_resolve_library_id",
]);
const DRILL_IN_TOOLS = new Set([
  "webfetch",
  "web_research",
  "docs_read",
  "docs_grep",
  "docs_summary",
  "context7_query_docs",
  "read",
  "lsp",
]);
const LOOP_THRESHOLD = 3;

// ---- Docs-first chain guard ----
export const WEB_SEARCH_TOOLS = new Set(["websearch", "web_research"]);

// High-precision non-technical intents: docs.erfi.io holds ONLY technical docs.
const NON_TECHNICAL_QUERY = new RegExp(
  [
    "\\bbuy(ing)?\\b", "\\bpurchase\\b", "\\bshop(ping)?\\b", "\\bcheapest\\b",
    "\\bdeals?\\b", "\\bprices?\\b", "\\bpricing\\b", "\\bcost of\\b",
    "\\brestaurants?\\b", "\\bhawker\\b", "\\bcafes?\\b", "\\bfood\\b",
    "\\bhotels?\\b", "\\bflights?\\b", "\\bweather\\b", "\\bnews\\b",
    "\\bheadlines?\\b", "\\bmovies?\\b", "\\bshowtimes?\\b",
    "\\bopening hours\\b", "\\bnear me\\b", "\\bin singapore\\b", "\\bin sg\\b",
  ].join("|"),
  "i",
);

// Derive matchable topic words from docs source names. Exported for unit tests.
export function extractTopics(sources: string[]): string[] {
  const topics = new Set<string>();
  for (const raw of sources) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    const noApi = name.replace(/-api$/, "");
    for (const cand of [name, noApi]) {
      if (cand.length >= 3) topics.add(cand);
    }
  }
  return [...topics];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// First topic that appears as a whole word in the query, else null.
export function matchDocsTopic(query: string, topics: string[]): string | null {
  if (!query || topics.length === 0) return null;
  const q = query.toLowerCase();
  for (const t of topics) {
    if (new RegExp(`\\b${escapeRe(t)}\\b`, "i").test(q)) return t;
  }
  return null;
}

export type DocsFirstInput = { query?: string; mode?: string };
export type DocsFirstDecision =
  | { block: false; via: "mode" | "non-technical" | "no-topic" }
  | { block: true; matchedTopic: string | null };

// Pure decision for the docs_first guard. `topics` is the cached docs topic
// list, or null when the cache is unavailable (falls back to blanket block).
export function decideDocsFirst(
  toolName: string,
  input: DocsFirstInput,
  topics: string[] | null,
): DocsFirstDecision {
  if (toolName === "web_research" && (input.mode === "local" || input.mode === "fresh")) {
    return { block: false, via: "mode" };
  }
  const query = (input.query ?? "").trim();
  if (query && NON_TECHNICAL_QUERY.test(query)) {
    return { block: false, via: "non-technical" };
  }
  if (topics !== null) {
    const matched = matchDocsTopic(query, topics);
    if (!matched) return { block: false, via: "no-topic" };
    return { block: true, matchedTopic: matched };
  }
  return { block: true, matchedTopic: null };
}

// ---- Bash anti-pattern rules ----
// ---- lsp routing: symbol lookup via text search -------------------------
//
// Measured 2026-08-30 over 1409 sessions / 5844 tool calls: `lsp` had ZERO
// calls while `grep` had 75 and bash-grep/rg carried ~60 more declaration
// lookups. lsp was verified working (document_symbols returns a full outline
// instantly), so it is invisible, not broken.
//
// Precision is the whole design constraint here: only 7 of those 75 grep
// patterns (9.3%) were declaration-shaped; the other 68 were legitimate text
// search that must NOT be touched. So this matches a declaration KEYWORD
// followed by an identifier - not bare identifiers, not comment/string scans.
// Advisory (never blocks): the right call depends on intent the guard can't
// see, e.g. "find every place this word appears including docs".

const DECL_KEYWORDS = "function|class|interface|type|struct|impl|def|func|enum|trait";

/** True when a search pattern looks like a symbol DECLARATION lookup. */
export function looksLikeSymbolSearch(pattern: string): boolean {
  if (!pattern) return false;
  // Strip regex word-boundary noise so `\bfunc NewClient` still matches.
  const p = pattern.replace(/\\b/g, "").replace(/\\/g, "");
  // Declaration keyword + whitespace + an identifier character.
  return new RegExp(`\\b(${DECL_KEYWORDS})\\s+[A-Za-z_*(]`).test(p);
}

export function lspRouteNote(pattern: string): string {
  return (
    `tool-guard[lsp_route]: "${pattern.slice(0, 60)}" looks like a symbol declaration lookup. ` +
    `The \`lsp\` tool answers this precisely - \`definition\` for where it is declared, ` +
    `\`references\` for every call site, \`document_symbols\` for a file outline, ` +
    `\`incoming_calls\` for the call graph. Regex matches comments, strings and ` +
    `unrelated files; LSP uses the same index your editor does. ` +
    `(Advisory - if you genuinely want every textual occurrence, text search is correct. Measured: lsp 0 calls vs grep 75 across 1409 sessions.)`
  );
}

// ---- docs pipeline inversion --------------------------------------------
//
// Measured 2026-08-30: docs_sources 19 > docs_search 7 > docs_summary 2 - the
// fallback outranks the entry point 3:1. Observed docs_sources filters were
// content queries ("singapore", "psychology", "furniture", "tea"), i.e. topic
// searches aimed at a tool that only lists source names. tool-routing.md is
// explicit: "do NOT call docs_sources (that lists sources, it is not a search
// fallback)".
//
// A 1-token filter is the DOCUMENTED use (verify a source exists), so only
// nudge on multi-word / long filters that betray search intent. Advisory.

/** True when a docs_sources filter looks like a content query, not a source-name check. */
export function docsSourcesMisuse(filter: string | undefined): boolean {
  if (!filter) return false;               // bare listing: documented use
  const f = filter.trim();
  if (f.length === 0) return false;
  return /\s/.test(f) || f.length > 20;    // multi-word or long = search intent
}

export function docsSourcesNote(filter: string): string {
  return (
    `tool-guard[docs_inversion]: docs_sources only LISTS source names - it is not a search. ` +
    `"${filter.slice(0, 40)}" looks like a content query. Use \`docs_search\` (searches the ` +
    `title+summary index, ~15x smaller than raw docs) with 1-2 keyword tokens, then ` +
    `\`docs_summary\` on files >300 lines, then \`docs_read\` with offset/lines. ` +
    `For a known phrase inside a known source, \`docs_grep path=/docs/<source>/\` beats both. ` +
    `(Advisory. Measured: docs_sources 19 > docs_search 7 - the fallback outranking the entry point.)`
  );
}

// Hard-block rules: regex on bash command, plus a redirect message.
export type BlockRule = {
  id: string;
  pattern: RegExp;
  reason: string;
  segment?: boolean; // if true, test against each `&&|;|||` segment, not the whole command
  // Optional predicate that overrides `pattern` for the match decision.
  //
  // `full` is the ENTIRE original command, which a segment-scoped rule needs for
  // pipe-aware exemptions: splitSegments() splits on `|` too, so a rule that
  // wants to allow `rg --files . | wc -l` can never see the `| wc` from its own
  // segment (it is a different segment). Bug found live 2026-08-30 - the
  // previous exemption was unreachable through the real code path because it
  // only inspected `seg`.
  test?: (seg: string, full: string) => boolean;
};

// Strip bash ANSI-C quoting spans (`$'...'`) from a command.
export function stripAnsiCSpans(s: string): string {
  return s.replace(/\$'(?:[^'\\]|\\.)*'/g, "");
}

export const BASH_RULES: BlockRule[] = [
  {
    id: "ls_docs",
    pattern: /^\s*ls\s+(\S*\s+)*\/docs\b/,
    reason:
      "`/docs/` is not local filesystem - it lives on docs.erfi.io and is only reachable via the `docs_*` tools. Use `docs_sources <filter>` to verify a source exists, or `docs_find pattern=<glob>` to list files by name.",
    segment: true,
  },
  {
    id: "find_docs",
    pattern: /^\s*find\s+(\S*\s+)*\/docs\b/,
    reason:
      "Use `docs_find pattern=<glob>` (filename) or `docs_search query=<keyword> source=<source>` (content) instead of `find /docs/...`. The /docs tree is on docs.erfi.io, not local disk.",
    segment: true,
  },
  {
    id: "cat_docs",
    pattern: /^\s*cat\s+\/docs\b/,
    reason: "Use `docs_read path=/docs/...` instead of `cat /docs/...`. /docs is remote, not local.",
    segment: true,
  },
  {
    id: "grep_r",
    pattern: /^\s*grep\s+(-\S*r\S*|--recursive)/,
    reason:
      "Prefer the `Grep` tool (regex content search, mtime-sorted output) over `grep -r`. Or use `rg <pattern>` directly if you need a specific rg flag the tool doesn't expose.",
    segment: true,
  },
  {
    // Escape hatch (2026-08-30): AGENTS.md already carves out find for the
    // capabilities ripgrep/glob lack (-newermt, -printf, -mtime, -size), but the
    // guard blocked them anyway - a rule stricter than the policy it enforces.
    id: "find_name",
    pattern: /^\s*find\b[^&;|]*\s-name\b/,
    test: (seg: string) =>
      /^\s*find\b[^&;|]*\s-name\b/.test(seg) &&
      !/\s-(newer[mac]?t?|printf|mtime|ctime|atime|size|perm|user|group|delete|exec)\b/.test(seg),
    reason:
      "Prefer the `Glob` tool for filename matching (e.g. `pattern='**/*.ts'`). `find -name` is slower (no gitignore awareness) and harder to read. (Exempt: combined with -newermt/-printf/-mtime/-size/-exec etc - those are capabilities glob genuinely lacks.)",
    segment: true,
  },
  {
    id: "find_path",
    pattern: /^\s*find\b[^&;|]*\s-path\b/,
    reason: "Prefer the `Glob` tool for path-pattern matching. `find -path` is slower and harder to read.",
    segment: true,
  },
  {
    // Escape hatch (2026-08-30): `glob` caps at 100 mtime-sorted results, so it
    // CANNOT enumerate a large tree for aggregate work (e.g. counting tool calls
    // across 1409 session files). Blocking those was a false positive that cost
    // two retries. Allow when the output is piped/redirected into an aggregation
    // step - that shape is never "agent wants to eyeball some filenames".
    id: "rg_files",
    pattern: /^\s*rg\s+(-\S*\s+)*--files\b/,
    test: (seg: string, full: string) =>
      /^\s*rg\s+(-\S*\s+)*--files\b/.test(seg) &&
      // Exemption is evaluated against the FULL command: the pipe target lands
      // in a separate segment, so `seg` alone can never prove aggregation.
      !/[|>]|\$\(|`|\bxargs\b|\bwc\b|\bsort\b|\buniq\b/.test(full),
    reason:
      "Prefer the `Glob` tool (wraps `rg --files -g`). It returns mtime-sorted results with a structured truncation footer. (Exempt: piping/redirecting into wc/sort/uniq/xargs or a file - glob caps at 100 results and can't do aggregate enumeration.)",
    segment: true,
  },
  {
    id: "curl_search",
    pattern: /^\s*curl\s+[^|&;]*\b(google\.com|bing\.com|duckduckgo\.com|search\.brave|kagi|searxng(?!\.erfi\.io))\b/i,
    reason:
      "Never `curl` a search engine. Use the `WebSearch` tool for discovery, or the research skill's SearXNG fallback at :8888. Exempt: the self-hosted stack (searxng.erfi.io, crawler.erfi.io) - curl those freely per the research skill.",
    segment: true,
  },

  // ---- patterns observed in user's actual session history ----

  {
    id: "npm_when_bun",
    pattern: /^\s*npm\s+(install|i|run|ci|test|exec)\b/,
    reason:
      "This user's projects use bun by default (see frontend-stack skill). Use `bun install` / `bun run` / `bun test` / `bunx`. Only fall back to npm if bun-incompatibility is proven for this specific dependency.",
    segment: true,
  },
  {
    id: "pnpm_in_bun_project",
    pattern: /^\s*pnpm\s+(install|i|run|exec)\b/,
    reason:
      "User's default JS package manager is bun. Use `bun install` / `bun run` / `bunx`. pnpm is reserved for explicit monorepo cases where the user has chosen it (check for pnpm-workspace.yaml first).",
    segment: true,
  },
  {
    id: "npx_when_bunx",
    pattern: /^\s*npx\s+/,
    reason: "Use `bunx <pkg>` instead of `npx <pkg>`. Faster, same semantics in 99% of cases.",
    segment: true,
  },
  {
    id: "sed_inplace_large_file",
    pattern: /^\s*sed\s+-i\b[^|&;]*\.(ts|tsx|js|jsx|mjs|cjs|go|py|rs|java|kt|swift|cpp|c|h|hpp)['\"\s]/,
    reason:
      "For source-file rewrites, prefer `sd 'pattern' 'replacement' file` (literal, no regex foot-guns) or `ast-grep --rewrite` (AST-precise, won't match strings/comments). `sed -i` regex on source files routinely captures unintended matches.",
    segment: true,
  },
  {
    // Escape hatch (2026-08-30): this rule's own reason text says raw ssh "is
    // fine when you specifically need raw stderr", but it was a HARD BLOCK with
    // no way to express that need - a rule stricter than the policy it states.
    // It fired twice in one session while the sanctioned path
    // (GET /api/v1/containers/<name>/logs) was returning HTTP 500, leaving no
    // route to the logs at all.
    //
    // Now: append `# raw-stderr` (or 2>&1 with a stderr-specific grep) to
    // assert the documented exception. Deliberately a marker rather than a
    // silent allow, so the choice stays visible in the transcript.
    id: "docker_logs_servarr",
    pattern: /^\s*ssh\s+[\s\S]*?\bservarr\b[\s\S]*?\bdocker\s+logs\b/,
    test: (seg: string, full: string) =>
      /^\s*ssh\s+[\s\S]*?\bservarr\b[\s\S]*?\bdocker\s+logs\b/.test(seg) &&
      !/#\s*raw-stderr\b/.test(full),
    reason:
      "For containers on servarr (composer-managed), prefer the composer API for logs - `curl $COMPOSER/api/v1/services/<id>/logs?tail=...` gives tail + filter + structured response. Local-host docker (this dev box, ~/llm-compose, etc.) is not in composer - bare `docker logs` there is correct. If you specifically need raw stderr that composer has not captured (or the composer logs endpoint is erroring), append `# raw-stderr` to the command to assert that exception.",
    segment: true,
  },
  {
    // Escape hatch (2026-08-30): the point of this rule is "don't dump a whole
    // file into context unstructured" - which only applies when the output
    // REACHES context. `head -100000 f > out` or `| wc -l` never does.
    id: "head_full_file",
    pattern: /^\s*head\s+(-n\s*)?-?\d{4,}\s+\S/,
    test: (seg: string, full: string) =>
      /^\s*head\s+(-n\s*)?-?\d{4,}\s+\S/.test(seg) &&
      !/[|>]|\$\(|`/.test(full),
    reason:
      "For reading whole files, use the `Read` tool (gives line numbers + length header). `head -n 99999` is just a slower `cat` and dumps unstructured. (Exempt: piped or redirected - that output never reaches context.)",
    segment: true,
  },
  {
    id: "unsigned_git_commit",
    pattern: /^\s*git\s+(-c\s+commit\.gpg[sS]ign=false\b|.*--no-gpg-sign\b)/,
    reason:
      "This user REQUIRES GPG-signed commits (commit.gpgsign=true is set globally, key B9D283E8AE4E56B4). NEVER bypass signing. If the commit failed with 'gpg failed to sign the data', the agent cache is cold - warm it with `zsh -ic 'gpg_unlock'` (bw-seeded, no TTY needed) and retry the SAME command.",
    segment: true,
  },
  {
    id: "create_tanstack_router_hallucinated",
    pattern: /^\s*(bun|npx|pnpm)\s+(create|dlx)\s+@tanstack\/(router|create-router)\b/,
    reason:
      "`@tanstack/router` is not the scaffolder. Use `bun create tsrouter-app@latest <name>` (or `npx create-tsrouter-app@latest <name>`). Supports `--template file-router`, `--framework solid`, `--add-ons shadcn,tanstack-query`, `--toolchain biome`. See the `frontend-stack` skill.",
    segment: true,
  },
  {
    id: "sudo_systemctl_restart",
    pattern: /^\s*sudo\s+systemctl\s+(restart|stop|start|enable|disable)\s+/,
    reason:
      "Direct `systemctl restart` is rarely correct on this user's hosts - services are usually managed by docker compose, composer (gitops), or k3s. Check first: is it a compose stack? (`docker compose -f ~/<svc>-compose/docker-compose.yml restart <svc>`). A k3s deployment? (`kubectl rollout restart deploy/<svc>`). Only fall back to systemctl if it's truly a host-level systemd unit (sshd, networking, etc.).",
    segment: true,
  },
  {
    id: "kubectl_without_context",
    pattern: /^\s*kubectl\s+(delete|drain|cordon|uncordon|edit|patch|apply\s+--dry-run=false|rollout\s+(restart|undo))/,
    reason:
      "You're about to run a mutating kubectl command. First verify the context: `kubectl config current-context` - confirm it's the cluster you intend (k3s? remote? minikube?). The user has multiple kube-clusters on different hosts. A kubectl delete in the wrong context is one of the worst foot-guns.",
    segment: true,
  },
  {
    id: "psql_direct_connect",
    pattern: /^\s*psql\s+(-h\s+\S+|--host=\S+|postgres(ql)?:\/\/)/,
    reason:
      "Direct `psql` connections are for ad-hoc inspection only. If the project has sqlc / drizzle / supabase CLI, use those for actual queries (they're type-safe and respect schema). If you genuinely need psql for inspection, this command is fine - just confirm you're not bypassing migrations or schema discipline.",
    segment: true,
  },
  {
    id: "bash_eval_curl",
    // Tested against the WHOLE command (segment:false): the pattern needs the
    // interior `|`, which splitSegments would otherwise consume. Not ^-anchored
    // so `foo && curl url | sh` is caught, not just a leading curl.
    pattern: /\b(curl|wget)\s+[^|&;]*\|\s*(sudo\s+)?(bash|sh|zsh)\b/,
    reason:
      "`curl | sh` blindly executes whatever the remote serves. Download first to a file, inspect, then run - OR install via the platform's package manager. Even for trusted installs (nvm, rustup), prefer the manual two-step.",
    segment: false,
  },
  {
    id: "chmod_777",
    pattern: /^\s*chmod\s+(-R\s+)?(0?777|a\+rwx)\b/,
    reason:
      "`chmod 777` is almost never the right answer - it grants write to everyone. Use 755 (dirs / executables), 644 (regular files), 600 (secrets), 700 (private dirs). If you're hitting a permission error in a container, the fix is usually PUID/PGID env vars (1000/100 on this user's boxes), not 777.",
    segment: true,
  },
  {
    id: "unicode_escape_in_bash",
    pattern: /\\u[0-9a-fA-F]{4}/,
    test: (seg) => /\\u[0-9a-fA-F]{4}/.test(stripAnsiCSpans(seg)),
    reason:
      "Bash doesn't interpret `\\uXXXX` JS-style unicode escapes inside regular quotes - they end up as literal 6-char sequences in your output (most painfully in `git commit -m`). Two correct options: (1) paste the actual character into the string (em-dash, en-dash, arrow, etc.); (2) use bash ANSI-C quoting: `$'\\u2014'`. Recommended: just use the real character.",
    segment: false,
  },
  {
    id: "force_push_protected",
    // Order-independent (lookaheads): a force indicator (-f/--force or a `+ref`
    // refspec) AND a protected branch, in either order - catches both
    // `git push --force origin main` and `git push origin main --force` and
    // `git push origin +main`.
    pattern: /^\s*git\s+push\b(?=.*(?:-f\b|--force\b|\s\+\S))(?=.*\b(?:main|master|dev|production|prod)\b)/,
    reason:
      "Force-pushing to main/master/dev/prod can erase teammates' work. Confirm the branch is yours alone and the remote is up to date. If you really need it, use `--force-with-lease` (refuses if the remote moved). Better: open a PR with the force-pushed branch separately.",
    segment: true,
  },
];

// ---- Write-tool guards ----
export type WriteRule = {
  id: string;
  pattern: RegExp; // matches against the filesystem path
  reason: string;
};

export const WRITE_RULES: WriteRule[] = [
  {
    id: "edit_dotenv",
    pattern: /(^|\/)\.env(\.|$)/,
    reason:
      "Direct `.env` edits drift from Vaultwarden (the canonical secret store for this user). Add/change the secret in vault first (`vw_save <field>` from ~/dotfiles bitwarden helpers), then run the project's env-rehydrate step. If this IS a vault-rehydration write, the warning is safe to acknowledge and proceed.",
  },
  {
    id: "edit_lockfile",
    pattern: /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|go\.sum)$/,
    reason:
      "Lockfiles are auto-generated by the package manager. Don't edit them directly - instead change `package.json` / `Cargo.toml` / `pyproject.toml` and run install (bun install / cargo update / etc.). Direct lockfile edits break reproducibility and confuse tooling.",
  },
  {
    id: "edit_git_internals",
    pattern: /(^|\/)\.git\/(config|HEAD|refs\/|hooks\/|COMMIT_EDITMSG)/,
    reason:
      "`.git/` internals shouldn't be edited directly. Use the corresponding git command: `git config` (for .git/config), `git branch -m` (for HEAD/refs), `git commit --amend` (for COMMIT_EDITMSG). Direct edits can corrupt the repo.",
  },
  {
    id: "edit_node_modules",
    pattern: /(^|\/)node_modules\//,
    reason:
      "Don't edit files in `node_modules/` - changes get blown away on the next `bun install`. If you need to patch a dependency, use `patch-package` (creates a permanent diff in `patches/`).",
  },
];

// Detect when a fetch is aimed at a docs.erfi.io URL - the content is on the
// docs SSH server and reachable via the docs_* tools. Returns a redirect
// message, or null if the URL is not docs.erfi.io / malformed.
export function checkWebfetchDocs(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "docs.erfi.io") {
      const docsPath = `/docs${u.pathname}`.replace(/\/$/, "");
      return `webfetch on docs.erfi.io is wasteful - the content is on the docs SSH server and reachable via the docs_* tools. Use \`docs_read path=${docsPath}\` (full file) or \`docs_grep query=<pattern> path=${docsPath}\` (within file/dir). If you don't know the exact path yet, start with \`docs_sources <filter>\` or \`docs_search query=<keyword> source=<source>\`.`;
    }
  } catch {
    /* malformed URL - let the fetch handle it */
  }
  return null;
}

// Splits a bash command into best-effort segments at shell operators.
// Splits on newline and single `&` (background) too, so a rule-triggering
// command on a line after the first, or backgrounded with `&`, is not hidden
// from the ^-anchored per-segment rules. Over-splitting (e.g. `2>&1`) is safe:
// it only yields more segments to check, never fewer.
export function splitSegments(command: string): string[] {
  return command.split(/&&|\|\||;|\||&|\r?\n/);
}

// ---- Pure orchestrator decisions (shared by pi + CC) ----

export type GuardHit = { id: string; reason: string };

// Evaluate a bash command against BASH_RULES. Returns the first rule hit, or
// null if clean. `disabled` suppresses specific rule ids.
export function evaluateBashCommand(
  command: string,
  disabled: Set<string> = new Set(),
): GuardHit | null {
  if (typeof command !== "string") return null;
  for (const rule of BASH_RULES) {
    if (disabled.has(rule.id)) continue;
    const probe = rule.segment ? splitSegments(command) : [command];
    for (const seg of probe) {
      const matched = rule.test ? rule.test(seg) : rule.pattern.test(seg);
      if (matched) return { id: rule.id, reason: rule.reason };
    }
  }
  return null;
}

// Evaluate a write/edit target path against WRITE_RULES. First hit or null.
export function evaluateWritePath(
  filePath: string,
  disabled: Set<string> = new Set(),
): GuardHit | null {
  if (typeof filePath !== "string") return null;
  for (const rule of WRITE_RULES) {
    if (disabled.has(rule.id)) continue;
    if (rule.pattern.test(filePath)) return { id: rule.id, reason: rule.reason };
  }
  return null;
}

// ---- reformulation-loop guard (pi-only surface; state passed in) ----
export type LoopState = {
  recentSearches: Array<{ tool: string; ts: number; tokens?: Set<string> }>;
  lastDrillInTs: number;
};

const QUERY_FUNCTION_WORDS = new Set([
  "a", "an", "the", "of", "for", "to", "in", "on", "and", "or", "vs",
  "is", "are", "was", "were", "do", "does", "did", "i", "me", "my",
  "we", "you", "your", "it", "its", "this", "that", "these", "those",
  "with", "from", "at", "by", "be", "as", "so", "if", "not", "no",
  "can", "could", "should", "would", "how", "what", "which", "when",
  "where", "who",
]);

export function queryTokens(query: string): Set<string> {
  const out = new Set<string>();
  for (let tok of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length < 2) continue;
    if (tok === "sg") tok = "singapore";
    if (tok.length > 3 && tok.endsWith("s")) tok = tok.slice(0, -1);
    if (QUERY_FUNCTION_WORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

export function tokenContainment(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return 0;
  let n = 0;
  for (const t of small) if (large.has(t)) n++;
  return n / small.size;
}

const REFORMULATION_CONTAINMENT = 0.7;

// Pure reformulation-loop check. Mutates `state` (caller owns it, keyed by
// session) and returns an advisory message when a loop is detected, else null.
export function checkReformulationLoop(
  toolName: string,
  state: LoopState,
  query?: string,
): string | null {
  const now = Date.now();

  if (DRILL_IN_TOOLS.has(toolName)) {
    state.lastDrillInTs = now;
    return null;
  }

  if (!SEARCH_TOOLS.has(toolName)) return null;

  state.recentSearches = state.recentSearches.filter(
    (s) => s.ts > state.lastDrillInTs,
  );

  const tokens = query ? queryTokens(query) : undefined;
  const prev = state.recentSearches[state.recentSearches.length - 1];
  if (
    tokens && tokens.size > 0 &&
    prev?.tokens && prev.tokens.size > 0 &&
    tokenContainment(tokens, prev.tokens) < REFORMULATION_CONTAINMENT
  ) {
    state.recentSearches = [];
  }

  state.recentSearches.push({ tool: toolName, ts: now, tokens });

  if (state.recentSearches.length >= LOOP_THRESHOLD + 1) {
    const counts = new Map<string, number>();
    for (const s of state.recentSearches) {
      counts.set(s.tool, (counts.get(s.tool) ?? 0) + 1);
    }
    const total = state.recentSearches.length;
    const breakdown = [...counts.entries()].map(([t, n]) => `${t}x${n}`).join(", ");
    state.recentSearches = [];
    return `Reformulation loop detected: ${total} similar search calls (${breakdown}) since the last drill-in. If you are rewording the same query, open the most likely result instead: docs_search -> docs_read (or docs_grep path=/docs/<source>/ to escalate after a zero-results docs_search), websearch -> webfetch or web_research, codesearch -> read on the linked file, context7_resolve -> context7_query_docs. If these are genuinely distinct facets, ignore this note; if results don't fit your need, ask the user to clarify rather than searching again.`;
  }

  return null;
}

// ---- Research-stack routing guard ----
export const RESEARCH_INTENT_RE =
  /\buse\s+(?:the\s+|my\s+)?research\s+(?:tools?|stack)\b|\bsearxng\.erfi\.io\b|\bcrawler\.erfi\.io\b/i;

const QUOTED_SPAN_RE = /`[^`\n]*`|"[^"\n]*"|'[^'\n]*'/g;

export function detectResearchIntent(text: string): boolean {
  if (!text) return false;
  return RESEARCH_INTENT_RE.test(text.replace(QUOTED_SPAN_RE, " "));
}

export const RESEARCH_STACK_MODES = new Set(["local", "fresh", "crosscheck"]);
const RESEARCH_HOSTS_RE = /\b(?:searxng|crawler)\.erfi\.io\b/;
const RESEARCH_ROUTE_MAX_BLOCKS = 2;

const RESEARCH_ROUTE_BLOCK_REASON =
  "tool-guard[research_route]: the user explicitly asked for the research tools - that means the self-hosted research stack, not Exa. " +
  "Search: curl -s 'https://searxng.erfi.io/search?q=<urlencoded>&format=json'. " +
  "Fetch: curl -s -X POST 'https://crawler.erfi.io/extract' -H 'Content-Type: application/json' -d '{\"url\":\"<url>\"}' (field: markdown; \"force_js\":true for SPAs). " +
  "Add -H \"Authorization: Bearer $RESEARCH_TOKEN\" when off-LAN. Full API: ~/.pi/agent/skills/research/SKILL.md. " +
  "(web_research with mode local/fresh/crosscheck also complies - it routes through this stack. " +
  `Guard lifts after ${RESEARCH_ROUTE_MAX_BLOCKS} blocks if the stack is genuinely unreachable.)`;

export type ResearchRouteInput = {
  query?: string;
  mode?: string;
  url?: string;
  command?: string;
};
export type ResearchRouteDecision =
  | { action: "allow" }
  | { action: "comply" }
  | { action: "block"; reason: string };

export function decideResearchRoute(
  toolName: string,
  input: ResearchRouteInput,
  blocksSoFar: number,
): ResearchRouteDecision {
  if (toolName === "bash") {
    return RESEARCH_HOSTS_RE.test(input.command ?? "")
      ? { action: "comply" }
      : { action: "allow" };
  }
  if (toolName === "web_research" && RESEARCH_STACK_MODES.has(input.mode ?? "")) {
    return { action: "comply" };
  }
  if (toolName === "websearch" || toolName === "webfetch" || toolName === "web_research") {
    if (blocksSoFar >= RESEARCH_ROUTE_MAX_BLOCKS) return { action: "allow" };
    return { action: "block", reason: RESEARCH_ROUTE_BLOCK_REASON };
  }
  return { action: "allow" };
}

export function decideResearchRouteSoft(
  toolName: string,
  input: { query?: string; mode?: string },
): boolean {
  // websearch (always bare) or web_research in default mode (NOT local/fresh/crosscheck).
  if (toolName === "websearch") {
    return NON_TECHNICAL_QUERY.test((input.query ?? "").trim());
  }
  if (toolName === "web_research") {
    const mode = (input.mode ?? "").trim();
    if (mode && mode !== "default") return false; // local/fresh/crosscheck already routes through research stack
    return NON_TECHNICAL_QUERY.test((input.query ?? "").trim());
  }
  return false;
}

// Extract every target path from an apply_patch envelope (pi-only surface).
export function extractPatchPaths(patchText: string): string[] {
  if (typeof patchText !== "string") return [];
  const out: string[] = [];
  for (const line of patchText.split(/\r?\n/)) {
    const m = line.match(/^\*\*\* (?:Add|Update|Delete|Move(?: to)?) File: (.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}
