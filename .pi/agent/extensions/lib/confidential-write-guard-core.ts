/**
 * confidential-write-guard-core - pure, harness-agnostic term-scanner + store
 * + commit-payload assembly for the confidential-write guard. ZERO imports from
 * @earendil-works/*. node stdlib only.
 *
 * Source of truth for BOTH the pi adapter (../confidential-write-guard.ts, a
 * `tool_call` block hook) AND the Claude Code hook
 * (../../../.claude/hooks/confidential-write-guard.ts, a PreToolUse deny hook).
 * One detection + store implementation, two harnesses.
 *
 * The guard DETERMINISTICALLY blocks any write/edit/commit payload containing a
 * user-CONFIRMED-confidential term. The term list is NOT a heuristic denylist -
 * it is built from explicit user confirmations recorded (in pi) via the
 * `confidential_terms` tool. There is no guessing here: this core only enforces
 * what the user already said is confidential.
 *
 * Storage (LOCAL, never committed):
 *   - global:   <agentDir>/confidential-terms.local.json
 *   - per-repo: <repo>/.git/info/confidential-terms.json
 *   shape: { "blocked": ["..."], "allowed": ["..."] }
 *
 * The block reason NEVER echoes the matched term (that would re-propagate it
 * into the session log - the exact mistake that motivated the guard); it masks
 * the term as [REDACTED] in a short surrounding-context snippet.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const HOME = process.env.HOME || process.env.USERPROFILE || "";

// ── tilde / cd-target helpers (inlined so the core is fully harness-free) ─────

/** Expand a leading `~` / `~/` to $HOME. */
export function expandTilde(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return HOME + p.slice(1);
  return p;
}

/**
 * Extract every `cd <dir>` target from a bash command line (last one wins for
 * cwd resolution). Mirrors cd-agents-reload's extractCdTargets: handles
 * &&/||/;/|/newline segment delimiters and quoted/bare paths; skips `cd -`,
 * `cd ..`, `cd /`, and `$`-containing paths (unresolvable without a shell).
 */
export function extractCdTargets(command: string): string[] {
  const out: string[] = [];
  const segments = command.split(/&&|\|\||;|\n|\|/);
  for (const seg of segments) {
    const m = seg.match(/^\s*cd\s+(?:'([^']+)'|"([^"]+)"|([^\s;&|]+))/);
    if (!m) continue;
    const raw = m[1] ?? m[2] ?? m[3];
    if (!raw) continue;
    if (raw === "-" || raw === "..") continue;
    if (raw === "/" || raw.includes("$") || raw.startsWith("$")) continue;
    out.push(raw);
  }
  return out;
}

/**
 * Resolve the effective cwd for a bash command. A `cd <dir> &&` prefix inside
 * the command string changes only the spawned subprocess's cwd - the host
 * process never moves - so we resolve the last `cd` target relative to the
 * fallback (the host cwd), and fall back to it when there is no `cd`.
 */
export function resolveBashCwd(cmd: string, fallback: string = process.cwd()): string {
  const targets = extractCdTargets(cmd);
  if (targets.length === 0) return fallback;
  const last = targets[targets.length - 1];
  return path.resolve(fallback, expandTilde(last));
}

// ── store ────────────────────────────────────────────────────────────────────

export interface Store {
  blocked: string[];
  allowed: string[];
}

export function emptyStore(): Store {
  return { blocked: [], allowed: [] };
}

export function dedup(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}

export function globalStorePath(agentDir: string): string {
  return path.join(agentDir, "confidential-terms.local.json");
}

/**
 * Per-repo store path for a target file/dir, or null when the target is not in
 * a git repo whose `.git` is a real directory (worktrees/submodules where .git
 * is a file skip the per-repo store).
 */
export function repoStorePath(forPath: string): string | null {
  const root = findRepoRoot(path.isAbsolute(forPath) ? forPath : path.resolve(forPath));
  if (!root) return null;
  const gitDir = path.join(root, ".git");
  try {
    if (!fs.statSync(gitDir).isDirectory()) return null;
  } catch {
    return null;
  }
  return path.join(gitDir, "info", "confidential-terms.json");
}

export function readStore(file: string): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      blocked: Array.isArray(raw.blocked) ? raw.blocked.map(String) : [],
      allowed: Array.isArray(raw.allowed) ? raw.allowed.map(String) : [],
    };
  } catch {
    return emptyStore();
  }
}

export function writeStore(file: string, store: Store): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ blocked: dedup(store.blocked), allowed: dedup(store.allowed) }, null, 2) + "\n",
  );
}

/** True when a path IS a terms store file (never scan/block our own storage). */
export function isStoreFile(p: string): boolean {
  const b = path.basename(path.resolve(p));
  return b === "confidential-terms.local.json" || b === "confidential-terms.json";
}

/** Merged blocked terms relevant to a target path (global + that path's repo). */
export function blockedTermsFor(targetPath: string, agentDir: string): string[] {
  const out = [...readStore(globalStorePath(agentDir)).blocked];
  const rp = repoStorePath(targetPath);
  if (rp) out.push(...readStore(rp).blocked);
  return dedup(out);
}

// ── repo helpers ──────────────────────────────────────────────────────────────

/** Walk up from a path for a .git entry; return repo root or null. */
export function findRepoRoot(start: string, exists: (p: string) => boolean = fs.existsSync): string | null {
  let dir = start;
  try {
    if (fs.statSync(start).isFile()) dir = path.dirname(start);
  } catch {
    dir = path.dirname(start);
  }
  for (let i = 0; i < 64; i++) {
    if (exists(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ── matching (deterministic, over the user-confirmed list) ────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termRegex(term: string): RegExp {
  // non-alphanumeric boundaries so "Acme" matches in "Acme/Foo" but not "Acmebot"
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(term)}(?![A-Za-z0-9])`, "i");
}

export interface Hit {
  masked: string;
}

/** First user-blocked term found in `text`; masks the term in a context snippet. */
export function scanForBlocked(text: string, blocked: string[]): Hit | null {
  if (!text) return null;
  for (const term of blocked) {
    const m = termRegex(term).exec(text);
    if (m) {
      const start = m.index;
      const end = start + m[0].length;
      const a = Math.max(0, start - 24);
      const b = Math.min(text.length, end + 24);
      const before = text.slice(a, start).replace(/\s+/g, " ");
      const after = text.slice(end, b).replace(/\s+/g, " ");
      return { masked: `${a > 0 ? "…" : ""}${before}[REDACTED]${after}${b < text.length ? "…" : ""}` };
    }
  }
  return null;
}

// ── prose classification (once-per-repo nudge trigger) ────────────────────────

const PROSE_EXT = new Set([".md", ".mdx", ".txt", ".rst", ".adoc", ".org", ".markdown"]);

export function isProsePath(p: string): boolean {
  return PROSE_EXT.has(path.extname(p).toLowerCase()) || /(^|\/)docs?\//i.test(p);
}

// ── commit-persist detection (shared narrow trigger) ──────────────────────────

// bash commands that PERSIST PROSE to a (possibly shared/public) remote - commit
// messages, tags, PR/issue/release bodies. Deliberately narrow: read/search
// commands must never trip it (a term as a grep pattern must not false-positive).
const COMMIT_PERSIST =
  /\bgit\s+commit\b|\bgit\s+(?:tag|notes)\b|\bgh\s+(?:pr|issue|release)\s+(?:create|edit|comment)\b/;

/** True when a bash command persists a commit message / PR / issue body. */
export function isCommitPersist(cmd: string): boolean {
  return COMMIT_PERSIST.test(cmd);
}

// ── commit-payload assembly (scan the payload, not raw argv) ───────────────────

// Message-file flags whose *contents* are part of the persisted payload:
//   git commit -F <file> / --file=<file>
//   git tag    -F <file> / --file=<file>
//   gh ... --body-file <file>
// The `-` sentinel (stdin) is excluded.
const MESSAGE_FILE_FLAG = /(?:^|\s)(?:-F|--file|--body-file)(?:=|\s+)(['"]?)([^'"\s]+)\1/g;

/** Paths whose contents form part of a commit/PR payload (excludes stdin `-`). */
export function extractMessageFilePaths(cmd: string): string[] {
  const out: string[] = [];
  MESSAGE_FILE_FLAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MESSAGE_FILE_FLAG.exec(cmd)) !== null) {
    const p = m[2];
    if (p && p !== "-") out.push(p);
  }
  return out;
}

// Cap how much staged diff / message-file text we pull into the scan. A blocked
// identifier anywhere trips the boundary regex, so we don't need the whole thing.
const PAYLOAD_SCAN_CAP = 512 * 1024;

/** Staged diff for a repo (the content half of a `git commit` payload). */
export function stagedDiff(cwd: string): string {
  try {
    return execFileSync("git", ["diff", "--cached", "--no-color"], {
      cwd,
      encoding: "utf8",
      timeout: 4000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).slice(0, PAYLOAD_SCAN_CAP);
  } catch {
    return "";
  }
}

/**
 * Assemble the persisted-payload text for a commit/PR/issue bash command:
 *   - the command string itself (inline `-m` / `--body` / heredoc)
 *   - the contents of any -F / --body-file message files
 *   - for `git commit`, the staged diff (`git diff --cached`)
 * We scan THIS, not the raw command alone, so an identifier that lands in the
 * staged content or a message file is caught even though it's not in argv.
 */
export function collectCommitPayload(
  cmd: string,
  cwd: string,
  readFile: (p: string) => string = (p) => {
    try {
      return fs.readFileSync(p, "utf8").slice(0, PAYLOAD_SCAN_CAP);
    } catch {
      return "";
    }
  },
  diff: (c: string) => string = stagedDiff,
): string[] {
  const parts: string[] = [cmd];
  for (const rel of extractMessageFilePaths(cmd)) {
    const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, expandTilde(rel));
    const body = readFile(abs);
    if (body) parts.push(body);
  }
  if (/\bgit\s+commit\b/.test(cmd)) {
    const d = diff(cwd);
    if (d) parts.push(d);
  }
  return parts;
}

/** Extract the target paths from an apply_patch / *** Add|Update|... File: block. */
export function extractPatchPaths(patchText: string): string[] {
  const out: string[] = [];
  for (const line of patchText.split(/\r?\n/)) {
    const m = line.match(/^\*\*\* (?:Add|Update|Delete|Move(?: to)?) File: (.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

// ── block reason (never echoes the term) ──────────────────────────────────────

export function blockMsg(masked: string, where: string, killSwitchEnv: string): string {
  return (
    `confidential-write-guard: blocked - ${where} contains a user-blocked term. ` +
    `Context: ${masked}\nThis identifier was previously confirmed confidential. Replace it with a ` +
    `placeholder ("Customer", "the partner", "<redacted>"). To change the decision, edit the ` +
    `confidential-terms store (action "allow"/"unblock"). Kill switch: ${killSwitchEnv}=1.`
  );
}

// ── harness-agnostic orchestrator ─────────────────────────────────────────────

export type GuardDecision =
  | { block: false }
  | { block: true; reason: string; masked: string; where: string };

const ALLOW: GuardDecision = { block: false };

/**
 * Decide whether a Write/Edit payload should be blocked. Pure over the passed
 * blocked-term list; caller resolves the list (blockedTermsFor) and supplies
 * the target path + candidate text blobs (content, new_string, edit newTexts).
 */
export function evaluateWrite(args: {
  target: string;
  blocked: string[];
  blobs: string[];
  where: string;
  killSwitchEnv: string;
}): GuardDecision {
  if (isStoreFile(args.target)) return ALLOW;
  for (const blob of [args.target, ...args.blobs]) {
    const hit = scanForBlocked(blob, args.blocked);
    if (hit) {
      return {
        block: true,
        masked: hit.masked,
        where: args.where,
        reason: blockMsg(hit.masked, args.where, args.killSwitchEnv),
      };
    }
  }
  return ALLOW;
}

/**
 * Decide whether a commit/PR/issue bash command should be blocked. Only fires
 * for isCommitPersist commands; scans the assembled payload (message + message
 * files + staged diff). `cwd` should already be resolved via resolveBashCwd.
 */
export function evaluateCommitBash(args: {
  cmd: string;
  cwd: string;
  blocked: string[];
  killSwitchEnv: string;
  collectPayload?: (cmd: string, cwd: string) => string[];
}): GuardDecision {
  if (!isCommitPersist(args.cmd)) return ALLOW;
  if (args.blocked.length === 0) return ALLOW;
  const collect = args.collectPayload ?? ((c, d) => collectCommitPayload(c, d));
  for (const blob of collect(args.cmd, args.cwd)) {
    const hit = scanForBlocked(blob, args.blocked);
    if (hit) {
      const where = "bash (commit/PR payload)";
      return {
        block: true,
        masked: hit.masked,
        where,
        reason: blockMsg(hit.masked, where, args.killSwitchEnv),
      };
    }
  }
  return ALLOW;
}
