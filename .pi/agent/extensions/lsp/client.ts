/**
 * LSP client — JSON-RPC over stdio.
 *
 * Direct port of opencode/src/lsp/client.ts (which uses vscode-jsonrpc).
 * We implement LSP message framing + request/response correlation here
 * to avoid the npm dep — keeps the extension single-package without
 * `vscode-jsonrpc` in node_modules.
 *
 * Protocol (LSP base spec):
 *   Each message is prefixed by `Content-Length: <N>\r\n\r\n` then a
 *   JSON-RPC 2.0 body of exactly N bytes (UTF-8). Notifications have no
 *   `id`; requests have an integer `id`; responses have the same `id`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { pathToFileURL } from "url";
import { readFileSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import { languageIdFor } from "./language.ts";
import type { ServerConfig } from "./servers.ts";

const INITIALIZE_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 30_000;

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type PendingResolver = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class LspClient {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, PendingResolver>();
  private buf: Buffer = Buffer.alloc(0);
  private openDocs = new Set<string>();
  private docVersions = new Map<string, number>();
  private initialized = false;
  private initializePromise: Promise<void>;

  constructor(
    private serverConfig: ServerConfig,
    private root: string,
  ) {
    this.proc = spawn(serverConfig.command, serverConfig.args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr.on("data", (chunk: Buffer) => {
      // Silently buffer stderr; expose via getStderr() for diagnostics.
      this.stderrBuf.push(chunk);
    });
    this.proc.on("error", (err) => {
      this.failAllPending(new Error(`LSP server ${serverConfig.id} spawn error: ${err.message}`));
    });
    this.proc.on("close", (code) => {
      this.failAllPending(new Error(`LSP server ${serverConfig.id} exited with code ${code}`));
    });

    this.initializePromise = this.doInitialize();
  }

  private stderrBuf: Buffer[] = [];

  getStderr(): string {
    return Buffer.concat(this.stderrBuf).toString("utf-8");
  }

  // ── framing ─────────────────────────────────────────────────────────────

  private onStdout(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      // Look for header terminator
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buf.subarray(0, headerEnd).toString("utf-8");
      const match = header.match(/Content-Length: (\d+)/i);
      if (!match) {
        // Malformed — drop the header to avoid infinite loop.
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const length = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + length) return; // wait for more bytes
      const body = this.buf.subarray(bodyStart, bodyStart + length).toString("utf-8");
      this.buf = this.buf.subarray(bodyStart + length);
      try {
        const msg = JSON.parse(body) as JsonRpcMessage;
        this.onMessage(msg);
      } catch (err) {
        // Bad JSON — log to stderr buffer, keep going.
        this.stderrBuf.push(Buffer.from(`[lsp framing] bad JSON: ${(err as Error).message}\n`));
      }
    }
  }

  private send(msg: JsonRpcMessage) {
    const body = JSON.stringify(msg);
    const buf = Buffer.from(body, "utf-8");
    const header = `Content-Length: ${buf.length}\r\n\r\n`;
    // Concatenate header + body into a single write — some LSP servers'
    // framing parsers tolerate split writes poorly under Bun's child_process.
    this.proc.stdin.write(Buffer.concat([Buffer.from(header, "utf-8"), buf]));
  }

  private onMessage(msg: JsonRpcMessage) {
    // Response to one of our requests
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server-initiated request (has id AND method, no result/error).
    // We MUST respond or the server may block waiting for us. Pyright in
    // particular sends `workspace/configuration` after initialize and
    // refuses to answer documentSymbol until we reply.
    if (msg.id !== undefined && msg.method) {
      this.handleServerRequest(msg.id, msg.method, msg.params);
      return;
    }

    // Server-initiated notification (no id) — publishDiagnostics, logMessage,
    // showMessage, etc. We ignore these for the tool-call use case; they
    // don't block anything.
  }

  /**
   * Reply to server-initiated requests with minimal-but-valid responses.
   *
   * The full LSP spec defines several reverse requests:
   *   - workspace/configuration: server asks for settings for one or more
   *     "sections". We return `[null, null, ...]` (one per requested item)
   *     to mean "no config" — server falls back to defaults.
   *   - client/registerCapability + client/unregisterCapability: server
   *     wants to dynamically register/unregister capabilities. We accept
   *     by returning null. We don't actually act on the registrations.
   *   - workspace/workspaceFolders: server asks for current folders.
   *   - window/workDoneProgress/create: server wants to show progress.
   *
   * For anything else, respond with a "method not found" error so the
   * server doesn't hang.
   */
  private handleServerRequest(id: number, method: string, params: unknown) {
    let response: JsonRpcMessage;
    switch (method) {
      case "workspace/configuration": {
        const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
        response = { jsonrpc: "2.0", id, result: items.map(() => null) };
        break;
      }
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
      case "window/showMessageRequest":
        response = { jsonrpc: "2.0", id, result: null };
        break;
      case "workspace/workspaceFolders":
        response = {
          jsonrpc: "2.0",
          id,
          result: [{ name: "workspace", uri: pathToFileURL(this.root).href }],
        };
        break;
      default:
        response = {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
        break;
    }
    this.send(response);
  }

  private failAllPending(err: Error) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  // ── request / notification helpers ──────────────────────────────────────

  private async request<T = unknown>(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params?: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  private async doInitialize() {
    try {
      await this.request(
        "initialize",
        {
          processId: process.pid,
          rootUri: pathToFileURL(this.root).href,
          workspaceFolders: [{ name: "workspace", uri: pathToFileURL(this.root).href }],
          initializationOptions: this.serverConfig.initializationOptions ?? {},
          capabilities: {
            textDocument: {
              synchronization: { didOpen: true, didChange: true, didClose: true },
              hover: { contentFormat: ["markdown", "plaintext"] },
              definition: { linkSupport: false },
              references: {},
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              implementation: { linkSupport: false },
              callHierarchy: { dynamicRegistration: false },
            },
            workspace: {
              workspaceFolders: true,
              symbol: { dynamicRegistration: false },
              configuration: true,
            },
          },
        },
        INITIALIZE_TIMEOUT_MS,
      );
      this.notify("initialized", {});
      this.initialized = true;
      // Optional warm-up wait before serving requests — rust-analyzer/gopls
      // need a moment after `initialized` to scan the workspace, otherwise
      // workspace_symbol returns empty.
      if (this.serverConfig.indexWaitMs) {
        await new Promise((r) => setTimeout(r, this.serverConfig.indexWaitMs));
      }
    } catch (err) {
      this.initialized = false;
      throw err;
    }
  }

  async ready(): Promise<void> {
    await this.initializePromise;
  }

  shutdown() {
    try {
      this.send({ jsonrpc: "2.0", id: this.nextId++, method: "shutdown" });
      this.notify("exit");
    } catch {
      // already dead
    }
    try {
      this.proc.kill();
    } catch {
      // ignore
    }
  }

  // ── document state ──────────────────────────────────────────────────────

  async ensureOpen(filePath: string): Promise<void> {
    await this.ready();
    if (this.openDocs.has(filePath)) return;
    if (!existsSync(filePath)) {
      throw new Error(`file not found: ${filePath}`);
    }
    const text = readFileSync(filePath, "utf-8");
    const lang = languageIdFor(filePath);
    if (!lang) throw new Error(`No languageId mapping for ${filePath}`);
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(filePath).href,
        languageId: lang,
        version: 1,
        text,
      },
    });
    this.openDocs.add(filePath);
    this.docVersions.set(filePath, 1);
  }

  // ── operations ──────────────────────────────────────────────────────────

  async hover(filePath: string, line: number, character: number) {
    await this.ensureOpen(filePath);
    return this.request("textDocument/hover", {
      textDocument: { uri: pathToFileURL(filePath).href },
      position: { line, character },
    });
  }

  async definition(filePath: string, line: number, character: number) {
    await this.ensureOpen(filePath);
    return this.request("textDocument/definition", {
      textDocument: { uri: pathToFileURL(filePath).href },
      position: { line, character },
    });
  }

  async references(filePath: string, line: number, character: number) {
    await this.ensureOpen(filePath);
    return this.request("textDocument/references", {
      textDocument: { uri: pathToFileURL(filePath).href },
      position: { line, character },
      context: { includeDeclaration: true },
    });
  }

  async implementation(filePath: string, line: number, character: number) {
    await this.ensureOpen(filePath);
    return this.request("textDocument/implementation", {
      textDocument: { uri: pathToFileURL(filePath).href },
      position: { line, character },
    });
  }

  async documentSymbol(filePath: string) {
    await this.ensureOpen(filePath);
    return this.request("textDocument/documentSymbol", {
      textDocument: { uri: pathToFileURL(filePath).href },
    });
  }

  async workspaceSymbol(query: string) {
    await this.ready();
    return this.request("workspace/symbol", { query });
  }

  async prepareCallHierarchy(filePath: string, line: number, character: number) {
    await this.ensureOpen(filePath);
    return this.request("textDocument/prepareCallHierarchy", {
      textDocument: { uri: pathToFileURL(filePath).href },
      position: { line, character },
    });
  }

  async incomingCalls(item: unknown) {
    return this.request("callHierarchy/incomingCalls", { item });
  }

  async outgoingCalls(item: unknown) {
    return this.request("callHierarchy/outgoingCalls", { item });
  }
}

// ── root resolution ────────────────────────────────────────────────────────

export function findWorkspaceRoot(filePath: string, markers: string[]): string {
  let dir = dirname(resolve(filePath));
  const seen = new Set<string>();
  while (dir && !seen.has(dir)) {
    seen.add(dir);
    for (const marker of markers) {
      if (existsSync(`${dir}/${marker}`)) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: containing directory
  return dirname(resolve(filePath));
}

// PATH detection moved to install.ts as `isExecutableOnPath` — re-exported
// here for callers that already import from this module.
export { isExecutableOnPath } from "./install.ts";
