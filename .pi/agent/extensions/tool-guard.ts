/**
 * tool-guard - intercept common anti-patterns BEFORE they fire and nudge
 * the LLM toward the right tool.
 *
 * This is the pi adapter: it owns the pi.on() wiring and the per-session
 * state maps. The pure detection logic (rule tables, decision functions,
 * bash tokenisation) lives in ./lib/tool-guard-core.ts and is shared with
 * the Claude Code PreToolUse hook (../../../.claude/hooks/tool-guard.ts).
 *
 * Why a runtime guard instead of just system-prompt rules:
 *   - The LLM ignores prompt rules occasionally (audited: dozens of cases
 *     of `bash find` / `bash ls /docs/` / `webfetch <docs.erfi.io URL>` per
 *     session, even with explicit rules in APPEND_SYSTEM.md).
 *   - A block-with-reason is a hard signal - the model can't pretend it
 *     didn't see the rule.
 *
 * Guarded patterns and full design notes: see ./lib/tool-guard-core.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BASH_RULES,
  WRITE_RULES,
  checkReformulationLoop as checkReformulationLoopCore,
  checkWebfetchDocs,
  decideDocsFirst,
  decideResearchRoute,
  decideResearchRouteSoft,
  detectResearchIntent,
  docsSourcesMisuse,
  docsSourcesNote,
  extractPatchPaths,
  extractTopics,
  looksLikeSymbolSearch,
  lspRouteNote,
  matchDocsTopic,
  splitSegments,
  stripAnsiCSpans,
  queryTokens,
  tokenContainment,
  WEB_SEARCH_TOOLS,
  type DocsFirstInput,
  type LoopState,
  type ResearchRouteInput,
} from "./lib/tool-guard-core.ts";

// Re-export the pure helpers the pi test suite imports from this module so
// ../tests/extensions.test.ts keeps resolving them here.
export {
  splitSegments,
  extractPatchPaths,
  stripAnsiCSpans,
  extractTopics,
  matchDocsTopic,
  decideDocsFirst,
  detectResearchIntent,
  decideResearchRoute,
  decideResearchRouteSoft,
  queryTokens,
  tokenContainment,
  looksLikeSymbolSearch,
  lspRouteNote,
  docsSourcesMisuse,
  docsSourcesNote,
} from "./lib/tool-guard-core.ts";

// Set to e.g. ["docs_path", "find_name"] to suppress specific rules.
const DISABLED: Set<string> = new Set();

// Bedrock / certain Claude proxies return generic 500s once the tool-use
// input crosses ~80-100 KB. Guard 5 KB below the conservative floor.
const WRITE_TOO_LARGE_BYTES = 75_000;

// ---- reformulation-loop per-session state (owned by this adapter) ----
const loopStates = new Map<string, LoopState>();
function loopStateFor(sessionKey: string): LoopState {
  let s = loopStates.get(sessionKey);
  if (!s) {
    s = { recentSearches: [], lastDrillInTs: 0 };
    loopStates.set(sessionKey, s);
  }
  return s;
}

// Test-facing signature: (toolName, sessionKey, query?). Manages the module
// state map and delegates the pure decision to the core.
export function checkReformulationLoop(
  toolName: string,
  sessionKey: string,
  query?: string,
): string | null {
  return checkReformulationLoopCore(toolName, loopStateFor(sessionKey), query);
}

// ---- Docs-first chain guard (topic cache; pi-only side effects) ----
const DOCS_FIRST_TOOLS = new Set([
  "docs_sources", "docs_search", "docs_grep", "docs_find", "docs_read", "docs_summary",
]);
const docsFirstSessions = new Set<string>();

// lsp_route: advisory fire counter per session (capped so it never nags).
const LSP_ROUTE_MAX = Number(process.env.PI_LSP_ROUTE_MAX) || 3;
const lspRouteFired = new Map<string, number>();
const lspRouteCount = (k: string): number => lspRouteFired.get(k) ?? 0;
const bumpLspRoute = (k: string): void => {
  lspRouteFired.set(k, lspRouteCount(k) + 1);
};

// docs_inversion: one advisory per session.
const docsInversionFired = new Set<string>();

const DOCS_SSH_HOST = "docs@docs.erfi.io";
const DOCS_SSH_PORT = "2222";
const TOPIC_CACHE_PATH = join(homedir(), ".pi", "agent", ".docs-topics.json");
const TOPIC_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type TopicCache = { fetchedAt: number; topics: string[] };
let topicCache: TopicCache | null | undefined;
let topicRefreshInFlight = false;

function loadTopics(): string[] | null {
  if (topicCache === undefined) {
    topicCache = null;
    try {
      const raw = JSON.parse(readFileSync(TOPIC_CACHE_PATH, "utf-8")) as {
        fetchedAt?: unknown;
        topics?: unknown;
      };
      if (
        Array.isArray(raw.topics) &&
        raw.topics.every((t) => typeof t === "string")
      ) {
        topicCache = {
          fetchedAt: typeof raw.fetchedAt === "number" ? raw.fetchedAt : 0,
          topics: raw.topics as string[],
        };
      }
    } catch { /* missing/corrupt cache -> null */ }
  }
  if (!topicCache || Date.now() - topicCache.fetchedAt > TOPIC_CACHE_TTL_MS) {
    refreshTopicsInBackground();
  }
  return topicCache ? topicCache.topics : null;
}

function refreshTopicsInBackground(): void {
  if (topicRefreshInFlight) return;
  topicRefreshInFlight = true;
  const remote =
    "if [ -s /docs/_index.tsv ]; then awk -F'\\t' '{n=split($1,a,\"/\"); if (n>1 && a[1] ~ /^[a-z0-9][a-z0-9._-]*$/) print a[1]}' /docs/_index.tsv | sort -u; " +
    "else ls -1 /docs; fi";
  const proc = spawn(
    "ssh",
    [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-o", "ConnectTimeout=5",
      "-p", DOCS_SSH_PORT,
      DOCS_SSH_HOST,
      remote,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const out: Buffer[] = [];
  proc.stdout.on("data", (b) => out.push(b));
  proc.on("error", () => { topicRefreshInFlight = false; });
  proc.on("close", (code) => {
    topicRefreshInFlight = false;
    if (code !== 0) return;
    const sources = Buffer.concat(out).toString("utf-8")
      .split("\n").map((s) => s.trim()).filter(Boolean);
    const topics = extractTopics(sources);
    if (topics.length === 0) return;
    topicCache = { fetchedAt: Date.now(), topics };
    try {
      writeFileSync(TOPIC_CACHE_PATH, JSON.stringify(topicCache));
    } catch { /* cache write is best-effort */ }
  });
}

function docsFirstAdvisoryNote(matchedTopic: string | null): string {
  const nonTechNote =
    `If the query is non-technical (shopping, local business, news, weather), ignore this - ` +
    `prefer \`web_research\` with mode:"local"/"fresh" or the research stack's SearXNG (:8888) for those; ` +
    `docs.erfi.io only holds technical documentation.`;
  if (matchedTopic) {
    return (
      `tool-guard[docs_first]: this looks technical and docs.erfi.io has a "${matchedTopic}" source that may cover it. ` +
      `Consider \`docs_search query=\"<keywords>\" source=\"${matchedTopic}\"\`, then docs_read / docs_grep the hits. ${nonTechNote}`
    );
  }
  return (
    `tool-guard[docs_first]: docs.erfi.io has ~158 indexed technical sources; coverage for this query is unknown ` +
    `(topic cache not warmed yet). Consider \`docs_sources <filter>\` to check coverage. ${nonTechNote}`
  );
}

// ---- Research-stack routing state ----
type ResearchRouteState = { armed: boolean; blocks: number };
const researchRouteStates = new Map<string, ResearchRouteState>();
const researchSoftFired = new Set<string>();

const RESEARCH_ROUTE_NOTE =
  "\n\n[tool-guard routing: \"research tools\" = the self-hosted research stack, NOT Exa. " +
  "Search: bash curl -s 'https://searxng.erfi.io/search?q=<urlencoded>&format=json'. " +
  "Fetch a page: bash curl -s -X POST 'https://crawler.erfi.io/extract' -H 'Content-Type: application/json' " +
  '-d \'{"url":"<url>"}\' (response field: markdown; add "force_js":true for SPAs). ' +
  'Add -H "Authorization: Bearer $RESEARCH_TOKEN" when off-LAN. ' +
  "Full API: read ~/.pi/agent/skills/research/SKILL.md. " +
  "websearch / webfetch / web_research-default are BLOCKED by tool-guard for this request; " +
  "web_research mode local/fresh/crosscheck counts as the stack.]";

const RESEARCH_ROUTE_SOFT_NOTE =
  "tool-guard[research_route_soft]: non-technical/local research query - bare Exa websearch is the weakest path here (SG-local, shopping, long-tail). " +
  "Consider the research stack for follow-ups: web_research with mode:\"local\" (crawler-backed fetches) or mode:\"fresh\" (SearXNG cross-check), " +
  "or SearXNG directly: bash curl -s 'https://searxng.erfi.io/search?q=<urlencoded>&format=json'.";

// Advisory notes attached to a triggering call's result:
// sessionKey -> toolCallId -> note.
const pendingAdvisories = new Map<string, Map<string, string>>();

function addAdvisory(sessionKey: string, toolCallId: string | undefined, note: string): void {
  if (!toolCallId) return;
  let byCall = pendingAdvisories.get(sessionKey);
  if (!byCall) {
    byCall = new Map();
    pendingAdvisories.set(sessionKey, byCall);
  }
  byCall.set(toolCallId, note);
}

interface ToolResultContent {
  type: string;
  text?: string;
}

function sessionKeyOf(ctx: {
  sessionManager?: { getSessionFile?: () => string };
}): string {
  try {
    return ctx.sessionManager?.getSessionFile?.() ?? "default";
  } catch {
    return "default";
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    try { loadTopics(); } catch { /* best-effort */ }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      const key = ctx.sessionManager.getSessionFile?.() ?? "default";
      loopStates.delete(key);
      docsFirstSessions.delete(key);
      lspRouteFired.delete(key);
      docsInversionFired.delete(key);
      researchRouteStates.delete(key);
      researchSoftFired.delete(key);
      pendingAdvisories.delete(key);
    } catch { /* ignore */ }
  });

  pi.on("agent_end", async (_event, ctx) => {
    try {
      researchRouteStates.delete(sessionKeyOf(ctx));
    } catch { /* ignore */ }
  });

  pi.on("input", async (event, ctx) => {
    if (DISABLED.has("research_route")) return undefined;
    if (event.source === "extension") return undefined;
    if (!detectResearchIntent(event.text)) return undefined;
    researchRouteStates.set(sessionKeyOf(ctx), { armed: true, blocks: 0 });
    return { action: "transform", text: event.text + RESEARCH_ROUTE_NOTE };
  });

  pi.on("tool_call", async (event, ctx) => {
    const sessionKey = (() => {
      try { return ctx.sessionManager.getSessionFile?.() ?? "default"; } catch { return "default"; }
    })();

    // Research-stack routing (explicit ask).
    if (!DISABLED.has("research_route")) {
      const st = researchRouteStates.get(sessionKey);
      if (st?.armed) {
        const d = decideResearchRoute(
          event.toolName,
          event.input as ResearchRouteInput,
          st.blocks,
        );
        if (d.action === "comply") {
          researchRouteStates.delete(sessionKey);
        } else if (d.action === "block") {
          st.blocks += 1;
          return { block: true, reason: d.reason };
        }
      }
    }

    // Reformulation-loop guard: advisory.
    if (!DISABLED.has("reformulation_loop")) {
      const loopInput = event.input as { query?: string; libraryName?: string };
      const loopMsg = checkReformulationLoop(
        event.toolName,
        sessionKey,
        loopInput.query ?? loopInput.libraryName,
      );
      if (loopMsg) {
        addAdvisory(sessionKey, event.toolCallId, `tool-guard[reformulation_loop]: ${loopMsg}`);
      }
    }

    // Docs-first chain: mark docs check - any docs_* call opens the gate.
    if (DOCS_FIRST_TOOLS.has(event.toolName)) {
      docsFirstSessions.add(sessionKey);
    }

    // Docs-first chain: advise on websearch / web_research.
    if (!DISABLED.has("docs_first") && WEB_SEARCH_TOOLS.has(event.toolName)) {
      if (!docsFirstSessions.has(sessionKey)) {
        const decision = decideDocsFirst(
          event.toolName,
          event.input as DocsFirstInput,
          loadTopics(),
        );
        if (decision.block) {
          docsFirstSessions.add(sessionKey);
          addAdvisory(sessionKey, event.toolCallId, docsFirstAdvisoryNote(decision.matchedTopic));
        }
      }
    }

    // Research-stack routing (heuristic soft tier).
    if (
      !DISABLED.has("research_route_soft") &&
      !researchSoftFired.has(sessionKey) &&
      decideResearchRouteSoft(event.toolName, event.input as { query?: string })
    ) {
      researchSoftFired.add(sessionKey);
      addAdvisory(sessionKey, event.toolCallId, RESEARCH_ROUTE_SOFT_NOTE);
    }

    // lsp routing: symbol-declaration lookups sent through text search.
    // Advisory, capped per session - the correct choice depends on intent the
    // guard cannot see ("every textual occurrence" is a legitimate goal).
    if (!DISABLED.has("lsp_route") && lspRouteCount(sessionKey) < LSP_ROUTE_MAX) {
      const pat = (event.input as { pattern?: string }).pattern;
      const isSearchTool = event.toolName === "grep";
      const bashCmd =
        event.toolName === "bash" ? (event.input as { command?: string }).command : undefined;
      // For bash, only consider the quoted pattern of an rg/grep invocation.
      const bashPat =
        bashCmd && /^\s*(rg|grep)\b/.test(bashCmd)
          ? (bashCmd.match(/['"]([^'"]{3,80})['"]/)?.[1] ?? undefined)
          : undefined;
      const candidate = isSearchTool ? pat : bashPat;
      if (candidate && looksLikeSymbolSearch(candidate)) {
        bumpLspRoute(sessionKey);
        addAdvisory(sessionKey, event.toolCallId, lspRouteNote(candidate));
      }
    }

    // docs pipeline inversion: docs_sources used as a content search.
    if (!DISABLED.has("docs_inversion") && event.toolName === "docs_sources") {
      const filter = (event.input as { filter?: string }).filter;
      if (docsSourcesMisuse(filter) && !docsInversionFired.has(sessionKey)) {
        docsInversionFired.add(sessionKey);
        addAdvisory(sessionKey, event.toolCallId, docsSourcesNote(filter as string));
      }
    }

    // bash anti-patterns
    if (event.toolName === "bash") {
      const command = (event.input as { command?: string }).command;
      if (typeof command !== "string") return undefined;
      for (const rule of BASH_RULES) {
        if (DISABLED.has(rule.id)) continue;
        const probe = rule.segment ? splitSegments(command) : [command];
        for (const seg of probe) {
          const matched = rule.test ? rule.test(seg) : rule.pattern.test(seg);
          if (matched) {
            return { block: true, reason: `tool-guard[${rule.id}]: ${rule.reason}` };
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
              `tool-guard[write_too_large]: write content is ${kb} KB - above the ${WRITE_TOO_LARGE_BYTES / 1024} KB ceiling where ` +
              `the upstream tool-call-input path 500s (silently, in pi's relay). ` +
              `Use the \`write_stream\` tool instead: send the content in chunks of <=60 KB with ` +
              `chunk='first' -> 'middle' (repeat) -> 'last'. Same atomicity as write, no upstream 500.`,
          };
        }
      }
      return undefined;
    }

    // apply_patch - writes via fs.writeFile, bypasses the write/edit guard.
    if (event.toolName === "apply_patch") {
      const patchText = (event.input as { patchText?: string }).patchText;
      const paths = extractPatchPaths(patchText ?? "");
      for (const p of paths) {
        for (const rule of WRITE_RULES) {
          if (DISABLED.has(rule.id)) continue;
          if (rule.pattern.test(p)) {
            return {
              block: true,
              reason: `tool-guard[${rule.id}]: apply_patch target "${p}" - ${rule.reason}`,
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

  pi.on("tool_result", async (event, ctx) => {
    let sessionKey = "default";
    try { sessionKey = ctx.sessionManager.getSessionFile?.() ?? "default"; } catch { /* ignore */ }
    const byCall = pendingAdvisories.get(sessionKey);
    const note = byCall?.get(event.toolCallId);
    if (!byCall || !note) return undefined;
    byCall.delete(event.toolCallId);
    if (byCall.size === 0) pendingAdvisories.delete(sessionKey);
    const content: ToolResultContent[] = Array.isArray(event.content)
      ? (event.content as ToolResultContent[])
      : [{ type: "text", text: String(event.content ?? "") }];
    return { content: [...content, { type: "text", text: `\n\n${note}` }] };
  });
}
