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
 * apply_patch envelopes:
 *   Each Add/Update/Delete/Move File: line is extracted and every target
 *   path is checked against WRITE_RULES (so .env / .git / lockfiles /
 *   node_modules can't be bypassed via apply_patch).
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
// State is keyed by session file path so different pi sessions on the same
// process don't share counters (verified bug — pi /new keeps the extension
// module loaded, so module-scope state survived across sessions).
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

// Bedrock / certain Claude proxies return generic 500s once the tool-use
// input crosses ~80-100 KB. Set the guard 5 KB below the conservative
// floor so even a chatty surrounding turn stays under. Calibrated to the
// same numbers used inside write-stream.ts.
const WRITE_TOO_LARGE_BYTES = 75_000;

type LoopState = {
  recentSearches: Array<{ tool: string; ts: number }>;
  lastDrillInTs: number;
};
const loopStates = new Map<string, LoopState>();
function stateFor(sessionKey: string): LoopState {
  let s = loopStates.get(sessionKey);
  if (!s) {
    s = { recentSearches: [], lastDrillInTs: 0 };
    loopStates.set(sessionKey, s);
  }
  return s;
}

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
    // but on the dev machine the canonical lookup is the user's composer API.
    pattern: /^\s*docker\s+logs\s+\S/,
    reason:
      "For services managed by the user's composer instance, prefer the composer API for logs (gives you tail + filter + structured response). `docker logs` direct is fine if SSH'd into the host running the container.",
    segment: true,
  },
  // dropped (2026-05-23, audit):
  //   - docker_compose_no_file: fired on canonical `cd ~/stack-dir && docker compose up`,
  //     which IS the correct invocation. Block message admitted the false-positive.
  //   - cat_pipe_tool: fired on legitimate `cat file | head/jq/...` quick-look idioms.
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
  // dropped (2026-05-23, audit): docker_image_latest fired on any bash command
  // mentioning `image: foo:latest` substring including `echo`, `grep`, and the
  // agent's own reasoning about a fix. Catches the wrong cases. The pin-rule
  // lives in the infra-stack skill prose instead.
  {
    id: "sudo_systemctl_restart",
    // The user runs services via docker compose (and composer/k3s/Proxmox). Direct systemctl restart
    // is rarely the right move on this user's boxes; it's usually a service managed elsewhere.
    pattern: /^\s*sudo\s+systemctl\s+(restart|stop|start|enable|disable)\s+/,
    reason:
      "Direct `systemctl restart` is rarely correct on this user's hosts — services are usually managed by docker compose, composer (gitops), or k3s. Check first: is it a compose stack? (`docker compose -f ~/<svc>-compose/docker-compose.yml restart <svc>`). A k3s deployment? (`kubectl rollout restart deploy/<svc>`). Only fall back to systemctl if it's truly a host-level systemd unit (sshd, networking, etc.).",
    segment: true,
  },
  {
    id: "kubectl_without_context",
    // Soft-warn for kubectl since we can't async-check current-context from a tool_call hook.
    // The block message reminds the agent to verify before issuing destructive ops.
    pattern: /^\s*kubectl\s+(delete|drain|cordon|uncordon|edit|patch|apply\s+--dry-run=false|rollout\s+(restart|undo))/,
    reason:
      "You're about to run a mutating kubectl command. First verify the context: `kubectl config current-context` — confirm it's the cluster you intend (k3s? remote? minikube?). The user has multiple kube-clusters on different hosts. A kubectl delete in the wrong context is one of the worst foot-guns.",
    segment: true,
  },
  {
    id: "psql_direct_connect",
    // psql -h host -U user — direct PG connection. When the project has sqlc, prefer that. When it's Supabase,
    // use the supabase CLI. Direct psql is fine for ad-hoc inspection but the LLM tends to reach for it
    // when a structured query through the project's data layer is better.
    pattern: /^\s*psql\s+(-h\s+\S+|--host=\S+|postgres(ql)?:\/\/)/,
    reason:
      "Direct `psql` connections are for ad-hoc inspection only. If the project has sqlc / drizzle / supabase CLI, use those for actual queries (they're type-safe and respect schema). If you genuinely need psql for inspection, this command is fine — just confirm you're not bypassing migrations or schema discipline.",
    segment: true,
  },
  {
    id: "bash_eval_curl",
    // The classic 'curl | sh' pattern — user might do this manually but the LLM shouldn't suggest it without consent.
    pattern: /^\s*(curl|wget)\s+[^|&;]*\|\s*(sudo\s+)?(bash|sh|zsh)\b/,
    reason:
      "`curl | sh` blindly executes whatever the remote serves. Download first to a file, inspect, then run — OR install via the platform's package manager. Even for trusted installs (nvm, rustup), prefer the manual two-step.",
    segment: true,
  },
  {
    id: "chmod_777",
    // chmod 777 is almost always wrong (use 755 / 644 / 600 depending on file type).
    pattern: /^\s*chmod\s+(-R\s+)?(0?777|a\+rwx)\b/,
    reason:
      "`chmod 777` is almost never the right answer — it grants write to everyone. Use 755 (dirs / executables), 644 (regular files), 600 (secrets), 700 (private dirs). If you're hitting a permission error in a container, the fix is usually PUID/PGID env vars (1000/100 on this user's boxes), not 777.",
    segment: true,
  },
  {
    id: "unicode_escape_in_bash",
    // Recurring foot-gun: agents write `\u2014` in bash strings expecting JS-style
    // unicode escape. Bash leaves it as the literal 6 chars unless wrapped in $'...'
    // (ANSI-C quoting). Most often appears in `git commit -m "... \u2014 ..."` and
    // ends up in the actual commit message verbatim. We guard the COMMON case
    // (\uXXXX not preceded by $') and let the rare correct usage through.
    pattern: /(?<!\$')\\u[0-9a-fA-F]{4}/,
    reason:
      "Bash doesn't interpret `\\uXXXX` JS-style unicode escapes inside regular quotes — they end up as literal 6-char sequences in your output (most painfully in `git commit -m`). Two correct options: (1) paste the actual character into the string (em-dash —, en-dash –, arrow →, etc.); (2) use bash ANSI-C quoting: `$'\\u2014'`. Recommended: just use the real character.",
    segment: false,
  },
  {
    id: "force_push_protected",
    // git push --force on main/master/dev is a common destructive mistake.
    pattern: /^\s*git\s+push\s+(\S+\s+)*(-f|--force)\b.*\b(main|master|dev|production|prod)\b/,
    reason:
      "Force-pushing to main/master/dev/prod can erase teammates' work. Confirm the branch is yours alone and the remote is up to date. If you really need it, use `--force-with-lease` (refuses if the remote moved). Better: open a PR with the force-pushed branch separately.",
    segment: true,
  },
];

// Write-tool guards: catch attempts to write/edit specific files that should
// go through a different mechanism.
type WriteRule = {
  id: string;
  pattern: RegExp; // matches against the filesystem path
  reason: string;
};

const WRITE_RULES: WriteRule[] = [
  {
    id: "edit_dotenv",
    // .env / .env.* files often hold secrets. User's pattern: Vaultwarden is canonical store,
    // .env is reconstructed from vault. Direct edits drift from vault.
    pattern: /(^|\/)\.env(\.|$)/,
    reason:
      "Direct `.env` edits drift from Vaultwarden (the canonical secret store for this user). Add/change the secret in vault first (`vw_save <field>` from ~/dotfiles bitwarden helpers), then run the project's env-rehydrate step. If this IS a vault-rehydration write, the warning is safe to acknowledge and proceed.",
  },
  {
    id: "edit_lockfile",
    pattern: /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|go\.sum)$/,
    reason:
      "Lockfiles are auto-generated by the package manager. Don't edit them directly — instead change `package.json` / `Cargo.toml` / `pyproject.toml` and run install (bun install / cargo update / etc.). Direct lockfile edits break reproducibility and confuse tooling.",
  },
  {
    id: "edit_git_internals",
    // Already covered by git-gh-gate.ts but add here for defence in depth
    pattern: /(^|\/)\.git\/(config|HEAD|refs\/|hooks\/|COMMIT_EDITMSG)/,
    reason:
      "`.git/` internals shouldn't be edited directly. Use the corresponding git command: `git config` (for .git/config), `git branch -m` (for HEAD/refs), `git commit --amend` (for COMMIT_EDITMSG). Direct edits can corrupt the repo.",
  },
  {
    id: "edit_node_modules",
    pattern: /(^|\/)node_modules\//,
    reason:
      "Don't edit files in `node_modules/` — changes get blown away on the next `bun install`. If you need to patch a dependency, use `patch-package` (creates a permanent diff in `patches/`).",
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

// Exported for unit tests. Splits a bash command into best-effort segments
// at shell operators — && || ; | — so per-segment rules don't miss patterns
// hidden behind chaining (e.g. `cd /repo && git commit`). Not a full shell
// parser; quoted strings containing these operators may be mis-split (false
// positive, which is acceptable for a deny-confirmation gate).
export function splitSegments(command: string): string[] {
  return command.split(/&&|\|\||;|\|/);
}

function checkReformulationLoop(toolName: string, sessionKey: string): string | null {
  const now = Date.now();
  const state = stateFor(sessionKey);

  if (DRILL_IN_TOOLS.has(toolName)) {
    state.lastDrillInTs = now;
    return null;
  }

  if (!SEARCH_TOOLS.has(toolName)) return null;

  // Filter to recent searches AFTER the last drill-in
  state.recentSearches = state.recentSearches.filter(
    (s) => s.ts > state.lastDrillInTs,
  );
  state.recentSearches.push({ tool: toolName, ts: now });

  if (state.recentSearches.length >= LOOP_THRESHOLD + 1) {
    const counts = new Map<string, number>();
    for (const s of state.recentSearches) {
      counts.set(s.tool, (counts.get(s.tool) ?? 0) + 1);
    }
    const total = state.recentSearches.length;
    const breakdown = [...counts.entries()].map(([t, n]) => `${t}×${n}`).join(", ");
    return `Reformulation loop detected: ${total} search calls (${breakdown}) since the last drill-in. STOP rewording. Open the most likely result with the appropriate drill-in tool: docs_search → docs_read, websearch → webfetch or web_research, codesearch → read on the linked file, context7_resolve → context7_query_docs. If results genuinely don't fit your need, ask the user to clarify rather than searching again.`;
  }

  return null;
}

// Extract every target path from an apply_patch envelope. Mirrors
// apply-patch.ts's parsePatch but bail-fast — we only need the file paths,
// not the hunks. Any line matching `*** (Add|Update|Delete|Move) File: <path>`
// contributes a path. (`Move to:` lines also count as a write target.)
// Exported for unit tests.
export function extractPatchPaths(patchText: string): string[] {
  if (typeof patchText !== "string") return [];
  const out: string[] = [];
  for (const line of patchText.split(/\r?\n/)) {
    const m = line.match(/^\*\*\* (?:Add|Update|Delete|Move(?: to)?) File: (.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  // Reset per-session loop state when sessions transition. Pi keeps the
  // extension module loaded across /new, /resume, /fork — module-scope
  // state survives. Without this, search counters leak across sessions.
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      const key = ctx.sessionManager.getSessionFile?.() ?? "default";
      loopStates.delete(key);
    } catch { /* ignore */ }
  });

  pi.on("tool_call", async (event, ctx) => {
    const sessionKey = (() => {
      try { return ctx.sessionManager.getSessionFile?.() ?? "default"; } catch { return "default"; }
    })();

    // Reformulation-loop guard runs on every tool call (search families only)
    if (!DISABLED.has("reformulation_loop")) {
      const loopMsg = checkReformulationLoop(event.toolName, sessionKey);
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

    // write / edit on protected paths
    if (event.toolName === "write" || event.toolName === "edit") {
      const input = event.input as {
        path?: string;
        file_path?: string;
        content?: string;
      };
      const filePath = input.path ?? input.file_path;
      if (typeof filePath !== "string") return undefined;
      for (const rule of WRITE_RULES) {
        if (DISABLED.has(rule.id)) continue;
        if (rule.pattern.test(filePath)) {
          return { block: true, reason: `tool-guard[${rule.id}]: ${rule.reason}` };
        }
      }

      // write_too_large — Bedrock and certain Claude proxies 500 on tool-use
      // inputs above ~80-100 KB. The standard `write` tool packs the entire
      // file content into a single tool-call argument, so big-file writes
      // silently fail upstream and pi's relay swallows the error. Redirect
      // to write_stream which is designed for this case.
      if (
        event.toolName === "write" &&
        !DISABLED.has("write_too_large") &&
        typeof input.content === "string"
      ) {
        const bytes = Buffer.byteLength(input.content, "utf-8");
        if (bytes > WRITE_TOO_LARGE_BYTES) {
          const kb = (bytes / 1024).toFixed(1);
          return {
            block: true,
            reason:
              `tool-guard[write_too_large]: write content is ${kb} KB — above the ${WRITE_TOO_LARGE_BYTES / 1024} KB ceiling where ` +
              `the upstream tool-call-input path 500s (silently, in pi's relay). ` +
              `Use the \`write_stream\` tool instead: send the content in chunks of ≤60 KB with ` +
              `chunk='first' → 'middle' (repeat) → 'last'. Same atomicity as write, no upstream 500.`,
          };
        }
      }
      return undefined;
    }

    // apply_patch — writes via fs.writeFile, bypasses the write/edit guard
    // surface. Parse the envelope, run WRITE_RULES on every target path.
    if (event.toolName === "apply_patch") {
      const patchText = (event.input as { patchText?: string }).patchText;
      const paths = extractPatchPaths(patchText ?? "");
      for (const p of paths) {
        for (const rule of WRITE_RULES) {
          if (DISABLED.has(rule.id)) continue;
          if (rule.pattern.test(p)) {
            return {
              block: true,
              reason: `tool-guard[${rule.id}]: apply_patch target "${p}" — ${rule.reason}`,
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
