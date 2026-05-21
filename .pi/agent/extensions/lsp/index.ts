/**
 * lsp — language-server-protocol tool for Pi.
 *
 * Port of opencode's `~/opencode/packages/opencode/src/tool/lsp-*.ts`
 * collapsed into a single Pi tool with an "operation" parameter.
 *
 * Why one tool, not nine: opencode exposes `lsp_goto_definition`,
 * `lsp_find_references`, etc. as separate tools. That bloats the tool
 * list shown to the model. Pi prefers fewer tools — pick the operation
 * via a parameter, like ripgrep's modes.
 *
 * Operations:
 *   hover            — type/signature/docs at a position
 *   definition       — jump to where a symbol is defined
 *   references       — find all usages of a symbol
 *   implementation   — find implementations of an interface/abstract method
 *   document_symbols — outline of one file
 *   workspace_symbol — fuzzy search symbols across the workspace
 *   incoming_calls   — call hierarchy: who calls this?
 *   outgoing_calls   — call hierarchy: what does this call?
 *
 * The tool spawns one LSP server per (language, workspace-root) pair
 * the first time you query it, and reuses it for the rest of the session.
 * Server process tree is rooted at the Pi process — when Pi exits, the
 * LSP servers die with it.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LspClient, findWorkspaceRoot, isExecutableOnPath } from "./client.ts";
import { languageIdFor } from "./language.ts";
import { candidatesFor, type ServerConfig } from "./servers.ts";

// ── client cache ───────────────────────────────────────────────────────────

interface ClientCacheKey {
  serverId: string;
  root: string;
}

const clientCache = new Map<string, LspClient>();

function cacheKey(k: ClientCacheKey): string {
  return `${k.serverId}::${k.root}`;
}

/**
 * Resolve a (file → LSP client) by finding the right server config and
 * workspace root, spawning a client if we haven't seen this pair before.
 *
 * Returns either a ready-to-use client or an error string suitable for
 * surfacing to the model (e.g. "rust-analyzer not on PATH — install it").
 */
async function clientFor(filePath: string): Promise<LspClient | string> {
  if (!existsSync(filePath)) return `file not found: ${filePath}`;
  const lang = languageIdFor(filePath);
  if (!lang) return `unknown languageId for ${filePath} (extension not in mapping)`;

  const candidates = candidatesFor(lang);
  if (candidates.length === 0) return `no LSP server configured for language "${lang}"`;

  // For each candidate, resolve workspace root and prefer the one whose
  // root markers actually appear above the file. If multiple candidates
  // resolve the same root, the first in SERVERS wins (deno before tsserver
  // would be wrong — tsserver listed first, deno second, so deno only
  // wins when it has a unique deno.json marker upstream of the file).
  let chosen: { server: ServerConfig; root: string } | undefined;
  for (const cand of candidates) {
    if (!isExecutableOnPath(cand.which)) continue;
    const root = findWorkspaceRoot(filePath, cand.rootMarkers);
    // Verify at least one marker actually matched (findWorkspaceRoot
    // falls back to file's dir if no marker found — distinguish those)
    const matched = cand.rootMarkers.some((m) => existsSync(`${root}/${m}`));
    if (!matched) continue;
    // Prefer servers whose root marker is the most specific (deno.json
    // beats package.json for hybrid projects)
    if (!chosen || cand.rootMarkers.length < chosen.server.rootMarkers.length) {
      chosen = { server: cand, root };
    }
  }

  if (!chosen) {
    // Fall back to first candidate on PATH even without root markers
    const fallback = candidates.find((c) => isExecutableOnPath(c.which));
    if (!fallback) {
      const names = candidates.map((c) => c.which).join(" or ");
      return `LSP server not installed for "${lang}". Install one of: ${names}`;
    }
    chosen = { server: fallback, root: dirname(resolve(filePath)) };
  }

  const key = cacheKey({ serverId: chosen.server.id, root: chosen.root });
  let client = clientCache.get(key);
  if (!client) {
    client = new LspClient(chosen.server, chosen.root);
    clientCache.set(key, client);
  }
  return client;
}

// ── result formatting ──────────────────────────────────────────────────────

interface Location {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

function formatLocations(locations: Location[] | Location | null | undefined): string {
  if (!locations) return "(none)";
  const list = Array.isArray(locations) ? locations : [locations];
  if (list.length === 0) return "(none)";
  const lines: string[] = [];
  for (const loc of list) {
    const path = fileURLToPath(loc.uri);
    const line = loc.range.start.line + 1; // LSP is 0-indexed, humans want 1-indexed
    const col = loc.range.start.character + 1;
    lines.push(`${path}:${line}:${col}`);
    // Try to include the actual line content for context
    try {
      const content = readFileSync(path, "utf-8").split("\n");
      const sourceLine = content[loc.range.start.line];
      if (sourceLine !== undefined) {
        lines.push(`    ${sourceLine.trim()}`);
      }
    } catch {
      // file unreadable — skip preview
    }
  }
  return lines.join("\n");
}

interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  selectionRange?: { start: { line: number; character: number } };
  children?: DocumentSymbol[];
}

// LSP SymbolKind enum (from spec)
const SYMBOL_KIND: Record<number, string> = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
};

function formatDocumentSymbols(symbols: DocumentSymbol[] | null | undefined): string {
  if (!symbols || symbols.length === 0) return "(no symbols)";

  function walk(s: DocumentSymbol, depth: number): string[] {
    const indent = "  ".repeat(depth);
    const kind = SYMBOL_KIND[s.kind] ?? `Kind${s.kind}`;
    const detail = s.detail ? ` ${s.detail}` : "";
    const line = (s.selectionRange ?? s.range).start.line + 1;
    const out = [`${indent}${kind} ${s.name}${detail} (L${line})`];
    if (s.children) {
      for (const child of s.children) out.push(...walk(child, depth + 1));
    }
    return out;
  }

  return symbols.flatMap((s) => walk(s, 0)).join("\n");
}

interface WorkspaceSymbol {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
}

function formatWorkspaceSymbols(symbols: WorkspaceSymbol[] | null | undefined): string {
  if (!symbols || symbols.length === 0) return "(no matches)";
  return symbols
    .map((s) => {
      const kind = SYMBOL_KIND[s.kind] ?? `Kind${s.kind}`;
      const path = fileURLToPath(s.location.uri);
      const line = s.location.range.start.line + 1;
      const container = s.containerName ? ` in ${s.containerName}` : "";
      return `${kind} ${s.name}${container}\n    ${path}:${line}`;
    })
    .join("\n\n");
}

interface Hover {
  contents:
    | string
    | { kind: string; value: string }
    | Array<string | { language: string; value: string }>;
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
}

function formatHover(hover: Hover | null | undefined): string {
  if (!hover || !hover.contents) return "(no hover info)";
  const c = hover.contents;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => (typeof part === "string" ? part : `\`\`\`${part.language}\n${part.value}\n\`\`\``))
      .join("\n\n");
  }
  // MarkupContent { kind, value }
  return c.value;
}

interface CallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } };
  detail?: string;
}

interface CallHierarchyIncoming {
  from: CallHierarchyItem;
  fromRanges: Array<{ start: { line: number; character: number }; end: { line: number; character: number } }>;
}

interface CallHierarchyOutgoing {
  to: CallHierarchyItem;
  fromRanges: Array<{ start: { line: number; character: number }; end: { line: number; character: number } }>;
}

function formatIncomingCalls(calls: CallHierarchyIncoming[] | null | undefined): string {
  if (!calls || calls.length === 0) return "(no incoming calls)";
  return calls
    .map((c) => {
      const kind = SYMBOL_KIND[c.from.kind] ?? `Kind${c.from.kind}`;
      const path = fileURLToPath(c.from.uri);
      const lines = c.fromRanges.map((r) => `L${r.start.line + 1}`).join(", ");
      return `${kind} ${c.from.name} — ${path} (${lines})`;
    })
    .join("\n");
}

function formatOutgoingCalls(calls: CallHierarchyOutgoing[] | null | undefined): string {
  if (!calls || calls.length === 0) return "(no outgoing calls)";
  return calls
    .map((c) => {
      const kind = SYMBOL_KIND[c.to.kind] ?? `Kind${c.to.kind}`;
      const path = fileURLToPath(c.to.uri);
      const lines = c.fromRanges.map((r) => `L${r.start.line + 1}`).join(", ");
      return `${kind} ${c.to.name} — ${path} (${lines})`;
    })
    .join("\n");
}

// ── tool definition ────────────────────────────────────────────────────────

const lspTool = defineTool({
  name: "lsp",
  label: "Language Server",
  description: [
    "Query the Language Server Protocol for a code symbol or file.",
    "",
    "More accurate than regex/grep for code intelligence — uses the same",
    "engine your editor does (typescript-language-server, rust-analyzer,",
    "pyright, gopls, clangd, lua-language-server, etc.).",
    "",
    "Operations:",
    "- `hover` — type signature + doc comment at a line/character",
    "- `definition` — jump to where a symbol is defined",
    "- `references` — list all usages of a symbol",
    "- `implementation` — list implementations of an interface/trait",
    "- `document_symbols` — outline of one file (classes, methods, fns)",
    "- `workspace_symbol` — fuzzy search symbols across whole workspace",
    "- `incoming_calls` — who calls this function?",
    "- `outgoing_calls` — what does this function call?",
    "",
    "Positions are 1-indexed (line + column) to match editor conventions —",
    "internally converted to LSP's 0-indexed form.",
    "",
    "First call per (language, workspace) spawns an LSP server (~2-5s). ",
    "Subsequent calls reuse the cached server, so loops are cheap.",
    "",
    "If an LSP server isn't installed for the file's language, the tool",
    "returns a clear install hint rather than failing silently.",
  ].join("\n"),
  parameters: Type.Object({
    operation: Type.Union(
      [
        Type.Literal("hover"),
        Type.Literal("definition"),
        Type.Literal("references"),
        Type.Literal("implementation"),
        Type.Literal("document_symbols"),
        Type.Literal("workspace_symbol"),
        Type.Literal("incoming_calls"),
        Type.Literal("outgoing_calls"),
      ],
      { description: "LSP operation to perform" },
    ),
    file: Type.Optional(
      Type.String({
        description:
          "Absolute path to a file. Required for all operations except `workspace_symbol`.",
      }),
    ),
    line: Type.Optional(
      Type.Number({
        description: "1-indexed line number. Required for hover, definition, references, implementation, *_calls.",
      }),
    ),
    column: Type.Optional(
      Type.Number({
        description: "1-indexed column number (character offset within the line).",
      }),
    ),
    query: Type.Optional(
      Type.String({ description: "Symbol name query for `workspace_symbol` (fuzzy)." }),
    ),
  }),
  async execute(_id, params) {
    const op = params.operation;

    // Validate per-operation required params
    function err(msg: string) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: msg }],
        details: { operation: op, params },
      };
    }

    if (op === "workspace_symbol") {
      if (!params.query) return err("`workspace_symbol` requires a `query` parameter");
      // workspace_symbol still needs a server to query — pick first one
      // whose language matches *any* opened file. Lacking that, we need a
      // file param to bootstrap.
      if (!params.file) {
        return err("`workspace_symbol` needs a `file` parameter to identify the workspace + language");
      }
    } else {
      if (!params.file) return err(`operation "${op}" requires a "file" parameter`);
      if (
        ["hover", "definition", "references", "implementation", "incoming_calls", "outgoing_calls"].includes(op) &&
        (params.line === undefined || params.column === undefined)
      ) {
        return err(`operation "${op}" requires both "line" and "column" parameters`);
      }
    }

    const filePath = params.file!;
    const client = await clientFor(filePath);
    if (typeof client === "string") return err(client);

    try {
      await client.ready();
    } catch (e) {
      const stderr = client.getStderr();
      return err(
        `LSP server failed to initialize: ${(e as Error).message}${stderr ? `\n\n[stderr]\n${stderr}` : ""}`,
      );
    }

    // Convert 1-indexed user input → 0-indexed LSP
    const line0 = params.line !== undefined ? params.line - 1 : 0;
    const char0 = params.column !== undefined ? params.column - 1 : 0;

    try {
      let text: string;
      let raw: unknown;
      switch (op) {
        case "hover": {
          raw = await client.hover(filePath, line0, char0);
          text = formatHover(raw as Hover | null);
          break;
        }
        case "definition": {
          raw = await client.definition(filePath, line0, char0);
          text = formatLocations(raw as Location[] | Location | null);
          break;
        }
        case "references": {
          raw = await client.references(filePath, line0, char0);
          text = formatLocations(raw as Location[] | null);
          break;
        }
        case "implementation": {
          raw = await client.implementation(filePath, line0, char0);
          text = formatLocations(raw as Location[] | Location | null);
          break;
        }
        case "document_symbols": {
          raw = await client.documentSymbol(filePath);
          text = formatDocumentSymbols(raw as DocumentSymbol[] | null);
          break;
        }
        case "workspace_symbol": {
          raw = await client.workspaceSymbol(params.query!);
          text = formatWorkspaceSymbols(raw as WorkspaceSymbol[] | null);
          break;
        }
        case "incoming_calls": {
          const items = (await client.prepareCallHierarchy(filePath, line0, char0)) as
            | CallHierarchyItem[]
            | null;
          if (!items || items.length === 0) {
            text = "(no symbol at position to start call hierarchy from)";
            raw = null;
          } else {
            // LSP returns multiple candidates; query incoming for each, merge.
            const all: CallHierarchyIncoming[] = [];
            for (const item of items) {
              const incoming = (await client.incomingCalls(item)) as CallHierarchyIncoming[] | null;
              if (incoming) all.push(...incoming);
            }
            raw = all;
            text = formatIncomingCalls(all);
          }
          break;
        }
        case "outgoing_calls": {
          const items = (await client.prepareCallHierarchy(filePath, line0, char0)) as
            | CallHierarchyItem[]
            | null;
          if (!items || items.length === 0) {
            text = "(no symbol at position to start call hierarchy from)";
            raw = null;
          } else {
            const all: CallHierarchyOutgoing[] = [];
            for (const item of items) {
              const outgoing = (await client.outgoingCalls(item)) as CallHierarchyOutgoing[] | null;
              if (outgoing) all.push(...outgoing);
            }
            raw = all;
            text = formatOutgoingCalls(all);
          }
          break;
        }
        default:
          return err(`unknown operation: ${op as string}`);
      }

      return {
        content: [{ type: "text", text }],
        details: { operation: op, raw },
      };
    } catch (e) {
      return err(`LSP ${op} failed: ${(e as Error).message}`);
    }
  },
});

// ── extension entry ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool(lspTool);

  // Best-effort cleanup: shut down LSP servers when Pi exits.
  // Pi doesn't expose a "before_exit" event AFAICT; rely on process.on.
  const cleanup = () => {
    for (const [, client] of clientCache) {
      try {
        client.shutdown();
      } catch {
        // ignore
      }
    }
    clientCache.clear();
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  process.once("exit", cleanup);
}
