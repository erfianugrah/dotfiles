/**
 * memory — persistent cross-session notes for the agent.
 *
 * Ports the opencode fork's memory tool (commit ffab004ea) to Pi. Two
 * surfaces:
 *
 * 1. A `memory` tool the model can call with actions:
 *      - "save"   → add a new memory (returns assigned id)
 *      - "list"   → return all memories
 *      - "update" → replace an existing memory by id
 *      - "delete" → remove a memory by id
 *
 * 2. A `context` event handler that injects all memories as a single system
 *    message at the top of each LLM call. With Anthropic prompt caching this
 *    adds zero per-turn cost after the first turn; with other providers it
 *    adds a small fixed token cost per turn.
 *
 * Storage: `~/.pi/agent/memories.json`. NOT version-controlled — memories are
 * per-machine, may contain personal context the user doesn't want synced.
 *
 * Format:
 *   { "memories": [ { "id": "01K…", "content": "…", "created_at": "…" } ] }
 *
 * The ID is a ULID-like timestamp-prefixed identifier so list order is
 * chronological without needing a separate index.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const MEMORIES_FILE = join(getAgentDir(), "memories.json");

// Cap how many bytes of memory content we'll inject per LLM call. Above
// this, oldest memories are dropped from the injected block first (the
// user still keeps them in the file; they're just not in-context this turn).
// Override with MEMORY_INJECT_MAX_BYTES env.
const INJECT_MAX_BYTES = Number(process.env.MEMORY_INJECT_MAX_BYTES ?? 8000);

type Memory = { id: string; content: string; created_at: string };

// ── storage ───────────────────────────────────────────────────────────────

// load() runs on every `context` event (once per LLM call) so a fresh disk
// read per turn is wasted I/O. Stat-based mtime cache lets us reuse the
// parsed array across consecutive turns where memories.json hasn't changed.
let cache: { mtimeMs: number; size: number; memories: Memory[] } | null = null;

function load(): Memory[] {
  if (!existsSync(MEMORIES_FILE)) {
    cache = null;
    return [];
  }
  try {
    const st = statSync(MEMORIES_FILE);
    if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
      return cache.memories;
    }
    const raw = readFileSync(MEMORIES_FILE, "utf-8");
    const parsed = JSON.parse(raw) as { memories?: Memory[] };
    const memories = parsed.memories ?? [];
    cache = { mtimeMs: st.mtimeMs, size: st.size, memories };
    return memories;
  } catch {
    return [];
  }
}

function persist(memories: Memory[]) {
  writeFileSync(MEMORIES_FILE, JSON.stringify({ memories }, null, 2) + "\n");
  // Invalidate cache so the next load() sees the new content even within
  // the same second (mtime resolution on some filesystems is 1s).
  cache = null;
}

// Crockford-style ULID-ish id: 10-char timestamp + 16 hex chars.
// Enough uniqueness for personal-scale memory; sorts chronologically.
function newId(): string {
  const ts = Date.now().toString(36).toUpperCase().padStart(10, "0");
  const rand = randomBytes(8).toString("hex").toUpperCase();
  return `01${ts}${rand}`;
}

// ── tool ──────────────────────────────────────────────────────────────────

const memoryTool = defineTool({
  name: "memory",
  label: "Memory",
  description: [
    "Manage persistent memories that survive across sessions.",
    "",
    "Use this tool to save user preferences, design principles, project conventions, and recurring patterns so they are available in future sessions.",
    "",
    "Actions:",
    '- "save": Save a new memory. Requires content.',
    '- "list": List all stored memories with their IDs.',
    '- "update": Update an existing memory. Requires id and content.',
    '- "delete": Delete an outdated memory. Requires id.',
    "",
    "Guidelines:",
    "- Before saving, list existing memories to check for duplicates",
    "- Keep each memory concise: 1-2 sentences, actionable, specific",
    "- If a memory already covers the same concept, update it instead of creating a new one",
    "- Delete memories that are outdated or superseded",
    "- Prefer 30 precise memories over 100 vague ones",
    "- Consolidate related memories when the count gets high",
  ].join("\n"),
  parameters: Type.Object({
    action: Type.Union(
      [Type.Literal("save"), Type.Literal("list"), Type.Literal("update"), Type.Literal("delete")],
      { description: "Action to perform" },
    ),
    content: Type.Optional(
      Type.String({ description: "Memory content (required for save/update)" }),
    ),
    id: Type.Optional(Type.String({ description: "Memory ID (required for delete/update)" })),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const memories = load();

    if (params.action === "list") {
      if (memories.length === 0) {
        return { content: [{ type: "text", text: "No memories stored yet." }], details: { count: 0 } };
      }
      const out = memories.map((m) => `[${m.id}] ${m.content}`).join("\n");
      return { content: [{ type: "text", text: out }], details: { count: memories.length } };
    }

    if (params.action === "save") {
      if (!params.content) {
        return {
          isError: true,
          content: [{ type: "text", text: "save requires content" }],
          details: {},
        };
      }
      const memory: Memory = { id: newId(), content: params.content, created_at: new Date().toISOString() };
      memories.push(memory);
      persist(memories);
      return {
        content: [{ type: "text", text: `Saved: ${memory.id}` }],
        details: { id: memory.id, count: memories.length },
      };
    }

    if (params.action === "update") {
      if (!params.id || !params.content) {
        return {
          isError: true,
          content: [{ type: "text", text: "update requires id and content" }],
          details: {},
        };
      }
      const idx = memories.findIndex((m) => m.id === params.id);
      if (idx === -1) {
        return {
          isError: true,
          content: [{ type: "text", text: `Memory not found: ${params.id}` }],
          details: {},
        };
      }
      memories[idx] = { ...memories[idx], content: params.content };
      persist(memories);
      return {
        content: [{ type: "text", text: `Updated: ${params.id}` }],
        details: { id: params.id },
      };
    }

    if (params.action === "delete") {
      if (!params.id) {
        return {
          isError: true,
          content: [{ type: "text", text: "delete requires id" }],
          details: {},
        };
      }
      const idx = memories.findIndex((m) => m.id === params.id);
      if (idx === -1) {
        return {
          isError: true,
          content: [{ type: "text", text: `Memory not found: ${params.id}` }],
          details: {},
        };
      }
      memories.splice(idx, 1);
      persist(memories);
      return {
        content: [{ type: "text", text: `Deleted: ${params.id}` }],
        details: { id: params.id, count: memories.length },
      };
    }

    return {
      isError: true,
      content: [{ type: "text", text: `Unknown action: ${params.action}` }],
      details: {},
    };
  },
});

// ── context injection ─────────────────────────────────────────────────────

// Build the system-message block. If total content exceeds INJECT_MAX_BYTES,
// drop oldest memories first (sort by id which is ULID-like timestamp-prefixed)
// and prepend a truncation note so the model knows the list isn't complete.
function memoryBlock(memories: Memory[]): string {
  if (memories.length === 0) return "";
  // Newest first, then trim until under the cap.
  const sorted = [...memories].sort((a, b) => (a.id < b.id ? 1 : -1));
  const kept: Memory[] = [];
  let bytes = 0;
  let dropped = 0;
  for (const m of sorted) {
    const line = `- ${m.content}\n`;
    if (bytes + line.length > INJECT_MAX_BYTES && kept.length > 0) {
      dropped++;
      continue;
    }
    kept.push(m);
    bytes += line.length;
  }
  const truncNote = dropped > 0
    ? `\n[${dropped} older memories omitted to stay under ${INJECT_MAX_BYTES}-byte inject cap. Use the memory tool with action="list" to see all.]`
    : "";
  // Re-sort kept oldest-first for stable presentation
  kept.sort((a, b) => (a.id < b.id ? -1 : 1));
  const lines = kept.map((m) => `- ${m.content}`).join("\n");
  return `# Memories (from past sessions)\n${lines}${truncNote}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(memoryTool);

  // Kill switch for non-Anthropic providers (no prompt caching = per-turn
  // cost). Mirrors SUPERPOWERS_OFF=1.
  if (process.env.MEMORY_OFF === "1") return;

  // Inject memories as a system message at the top of every LLM call.
  // Anthropic + OpenAI prompt caching means the cost is paid once per session
  // and amortized across all subsequent turns.
  pi.on("context", async (event, _ctx) => {
    const memories = load();
    if (memories.length === 0) return undefined;

    const block = memoryBlock(memories);
    const memorySystem = { role: "system" as const, content: block };

    // If first message is already a system message and contains our block, skip.
    const first = event.messages[0];
    if (first?.role === "system" && typeof first.content === "string" && first.content.includes("# Memories (from past sessions)")) {
      return undefined;
    }

    // Otherwise prepend our memory block as a synthetic system message.
    return { messages: [memorySystem, ...event.messages] };
  });
}
