/**
 * tool-guard — intercept common anti-patterns BEFORE they fire and nudge
 * the LLM toward the right tool.
 *
 * This is pi-only territory — opencode has no equivalent. Pi's `tool_call`
 * event lets an extension block-with-reason, which the LLM sees in the
 * conversation and corrects on the next turn.
 *
 * Why a runtime guard instead of just system-prompt rules:
 *   - The LLM ignores prompt rules occasionally (audited: dozens of cases
 *     of `bash find` / `bash ls /docs/` / `webfetch <docs.erfi.io URL>` per
 *     session, even with explicit rules in APPEND_SYSTEM.md).
 *   - A block-with-reason is a hard signal — the model can't pretend it
 *     didn't see the rule.
 *
 * Guarded patterns (block + suggest correct tool):
 *
 *   bash ls /docs/...          → docs_sources / docs_find
 *   bash find /docs/...        → docs_find / docs_search
 *   bash cat /docs/...         → docs_read
 *   bash grep -r ...           → grep tool
 *   bash find ... -name ...    → glob tool (filename pattern)
 *   bash find ... -path ...    → glob tool
 *   bash rg --files ...        → glob tool (gitignore-aware filename match)
 *   bash curl <search-engine>  → websearch / web_research
 *   webfetch <docs.erfi.io>    → docs_read / docs_grep (the URL's content
 *                                 is on docs.erfi.io, query the source)
 *
 * Soft guards (warn but allow — used for patterns where the LLM may have
 * legitimate reasons):
 *
 *   bash sed -i ... <big-file>  → suggest sd or ast-grep for >100KB files
 *   bash find <huge-tree>       → suggest rg --files for speed
 *
 * To disable a specific guard: edit DISABLED below.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Set to e.g. ["docs_path", "find_name"] to suppress specific rules without
// removing the extension. See rule IDs below.
const DISABLED: Set<string> = new Set();

// ---- Reformulation-loop guard ----
//
// Audit of past sessions showed 5-19 search calls on the same topic before any
// drill-in (docs_read / webfetch / hover). Rewording the query is the failure
// mode — the right move is to open the most likely hit and read it.
//
// We track recent search-family calls per-session. If the SAME search tool is
// called 3+ times in a window with no drill-in tool used between them, the
// 4th call is blocked with a redirect.
//
// Search tools (call counts toward the loop):
const SEARCH_TOOLS = new Set([
  "websearch",
  "codesearch",
  "docs_search",
  "docs_grep",
  "docs_find",
  "session_search",
  "context7_resolve_library_id",
]);
// Drill-in tools (call resets the loop counter for that family):
const DRILL_IN_TOOLS = new Set([
  "webfetch",
  "web_research",
  "docs_read",
  "docs_summary",
  "context7_query_docs",
  "read",
  "lsp",
]);
const LOOP_THRESHOLD = 3;

type LoopState = {
  recentSearches: Array<{ tool: string; ts: number }>;
  lastDrillInTs: number;
};
const loopState: LoopState = { recentSearches: [], lastDrillInTs: 0 };

// Hard-block rules: regex on bash command, plus a redirect message.
type BlockRule = {
  id: string;
  pattern: RegExp;
  reason: string;
  segment?: boolean; // if true, test against each `&&|;|||` segment, not the whole command
};

const BASH_RULES: BlockRule[] = [
  {
    id: "ls_docs",
    pattern: /^\s*ls\s+(\S*\s+)*\/docs\b/,
    reason:
      "`/docs/` is not local filesystem — it lives on docs.erfi.io and is only reachable via the `docs_*` tools. Use `docs_sources <filter>` to verify a source exists, or `docs_find pattern=<glob>` to list files by name.",
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
      "Prefer the `grep` tool (regex content search, mtime-sorted output, capped at 100 hits) over `grep -r`. Or use `bash rg <pattern>` directly if you need a specific rg flag the tool doesn't expose.",
    segment: true,
  },
  {
    id: "find_name",
    pattern: /^\s*find\b[^&;|]*\s-name\b/,
    reason:
      "Prefer the `glob` tool for filename matching (e.g. `glob pattern='**/*.ts'`). `find -name` is slower (no gitignore awareness) and harder to read.",
    segment: true,
  },
  {
    id: "find_path",
    pattern: /^\s*find\b[^&;|]*\s-path\b/,
    reason: "Prefer the `glob` tool for path-pattern matching. `find -path` is slower and harder to read.",
    segment: true,
  },
  {
    id: "rg_files",
    pattern: /^\s*rg\s+(-\S*\s+)*--files\b/,
    reason:
      "Prefer the `glob` tool (wraps `rg --files -g`). It returns mtime-sorted results capped at 100 with a structured truncation footer.",
    segment: true,
  },
  {
    id: "curl_search",
    pattern: /^\s*curl\s+[^|&;]*\b(google\.com|bing\.com|duckduckgo\.com|searxng|search\.brave|kagi)\b/i,
    reason:
      "Never `bash curl` a search engine. Use `websearch` (Exa) for discovery, `web_research` when making a claim (auto-fetches top results), or the `research` skill's SearXNG fallback at :8888.",
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
    // sed -i with a substitution on a path that LOOKS large (any .ts/.tsx/.js/.go/.py file — quick heuristic).
    // The actual size check happens at runtime; this just nudges toward sd/ast-grep for known-painful targets.
    pattern: /^\s*sed\s+-i\b[^|&;]*\.(ts|tsx|js|jsx|mjs|cjs|go|py|rs|java|kt|swift|cpp|c|h|hpp)['\"\s]/,
    reason:
      "For source-file rewrites, prefer `sd 'pattern' 'replacement' file` (literal, no regex foot-guns) or `ast-grep --rewrite` (AST-precise, won't match strings/comments). `sed -i` regex on source files routinely captures unintended matches.",
    segment: true,
  },
  {
    id: "docker_logs_servarr",
    // The user has composer (gitops manager) that exposes logs via API. Direct docker logs on Unraid is fine,
    // but on the dev machine the canonical lookup is composer.erfi.io API.
    pattern: /^\s*docker\s+logs\s+\S/,
    reason:
      "For services managed by composer.erfi.io, prefer the composer API for logs (gives you tail + filter + structured response). `docker logs` direct is fine if SSH'd into the host running the container.",
    segment: true,
  },
  {
    id: "docker_compose_no_file",
    // Running docker compose subcmds from a non-compose dir without -f is a common mistake when working across stacks.
    pattern: /^\s*docker\s+compose\s+(up|down|restart|pull|logs|exec)\b/,
    reason:
      "You're running a docker compose subcommand. If you're in the stack's directory, this works — otherwise add `-f /path/to/docker-compose.yml`. Common mistake when working across multiple stacks (~/servarr-compose, ~/keycloak-compose, etc.).",
    segment: true,
  },
  {
    id: "cat_pipe_tool",
    // 'cat file | tool' is a useless use of cat in 99% of cases.
    pattern: /^\s*cat\s+[^|&;]*\|/,
    reason:
      "Useless use of cat. Either `tool < file` (most tools accept stdin) or `tool file` (most tools accept a path arg). `cat file | tool` adds a process for no reason.",
    segment: true,
  },
  {
    id: "head_full_file",
    // 'head -<huge_number> file' or 'head -n 99999 file' is just cat with extra steps.
    pattern: /^\s*head\s+(-n\s*)?-?\d{4,}\s+\S/,
    reason:
      "For reading whole files, use the `read` tool (gives line numbers + length header). `head -n 99999` is just a slower `cat` and dumps unstructured.",
    segment: true,
  },
  {
    id: "unsigned_git_commit",
    // User requires -S signing (memory id 0100MPG0R6JTB7DCA24A30E45767). Default commit.gpgsign=true should handle it,
    // but explicit '-c commit.gpgsign=false' or '--no-gpg-sign' is a hard error.
    pattern: /^\s*git\s+(-c\s+commit\.gpg[sS]ign=false\b|.*--no-gpg-sign\b)/,
    reason:
      "This user REQUIRES GPG-signed commits (commit.gpgsign=true is set globally, key B9D283E8AE4E56B4). NEVER bypass signing. If gpg-agent times out, retry with `timeout 15 git commit -S` — the agent state usually recovers.",
    segment: true,
  },
  {
    id: "create_tanstack_router_hallucinated",
    // Specific hallucination from this session — the wrong scaffolder name.
    pattern: /^\s*(bun|npx|pnpm)\s+(create|dlx)\s+@tanstack\/(router|create-router)\b/,
    reason:
      "`@tanstack/router` is not the scaffolder. Use `bun create tsrouter-app@latest <name>` (or `npx create-tsrouter-app@latest <name>`). Supports `--template file-router`, `--framework solid`, `--add-ons shadcn,tanstack-query`, `--toolchain biome`. See the `frontend-stack` skill.",
    segment: true,
  },
  {
    id: "docker_image_latest",
    // Pulling :latest in a compose context (where pinning is mandatory per infra-stack skill).
    pattern: /image:\s*\S+:latest\b/,
    reason:
      "Don't pin to `:latest` in compose YAML (per infra-stack skill). Latest upgrades silently and breaks things. Use `oci_tags image=<image> semver:true` to find the current stable tag, then pin explicitly (e.g. `postgres:18.1-alpine`).",
    segment: false,
  },
];

// Detect when webfetch is called with a docs.erfi.io URL — block and
// suggest docs_read / docs_grep on the equivalent /docs/ path.
function checkWebfetchDocs(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "docs.erfi.io") {
      // Try to map docs.erfi.io/postgres/foo → /docs/postgres/foo
      const docsPath = `/docs${u.pathname}`.replace(/\/$/, "");
      return `webfetch on docs.erfi.io is wasteful — the content is on the docs SSH server and reachable via the docs_* tools. Use \`docs_read path=${docsPath}\` (full file) or \`docs_grep query=<pattern> path=${docsPath}\` (within file/dir). If you don't know the exact path yet, start with \`docs_sources <filter>\` or \`docs_search query=<keyword> source=<source>\`.`;
    }
  } catch {
    /* malformed URL — let webfetch handle it */
  }
  return null;
}

function splitSegments(command: string): string[] {
  return command.split(/&&|\|\||;|\|/);
}

function checkReformulationLoop(toolName: string): string | null {
  const now = Date.now();

  if (DRILL_IN_TOOLS.has(toolName)) {
    loopState.lastDrillInTs = now;
    return null;
  }

  if (!SEARCH_TOOLS.has(toolName)) return null;

  // Filter to recent searches AFTER the last drill-in
  loopState.recentSearches = loopState.recentSearches.filter(
    (s) => s.ts > loopState.lastDrillInTs,
  );
  loopState.recentSearches.push({ tool: toolName, ts: now });

  if (loopState.recentSearches.length >= LOOP_THRESHOLD + 1) {
    const counts = new Map<string, number>();
    for (const s of loopState.recentSearches) {
      counts.set(s.tool, (counts.get(s.tool) ?? 0) + 1);
    }
    const total = loopState.recentSearches.length;
    const breakdown = [...counts.entries()].map(([t, n]) => `${t}×${n}`).join(", ");
    return `Reformulation loop detected: ${total} search calls (${breakdown}) since the last drill-in. STOP rewording. Open the most likely result with the appropriate drill-in tool: docs_search → docs_read, websearch → webfetch or web_research, codesearch → read on the linked file, context7_resolve → context7_query_docs. If results genuinely don't fit your need, ask the user to clarify rather than searching again.`;
  }

  return null;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, _ctx) => {
    // Reformulation-loop guard runs on every tool call (search families only)
    if (!DISABLED.has("reformulation_loop")) {
      const loopMsg = checkReformulationLoop(event.toolName);
      if (loopMsg) return { block: true, reason: `tool-guard[reformulation_loop]: ${loopMsg}` };
    }

    // bash anti-patterns
    if (event.toolName === "bash") {
      const command = (event.input as { command?: string }).command;
      if (typeof command !== "string") return undefined;

      for (const rule of BASH_RULES) {
        if (DISABLED.has(rule.id)) continue;
        const probe = rule.segment ? splitSegments(command) : [command];
        for (const seg of probe) {
          if (rule.pattern.test(seg)) {
            return {
              block: true,
              reason: `tool-guard[${rule.id}]: ${rule.reason}`,
            };
          }
        }
      }
      return undefined;
    }

    // webfetch on docs.erfi.io
    if (event.toolName === "webfetch") {
      if (DISABLED.has("webfetch_docs")) return undefined;
      const url = (event.input as { url?: string }).url;
      if (typeof url !== "string") return undefined;
      const msg = checkWebfetchDocs(url);
      if (msg) return { block: true, reason: `tool-guard[webfetch_docs]: ${msg}` };
    }

    return undefined;
  });
}
