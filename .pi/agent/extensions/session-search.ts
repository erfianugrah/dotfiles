/**
 * session-search — full-text search across past Pi sessions.
 *
 * Ports the opencode fork's session_search tool (commit f9f58da11) to Pi.
 * opencode used SQLite FTS5; here we use plain JSONL scan because Pi sessions
 * are line-delimited JSON files. For personal-scale session volumes (low
 * thousands of sessions) the scan is fast enough; if it ever becomes a
 * bottleneck we can graduate to a sidecar FTS5 index.
 *
 * Pi session layout: ~/.pi/agent/sessions/<cwd-encoded>/<timestamp>_<uuid>.jsonl
 * Each entry is a JSON object; entries with type="message" have
 * { role: "user"|"assistant", content: [{type, text}, ...] }.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, basename } from "path";

type Hit = {
  sessionPath: string;
  date: string;
  role: string;
  snippet: string;
};

// Walk one level: ~/.pi/agent/sessions/<dir>/*.jsonl
function listSessions(): string[] {
  const root = join(getAgentDir(), "sessions");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const sub of readdirSync(root)) {
    const subPath = join(root, sub);
    let s;
    try {
      s = statSync(subPath);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    for (const f of readdirSync(subPath)) {
      if (f.endsWith(".jsonl")) out.push(join(subPath, f));
    }
  }
  return out;
}

// Filename pattern: 2026-05-20T22-19-40-639Z_<uuid>.jsonl
function dateFromName(filename: string): string {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "?";
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object" && "text" in c && typeof (c as { text: unknown }).text === "string") {
        return (c as { text: string }).text;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function snippet(text: string, query: string, before: number = 40, after: number = 120): string {
  const lc = text.toLowerCase();
  const lq = query.toLowerCase();
  const idx = lc.indexOf(lq);
  if (idx === -1) return text.slice(0, before + after);
  const start = Math.max(0, idx - before);
  const end = Math.min(text.length, idx + lq.length + after);
  let s = text.slice(start, end);
  if (start > 0) s = "…" + s;
  if (end < text.length) s = s + "…";
  return s;
}

const sessionSearchTool = defineTool({
  name: "session_search",
  label: "Session Search",
  description: [
    "Search past session content using simple substring match.",
    "",
    "Use this tool to find relevant context from previous sessions — past decisions, implementations, user preferences, and recurring patterns.",
    "",
    "Parameters:",
    '- "query": Search terms (case-insensitive substring match)',
    '- "role": Filter by message role: "user", "assistant", or omit for both',
    '- "limit": Max results to return (default: 10, max: 50)',
    "",
    "Returns matching snippets with session path, role, and date.",
    "",
    "When to use:",
    '- User references past work ("how did we do X last time?")',
    "- Need to understand prior decisions or context",
    "- Looking for patterns across sessions",
  ].join("\n"),
  parameters: Type.Object({
    query: Type.String({ description: "Search terms (case-insensitive substring)" }),
    role: Type.Optional(
      Type.Union([Type.Literal("user"), Type.Literal("assistant")], { description: "Filter by message role" }),
    ),
    limit: Type.Optional(Type.Number({ description: "Max results (default: 10, max: 50)" })),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const limit = Math.min(params.limit ?? 10, 50);
    const sessions = listSessions();
    const hits: Hit[] = [];
    const q = params.query.toLowerCase();

    outer: for (const sessionPath of sessions) {
      const date = dateFromName(basename(sessionPath));
      let raw: string;
      try {
        raw = readFileSync(sessionPath, "utf-8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (!line) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry?.type !== "message") continue;
        const role = entry.message?.role;
        if (params.role && role !== params.role) continue;
        const text = extractText(entry.message?.content);
        if (!text.toLowerCase().includes(q)) continue;
        hits.push({ sessionPath, date, role: role ?? "?", snippet: snippet(text, q) });
        if (hits.length >= limit) break outer;
      }
    }

    if (hits.length === 0) {
      return {
        content: [{ type: "text", text: `No matches for "${params.query}"` }],
        details: { count: 0, query: params.query, sessions_scanned: sessions.length },
      };
    }

    const out = hits
      .map(
        (h, i) =>
          `${i + 1}. [${h.date}] ${h.role}\n   ${h.sessionPath}\n   ${h.snippet}`,
      )
      .join("\n\n");

    return {
      content: [{ type: "text", text: out }],
      details: { count: hits.length, query: params.query, sessions_scanned: sessions.length },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(sessionSearchTool);
}
