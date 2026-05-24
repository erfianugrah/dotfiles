/**
 * yank — copy a code block from the last assistant message to the system
 * clipboard, intact (no terminal-wrap newlines).
 *
 * Why this exists: pi renders long single-line commands with visual wrap.
 * Selecting-and-copying from the terminal grabs those wrap breaks AS REAL
 * NEWLINES. Pasting a PowerShell / shell one-liner that way breaks the
 * command (unclosed quote → continuation prompt, broken pipeline, etc.).
 *
 * `/yank` reads the message directly from pi's session entries (the
 * structured pre-render form) so wrap is irrelevant — the clipboard gets
 * exactly the bytes the LLM wrote.
 *
 * Usage:
 * Usage (short form — both `/y` and `/yank` work):
 *   /y                copy the FIRST code block from the last assistant message
 *   /y 2              copy the 2nd code block
 *   /y -1             copy the LAST code block (negative = from end)
 *   /y ?              list all code blocks with previews (no copy)
 *   /y ^              copy first block from PREVIOUS assistant message
 *   /y ^^             two messages back; ^^^ = three back; etc.
 *   /y 2^             block 2 from previous message
 *   /y ?^             list blocks from previous message
 *
 * Legacy verbose form still accepted: `/yank back 1`, `/yank list`.
 *
 * Clipboard transport (probed in order):
 *   - WSL              clip.exe
 *   - macOS            pbcopy
 *   - Wayland (Linux)  wl-copy
 *   - X11 (Linux)      xclip -selection clipboard
 *   - Termux           termux-clipboard-set
 *   - else             OSC 52 fallback (works in Kitty, WezTerm, Ghostty,
 *                      iTerm2, foot, alacritty when configured)
 *
 * Pairs with the built-in `/copy` (which copies the entire assistant
 * message, including prose) — `/yank` is for just one code block at a time.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// ── code-block extraction ─────────────────────────────────────────────────

interface CodeBlock {
  language: string; // "powershell" | "bash" | "" | ...
  body: string; // intact, no trailing newline
}

// ── argument parser ───────────────────────────────────────────────────────

export interface YankSpec {
  /** Block selector: positive (1-indexed from start) or negative (-1 = last) */
  n: number | null;
  /** Number of messages to go back (0 = latest assistant, 1 = previous, ...) */
  back: number;
  /** List mode — print blocks instead of copying */
  list: boolean;
  /** Parse error, if any */
  error?: string;
}

/**
 * Parse `/yank` / `/y` arguments. Accepts:
 *   ""            → { n: 1, back: 0 }
 *   "2"           → { n: 2, back: 0 }
 *   "-1"          → { n: -1, back: 0 }    (last block)
 *   "?"           → { n: null, back: 0, list: true }
 *   "list"        → same as ?
 *   "^"           → { n: 1, back: 1 }
 *   "^^"          → { n: 1, back: 2 }
 *   "2^"          → { n: 2, back: 1 }
 *   "?^"          → { n: null, back: 1, list: true }
 *   "back 2"      → { n: 1, back: 2 }    (legacy)
 *   "list back 1" → { n: null, back: 1, list: true }   (legacy)
 */
export function parseYankArgs(raw: string): YankSpec {
  const trimmed = raw.trim();
  if (trimmed === "") return { n: 1, back: 0, list: false };

  // Legacy: "back N" anywhere in the args
  const tokens = trimmed.split(/\s+/);
  let back = 0;
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "back" && i + 1 < tokens.length) {
      const m = Number.parseInt(tokens[i + 1], 10);
      if (!Number.isNaN(m) && m >= 0) {
        back = m;
        i++;
        continue;
      }
    }
    kept.push(tokens[i]);
  }

  // Now we have at most one positional token (numeric, `?`, `list`, `^^^...`, or `N^^^`)
  const verb = kept[0] ?? "";
  if (kept.length > 1) {
    return { n: null, back: 0, list: false, error: `too many arguments: "${raw}"` };
  }
  if (verb === "") {
    return { n: 1, back, list: false };
  }

  // Strip trailing carets and count them as back-steps
  const caretMatch = verb.match(/^([^\^]*)(\^+)$/);
  let body = verb;
  if (caretMatch) {
    body = caretMatch[1];
    back += caretMatch[2].length;
  }

  // Now `body` is one of: "", "?", "list", "ls", or a number (with optional minus)
  if (body === "") return { n: 1, back, list: false };
  if (body === "?" || body === "list" || body === "ls") {
    return { n: null, back, list: true };
  }
  const n = Number.parseInt(body, 10);
  if (Number.isNaN(n) || String(n) !== body || n === 0) {
    return { n: null, back: 0, list: false, error: `unknown argument: "${verb}"` };
  }
  return { n, back, list: false };
}

/**
 * Parse markdown fenced code blocks from a text body.
 *
 * Handles:
 *  - opening fence: 3+ backticks, optional language tag
 *  - matching closing fence (same number of backticks)
 *  - nested fences with longer outer (e.g. ```` ``` ```` for showing fences)
 *  - tildes (~~~) as alternative fence char
 */
export function parseCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lines = text.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fence is 3+ backticks (or tildes) at start of line, optionally indented up to 3 spaces
    const fenceMatch = line.match(/^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)?/);
    if (fenceMatch) {
      const indent = fenceMatch[1].length;
      const fence = fenceMatch[2];
      const language = (fenceMatch[3] ?? "").toLowerCase();
      const fenceChar = fence[0]; // ` or ~
      const fenceLen = fence.length;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const inner = lines[i];
        // Closing fence: same char, >= same length, only whitespace after
        const closeMatch = inner.match(
          new RegExp(`^ {0,3}${fenceChar === "`" ? "`" : "~"}{${fenceLen},}\\s*$`),
        );
        if (closeMatch) {
          break;
        }
        // Strip the opener's indent if present (best-effort markdown CommonMark)
        body.push(indent > 0 && inner.startsWith(" ".repeat(indent)) ? inner.slice(indent) : inner);
        i++;
      }
      // Body without trailing blank line (most blocks have one)
      while (body.length > 0 && body[body.length - 1] === "") body.pop();
      blocks.push({ language, body: body.join("\n") });
    }
    i++;
  }
  return blocks;
}

// ── clipboard transport ───────────────────────────────────────────────────

interface ClipResult {
  ok: boolean;
  via: string;
  err?: string;
}

function isWsl(): boolean {
  // /proc/version contains "microsoft" on WSL
  try {
    if (!existsSync("/proc/version")) return false;
    return Bun.file("/proc/version").text().then((t) => /microsoft/i.test(t)) as unknown as boolean;
  } catch {
    return false;
  }
}

async function isWslAsync(): Promise<boolean> {
  try {
    if (!existsSync("/proc/version")) return false;
    const t = await Bun.file("/proc/version").text();
    return /microsoft/i.test(t);
  } catch {
    return false;
  }
}

function which(cmd: string): boolean {
  // Cheap PATH check without spawning a shell.
  // Returns true only if the binary exists on PATH.
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (existsSync(`${dir}/${cmd}`)) return true;
  }
  return false;
}

function pipeToCmd(cmd: string, args: string[], data: string): Promise<ClipResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (e) => resolve({ ok: false, via: cmd, err: e.message }));
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, via: cmd });
      else resolve({ ok: false, via: cmd, err: stderr || `exit ${code}` });
    });
    child.stdin.end(data);
  });
}

/**
 * OSC 52 — copy via terminal escape sequence. Works in most modern
 * terminals (Kitty, WezTerm, Ghostty, iTerm2, foot, alacritty with config).
 * Tmux passthrough required if running inside tmux.
 *
 * Limit: many terminals cap OSC 52 payload at ~74KB. We bail out for huge
 * blocks and fall back to disk + a message.
 */
function osc52(data: string): boolean {
  const MAX = 74 * 1024;
  if (data.length > MAX) return false;
  const b64 = Buffer.from(data, "utf8").toString("base64");
  const seq = `\x1b]52;c;${b64}\x07`;
  // If inside tmux, wrap with DCS passthrough
  const inTmux = !!process.env.TMUX;
  const out = inTmux ? `\x1bPtmux;\x1b${seq}\x1b\\` : seq;
  try {
    process.stderr.write(out);
    return true;
  } catch {
    return false;
  }
}

async function copyToClipboard(data: string): Promise<ClipResult> {
  // 1. WSL — clip.exe converts to CRLF; we DON'T want that for shell commands,
  //    so pass through unchanged. PowerShell handles LF fine.
  if (await isWslAsync()) {
    if (which("clip.exe")) {
      const r = await pipeToCmd("clip.exe", [], data);
      if (r.ok) return r;
    }
  }
  // 2. macOS
  if (process.platform === "darwin" && which("pbcopy")) {
    const r = await pipeToCmd("pbcopy", [], data);
    if (r.ok) return r;
  }
  // 3. Wayland
  if (process.env.WAYLAND_DISPLAY && which("wl-copy")) {
    const r = await pipeToCmd("wl-copy", [], data);
    if (r.ok) return r;
  }
  // 4. X11
  if (process.env.DISPLAY && which("xclip")) {
    const r = await pipeToCmd("xclip", ["-selection", "clipboard"], data);
    if (r.ok) return r;
  }
  if (process.env.DISPLAY && which("xsel")) {
    const r = await pipeToCmd("xsel", ["--clipboard", "--input"], data);
    if (r.ok) return r;
  }
  // 5. Termux
  if (which("termux-clipboard-set")) {
    const r = await pipeToCmd("termux-clipboard-set", [], data);
    if (r.ok) return r;
  }
  // 6. OSC 52 fallback
  if (osc52(data)) return { ok: true, via: "OSC52" };

  return { ok: false, via: "none", err: "no clipboard transport available" };
}

// ── helpers ───────────────────────────────────────────────────────────────

interface AssistantText {
  entryId: string;
  text: string;
  age: number; // 0 = latest assistant message, 1 = previous, ...
}

/**
 * Walk entries newest → oldest, return assistant messages with text content.
 * Concatenates multiple text parts in the same message (LLMs sometimes split).
 */
function collectAssistantTexts(
  entries: Array<{ id: string; type: string; message?: { role?: string; content?: unknown[] } }>,
): AssistantText[] {
  const out: AssistantText[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== "message" || e.message?.role !== "assistant") continue;
    const parts = (e.message.content ?? []) as Array<{ type: string; text?: string }>;
    const texts = parts.filter((p) => p.type === "text" && p.text).map((p) => p.text as string);
    if (texts.length === 0) continue;
    out.push({ entryId: e.id, text: texts.join("\n\n"), age: out.length });
  }
  return out;
}

function preview(s: string, n = 60): string {
  const oneLine = s.replace(/\n/g, " ⏎ ");
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

// ── extension ─────────────────────────────────────────────────────────────

async function handleYank(args: string, ctx: {
  sessionManager: { getEntries: () => unknown };
  ui: { notify: (msg: string, level: string) => void };
}) {
  const spec = parseYankArgs(args);
  if (spec.error) {
    ctx.ui.notify(`${spec.error}\nusage: /y [N|?|^] (e.g. /y, /y 2, /y -1, /y ?, /y ^^, /y 2^)`, "warning");
    return;
  }

  const entries = ctx.sessionManager.getEntries() as Array<{
    id: string;
    type: string;
    message?: { role?: string; content?: unknown[] };
  }>;
  const texts = collectAssistantTexts(entries);
  if (texts.length === 0) {
    ctx.ui.notify("no assistant messages yet", "warning");
    return;
  }
  if (spec.back >= texts.length) {
    ctx.ui.notify(`only ${texts.length} assistant message(s) available—can't go back ${spec.back}`, "warning");
    return;
  }

  const target = texts[spec.back];
  const blocks = parseCodeBlocks(target.text);
  if (blocks.length === 0) {
    ctx.ui.notify(
      spec.back === 0
        ? "no code blocks in last assistant message (try /y ^)"
        : `no code blocks ${spec.back} message(s) back`,
      "warning",
    );
    return;
  }

  if (spec.list) {
    const header = spec.back === 0
      ? `${blocks.length} block(s) in last message:`
      : `${blocks.length} block(s) ${spec.back} message(s) back:`;
    const lines = blocks.map(
      (b, i) => `  ${i + 1}. [${b.language || "plain"}] ${b.body.length}B  —  ${preview(b.body)}`,
    );
    ctx.ui.notify([header, ...lines].join("\n"), "info");
    return;
  }

  // Resolve negative indices (-1 = last block)
  if (spec.n === null) {
    ctx.ui.notify("internal: no block selected", "warning");
    return;
  }
  const idx = spec.n > 0 ? spec.n - 1 : blocks.length + spec.n;
  if (idx < 0 || idx >= blocks.length) {
    ctx.ui.notify(
      `only ${blocks.length} block(s) available (you asked for #${spec.n})`,
      "warning",
    );
    return;
  }

  const block = blocks[idx];
  const result = await copyToClipboard(block.body);
  if (!result.ok) {
    ctx.ui.notify(`copy failed via ${result.via}: ${result.err ?? "unknown"}`, "error");
    return;
  }

  const lang = block.language || "plain";
  const tag = spec.back === 0 ? "" : ` ←${spec.back}`;
  ctx.ui.notify(
    `yanked #${idx + 1}/${blocks.length} [${lang}] — ${block.body.length}B${tag}`,
    "info",
  );
}

export default function (pi: ExtensionAPI) {
  const desc = "Copy a code block from the last assistant message. /y [N|?|^]";

  pi.registerCommand("y", { description: desc, handler: handleYank });
  pi.registerCommand("yank", { description: desc, handler: handleYank });
}
