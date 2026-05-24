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
 * Paste-friendly suffix `!` — make the block paste cleanly into a shell:
 *   /y !              copy block 1, paste-friendly
 *   /y 2!             copy block 2, paste-friendly
 *   /y -1!^           last block of previous message, paste-friendly
 *
 * `!` applies (in order):
 *   1. ASCII-fold cosmetic Unicode (em/en-dash → -, smart quotes → ASCII,
 *      … → ..., NBSP → space, zero-width chars → removed). Defends
 *      against PowerShell consoles whose input codepage is CP437 / CP1252
 *      and mojibakes UTF-8 multi-byte sequences on paste.
 *   2. Strip comment-only lines (`# ...` in shell, removes the most common
 *      source of mojibake-prone Unicode in LLM output).
 *   3. Flatten line-continuations (pipe `|\n`, bash `\\\n`, PS backtick).
 *      Same semantics, one robust line.
 *   4. For shell-family languages still multi-line after step 3, join
 *      statements with `;` so PowerShell / bash parses the whole block
 *      atomically instead of line-by-line (which trips `>>` continuation
 *      prompts and breaks chains where each line depends on the previous).
 *
 * Why this exists: PowerShell evaluates pasted lines as they arrive.
 * A multi-line block whose statements depend on each other often fails
 * because PS shows `>>` prompts between lines, or treats each line as a
 * standalone interactive submission. Joining with `;` makes the whole
 * block one syntactic unit.
 *
 * Shell-family languages: powershell, ps, ps1, pwsh, bash, sh, zsh, fish.
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
  /** Flatten shell line-continuations into a single line before copy */
  flatten: boolean;
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
  if (trimmed === "") return { n: 1, back: 0, list: false, flatten: false };

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

  const verb = kept[0] ?? "";
  if (kept.length > 1) {
    return { n: null, back: 0, list: false, flatten: false, error: `too many arguments: "${raw}"` };
  }
  if (verb === "") {
    return { n: 1, back, list: false, flatten: false };
  }

  // Strip trailing `!` (flatten flag). May appear BEFORE or AFTER caret stack.
  let body = verb;
  let flatten = false;
  if (body.endsWith("!")) {
    flatten = true;
    body = body.slice(0, -1);
  }

  // Strip trailing carets and count them as back-steps
  const caretMatch = body.match(/^([^\^]*)(\^+)$/);
  if (caretMatch) {
    body = caretMatch[1];
    back += caretMatch[2].length;
  }

  // Allow `!` after the caret stack too: `/y 2^!` is the same as `/y 2!^`
  if (body.endsWith("!")) {
    flatten = true;
    body = body.slice(0, -1);
  }

  // Now `body` is one of: "", "?", "list", "ls", or a number (with optional minus)
  if (body === "") return { n: 1, back, list: false, flatten };
  if (body === "?" || body === "list" || body === "ls") {
    return { n: null, back, list: true, flatten };
  }
  const n = Number.parseInt(body, 10);
  if (Number.isNaN(n) || String(n) !== body || n === 0) {
    return { n: null, back: 0, list: false, flatten: false, error: `unknown argument: "${verb}"` };
  }
  return { n, back, list: false, flatten };
}

// ── shell line-continuation flattener ──────────────────────────────────────

/**
 * Does `body` look like shell code where every non-last line ends with a
 * continuation marker (pipe, backslash, PS backtick)? If so it's a safe
 * candidate for flattening to a single line — the semantics of `cmd1 | cmd2`
 * are the same whether on one line or three.
 *
 * Used both for the `!` flag (force-flatten) and for the discoverability
 * hint shown in the toast when the yanked block matches this shape.
 */
export function isFlattenable(body: string): boolean {
  const lines = body.split("\n");
  if (lines.length < 2) return false;
  for (let i = 0; i < lines.length - 1; i++) {
    const t = lines[i].trimEnd();
    if (t.length === 0) return false; // blank line in the middle — not a clean pipeline
    const last = t[t.length - 1];
    if (last !== "|" && last !== "\\" && last !== "`") return false;
  }
  return true;
}

/**
 * Collapse `cmd1 |\n    cmd2 |\n    cmd3` into `cmd1 | cmd2 | cmd3`.
 * Also handles `cmd \\\n    next` (bash backslash) and `cmd `\n    next`
 * (PowerShell backtick). Internal whitespace around the join points is
 * normalised to a single space.
 */
export function flattenLineContinuations(body: string): string {
  return body
    // bash backslash-continuation: \<spaces>\n<indent>  →  " "
    .replace(/\\\s*\n\s*/g, " ")
    // PowerShell backtick-continuation: `<spaces>\n<indent>  →  " "
    .replace(/`\s*\n\s*/g, " ")
    // Pipe-continuation: |<spaces>\n<indent>  →  " | "
    .replace(/\|\s*\n\s*/g, " | ")
    // Collapse any incidental double-spaces from the joins
    .replace(/  +/g, " ");
}

// ── ASCII-fold + comment-strip + statement-join helpers ─────────────────────

/**
 * Fold cosmetic Unicode to its ASCII equivalent. Targets the typography
 * characters LLMs frequently emit in comments and prose that get mangled
 * by non-UTF-8 console codepages (CP437 on Windows PowerShell, CP1252 on
 * legacy Windows). Safe in shell context because shell syntax never
 * relies on these characters.
 */
export function asciiFold(s: string): { out: string; folded: number } {
  let folded = 0;
  const count = (re: RegExp): number => (s.match(re) || []).length;
  folded += count(/[\u2013\u2014]/g);       // en-dash, em-dash
  folded += count(/[\u2018\u2019]/g);       // smart single quotes
  folded += count(/[\u201C\u201D]/g);       // smart double quotes
  folded += count(/\u2026/g);                // horizontal ellipsis
  folded += count(/\u00A0/g);                // non-breaking space
  folded += count(/[\u200B-\u200D\uFEFF]/g); // zero-width chars
  const out = s
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
  return { out, folded };
}

const SHELL_LANGS = new Set([
  "powershell", "ps", "ps1", "pwsh",
  "bash", "sh", "zsh", "fish",
]);

export function isShellLang(lang: string): boolean {
  return SHELL_LANGS.has(lang.toLowerCase());
}

/**
 * Strip lines that are only a `#` comment (with optional leading whitespace).
 * Keeps lines where `#` appears AFTER content (those would mid-line truncate
 * after a `;`-join, but we can't reliably parse to detect those without a
 * real shell parser). Returns the cleaned body + count of lines stripped.
 */
export function stripCommentLines(body: string): { out: string; stripped: number } {
  const lines = body.split("\n");
  const kept: string[] = [];
  let stripped = 0;
  for (const line of lines) {
    if (/^\s*#/.test(line)) {
      stripped++;
      continue;
    }
    kept.push(line);
  }
  return { out: kept.join("\n"), stripped };
}

/**
 * Join multi-statement shell code with `;` separators so the whole block
 * pastes as ONE command instead of N independent submissions. Skips blank
 * lines, trims trailing `;` to avoid `;;` doubling, normalises whitespace.
 *
 * Safe for: assignments, function calls, `if/else`, `foreach`, anything
 * that's a complete statement per line. NOT safe for: lines that open a
 * block on one line and continue the block body on the next (e.g.
 * `function Foo {\n    ...\n}`). For those, `!` would mangle the
 * structure — the detector below excludes such blocks.
 */
export function joinStatements(body: string): string {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/;+$/, ""))
    .join(" ; ");
}

/**
 * Could this body be safely joined with `;` separators? True only when:
 *   - language is shell-family
 *   - every line (after blank-trim) is balanced w.r.t. brackets
 *   - no line opens a multi-line construct that's closed on a later line
 */
export function isJoinable(body: string, lang: string): boolean {
  if (!isShellLang(lang)) return false;
  const lines = body.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) return false;

  // Reject here-strings and heredocs outright — these MUST stay multi-line.
  if (/@["']/.test(body) || /<<[-~]?\s*[A-Za-z_]/.test(body)) return false;

  // Each LINE must end with bracket depth 0. If a line opens a block that's
  // closed on a later line, joining with `;` would shove a separator inside
  // the block (e.g. `function Foo {` + `;` + `body` + `;` + `}` works in PS
  // but pollutes the function body, and breaks in bash for `if/then/fi`).
  for (const line of lines) {
    let depth = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      // skip strings (single + double + backtick)
      if (c === '"' || c === "'" || c === "`") {
        const q = c;
        i++;
        while (i < line.length && line[i] !== q) {
          if (line[i] === "\\") i++;
          i++;
        }
        continue;
      }
      if (c === "#") break; // rest of line is comment
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
    }
    if (depth !== 0) return false; // line straddles a syntactic group
  }
  return true;
}

export interface PasteFriendlyResult {
  out: string;
  steps: string[]; // human-readable list of what happened (for toast)
}

/**
 * Apply the full paste-friendly pipeline. Returns the transformed text
 * plus a step-by-step note suitable for the toast message.
 */
export function makePasteFriendly(body: string, lang: string): PasteFriendlyResult {
  const steps: string[] = [];
  let work = body;

  const folded = asciiFold(work);
  if (folded.folded > 0) {
    work = folded.out;
    steps.push(`folded ${folded.folded} Unicode char${folded.folded === 1 ? "" : "s"}`);
  }

  if (isShellLang(lang)) {
    const stripped = stripCommentLines(work);
    if (stripped.stripped > 0) {
      work = stripped.out;
      steps.push(`stripped ${stripped.stripped} comment line${stripped.stripped === 1 ? "" : "s"}`);
    }
  }

  if (isFlattenable(work)) {
    const before = work.split("\n").length;
    work = flattenLineContinuations(work);
    steps.push(`flattened ${before}→1 line`);
  } else if (isJoinable(work, lang)) {
    const before = work.split("\n").filter((l) => l.trim().length > 0).length;
    work = joinStatements(work);
    steps.push(`joined ${before} statements with ' ; '`);
  }

  return { out: work, steps };
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
    ctx.ui.notify(`${spec.error}\nusage: /y [N|?|^]  add ! to flatten line-continuations`, "warning");
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
  const flattenable = isFlattenable(block.body);
  const joinable = isJoinable(block.body, block.language);
  const pasteFriendlyAvailable = flattenable || joinable;

  let payload = block.body;
  let summary = "";
  if (spec.flatten) {
    const r = makePasteFriendly(block.body, block.language);
    payload = r.out;
    if (r.steps.length > 0) {
      summary = ` · ${r.steps.join(", ")}`;
    } else {
      summary = " · ⚠ nothing to do (already paste-friendly)";
    }
  }

  const result = await copyToClipboard(payload);
  if (!result.ok) {
    ctx.ui.notify(`copy failed via ${result.via}: ${result.err ?? "unknown"}`, "error");
    return;
  }

  const lang = block.language || "plain";
  const tag = spec.back === 0 ? "" : ` ←${spec.back}`;
  const hint =
    !spec.flatten && pasteFriendlyAvailable
      ? `  (multi-line; /y ${spec.n}${spec.back > 0 ? "^".repeat(spec.back) : ""}! for paste-friendly)`
      : "";
  ctx.ui.notify(
    `yanked #${idx + 1}/${blocks.length} [${lang}] — ${payload.length}B${tag}${summary}${hint}`,
    "info",
  );
}

export default function (pi: ExtensionAPI) {
  const desc = "Copy a code block from the last assistant message. /y [N|?|^]";

  pi.registerCommand("y", { description: desc, handler: handleYank });
  pi.registerCommand("yank", { description: desc, handler: handleYank });
}
