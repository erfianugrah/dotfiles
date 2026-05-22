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

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, _ctx) => {
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
