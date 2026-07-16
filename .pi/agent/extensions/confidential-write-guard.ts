/**
 * confidential-write-guard — keep confidential third-party identifiers
 * (customer / partner / client names, internal program or deal codenames,
 * named individuals, unreleased roadmap) out of tracked files, WITHOUT a
 * heuristic denylist.
 *
 * Motivating incident (2026-06-26): the agent summarised a pasted internal
 * message into a plan doc, committed it, and pushed to a PUBLIC repo. A
 * regex/denylist can't help — it only knows terms you already flagged, and
 * the dangerous case is always a NOVEL name appearing for the first time.
 *
 * Design — the agent is the classifier, the user is the source of truth:
 *
 *   1. A system-prompt rule (APPEND_SYSTEM.md) tells the agent: before
 *      persisting prose/commit content to a repo with a remote, vet your own
 *      draft; for any term you are not CERTAIN is safe to publish, ask the
 *      user via the `question` tool and use a placeholder until they confirm.
 *
 *   2. When the user answers, the agent records the decision via the
 *      `confidential_terms` tool (this file). That builds a per-repo + global
 *      ground-truth list of blocked / allowed terms — NOT guessed, confirmed.
 *
 *   3. This guard then DETERMINISTICALLY blocks any write/commit containing a
 *      user-blocked term (so the agent can't forget and re-leak it), and
 *      nudges the agent to run the ask-loop at two moments: (a) the first
 *      prose-file write into a repo, and (b) the first commit / PR / issue
 *      write into a repo (git commit, gh pr|issue|release). A commit message +
 *      staged diff is the highest-risk persist-to-remote moment for a NOVEL
 *      identifier, so it gets its own vet reminder even if (a) already fired.
 *      (Each nudge fires once per repo per process - separate trackers.)
 *
 * Enforcement scans the PAYLOAD, not the raw command. For write/edit/apply_patch
 * that's the content being written. For a bash commit/PR it's the message text +
 * the contents of -F/--body-file message files + `git diff --cached` (the staged
 * content) - assembled by collectCommitPayload(). We deliberately do NOT scan
 * arbitrary bash: read/search commands (grep/rg/git log, redirects, the
 * git filter-repo that REMOVES a term) must never be blocked just because the
 * term appears as a search pattern. See isCommitPersist() for the narrow trigger.
 *
 * Cross-session backstop: this is a same-session, commit-time gate - it cannot
 * catch commits authored in a PRIOR session (term not yet blocked / agent not
 * running). That gap is closed by the git pre-push hook at
 * dotfiles/.config/git/hooks/pre-push (installed via global core.hooksPath),
 * which scans the push rev-range against the SAME blocked-term stores + gitleaks.
 *
 * The block reason never echoes the term (that re-propagates it into the
 * session log — the exact mistake that motivated this); it masks the term as
 * [REDACTED] in a short context snippet.
 *
 * Storage (LOCAL, never committed):
 *   - global:   <agentDir>/confidential-terms.local.json
 *   - per-repo: <repo>/.git/info/confidential-terms.json   (inside .git/)
 *   shape: { "blocked": ["…"], "allowed": ["…"] }
 *
 * Kill switch: PI_CONFIDENTIAL_GUARD_OFF=1
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractCdTargets, expandTilde } from "./cd-agents-reload";

// ── store ───────────────────────────────────────────────────────────────────

interface Store {
  blocked: string[];
  allowed: string[];
}

function emptyStore(): Store {
  return { blocked: [], allowed: [] };
}

function globalStorePath(): string {
  return path.join(getAgentDir(), "confidential-terms.local.json");
}

/** Walk up from a path for a .git entry; return repo root or null. */
function findRepoRoot(start: string): string | null {
  let dir = start;
  try {
    if (fs.statSync(start).isFile()) dir = path.dirname(start);
  } catch {
    dir = path.dirname(start);
  }
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function repoStorePath(forPath: string): string | null {
  const root = findRepoRoot(path.isAbsolute(forPath) ? forPath : path.resolve(forPath));
  if (!root) return null;
  const gitDir = path.join(root, ".git");
  // only the common case (.git is a directory) — worktrees/submodules skip per-repo store
  try {
    if (!fs.statSync(gitDir).isDirectory()) return null;
  } catch {
    return null;
  }
  return path.join(gitDir, "info", "confidential-terms.json");
}

function readStore(file: string): Store {
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

function writeStore(file: string, store: Store): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ blocked: dedup(store.blocked), allowed: dedup(store.allowed) }, null, 2) + "\n");
}

function dedup(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}

// Bash tool calls spawn a fresh subprocess per invocation, so a `cd <dir> &&`
// prefix inside the command string changes ONLY that subprocess's directory -
// pi's own process.cwd() never moves. Blindly using process.cwd() here means
// `cd ~/other-repo && git commit ...` gets attributed to pi's startup repo,
// not the repo the commit actually lands in: the wrong per-repo blocked-terms
// store gets checked (a real enforcement gap, not just a cosmetic message
// bug), and the COMMIT_NUDGE message names the wrong directory. Resolve the
// last `cd` target in the command (same heuristic cd-agents-reload.ts already
// uses) and fall back to process.cwd() when there isn't one.
export function resolveBashCwd(cmd: string, fallback: string = process.cwd()): string {
  const targets = extractCdTargets(cmd);
  if (targets.length === 0) return fallback;
  const last = targets[targets.length - 1];
  return path.resolve(fallback, expandTilde(last));
}

function isStoreFile(p: string): boolean {
  const b = path.basename(path.resolve(p));
  return b === "confidential-terms.local.json" || b === "confidential-terms.json";
}

/** Merged blocked terms relevant to a target path (global + that path's repo). */
function blockedTermsFor(targetPath: string): string[] {
  const out = [...readStore(globalStorePath()).blocked];
  const rp = repoStorePath(targetPath);
  if (rp) out.push(...readStore(rp).blocked);
  return dedup(out);
}

// ── matching (deterministic, over the user-confirmed list) ──────────────────

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

// ── nudge tracking (once per remote-backed repo, per process) ───────────────

// prose-file writes and commit/PR persists nudge independently: a commit is the
// last gate before push, so it earns its own reminder even after a prose nudge.
const nudgedRepos = new Set<string>();
const commitNudgedRepos = new Set<string>();

const PROSE_EXT = new Set([".md", ".mdx", ".txt", ".rst", ".adoc", ".org", ".markdown"]);

function isProsePath(p: string): boolean {
  return PROSE_EXT.has(path.extname(p).toLowerCase()) || /(^|\/)docs?\//i.test(p);
}

function repoHasRemote(repoRoot: string): boolean {
  try {
    return /\n\[remote "/.test("\n" + fs.readFileSync(path.join(repoRoot, ".git", "config"), "utf8"));
  } catch {
    return true; // can't tell → assume yes (fail safe toward nudging)
  }
}

const COMMIT_NUDGE = (repoRoot: string, remote: boolean): string =>
  `tool-guard[confidential-write]: first commit / PR / issue write into ${repoRoot}` +
  `${remote ? " (has a remote - may be public/shared)" : ""}.\n` +
  `A commit message + staged diff are about to be persisted. Before this lands, vet BOTH the ` +
  `message and the staged changes for confidential third-party identifiers - not just named ` +
  `customers/partners/individuals and internal codenames, but internal-vs-public framing itself ` +
  `("internal <X>", "the public counterpart to our internal ...", internal label/naming schemes, ` +
  `unreleased roadmap). You are the classifier - there is no denylist. For ANY term or phrasing you ` +
  `are not certain is safe to publish, rephrase or use a placeholder, and record confirmed-confidential ` +
  `terms with the \`confidential_terms\` tool so they're enforced. If you have already vetted this ` +
  `content, retry - this fires once per repo. Kill switch: PI_CONFIDENTIAL_GUARD_OFF=1.`;

const NUDGE = (repoRoot: string, remote: boolean): string =>
  `tool-guard[confidential-write]: first prose/commit write into ${repoRoot}` +
  `${remote ? " (has a remote — may be public/shared)" : ""}.\n` +
  `Before persisting, vet your draft for confidential third-party identifiers ` +
  `(customer/partner/client names, internal codenames, named individuals, unreleased roadmap). ` +
  `You are the classifier — there is no denylist. For ANY term you are not certain is safe to ` +
  `publish, ask the user via the \`question\` tool and use a placeholder until they confirm, then ` +
  `record their answer with the \`confidential_terms\` tool (action "block" or "allow") so it's ` +
  `remembered and enforced. If you have already vetted this content, retry the write — this nudge ` +
  `fires once per repo.`;

// ── the recording tool ──────────────────────────────────────────────────────

const confidentialTermsTool = defineTool({
  name: "confidential_terms",
  label: "Confidential terms",
  promptSnippet:
    "confidential_terms — record the user's confirmation about whether specific terms are safe to write to a repo. block / allow / unblock / list. Call AFTER asking the user via `question`.",
  promptGuidelines: [
    "After you ask the user whether a term is OK to commit and they answer, record it here so you never re-ask and blocked terms are enforced.",
    'Use action "block" for terms the user says must NOT be written, "allow" for terms they confirm are fine.',
    "Default scope is the current repo; pass scope:\"global\" for an identifier sensitive everywhere.",
  ],
  description: [
    "Record user-confirmed decisions about confidential identifiers so the confidential-write guard can enforce them.",
    "",
    "Actions:",
    '- "block": user confirmed these terms must NOT be written to tracked files (enforced on future writes).',
    '- "allow": user confirmed these terms are safe to write (clears any block).',
    '- "unblock": remove terms from the block list.',
    '- "list": show current blocked/allowed terms.',
    "",
    "Storage is LOCAL and never committed (global file under the agent dir + per-repo file inside .git/info/).",
  ].join("\n"),
  parameters: Type.Object({
    action: Type.Union(
      [Type.Literal("block"), Type.Literal("allow"), Type.Literal("unblock"), Type.Literal("list")],
      { description: "What to do" },
    ),
    terms: Type.Optional(Type.Array(Type.String(), { description: "Terms (required for block/allow/unblock)" })),
    scope: Type.Optional(
      Type.Union([Type.Literal("repo"), Type.Literal("global")], {
        description: "Where to record (default: repo if inside one, else global)",
      }),
    ),
  }),

  async execute(_id, params, _signal, _onUpdate, _ctx) {
    const cwd = process.cwd();
    const repoFile = repoStorePath(cwd);
    const useRepo = params.scope === "global" ? false : params.scope === "repo" ? true : !!repoFile;
    const file = useRepo && repoFile ? repoFile : globalStorePath();
    const store = readStore(file);

    if (params.action === "list") {
      const g = readStore(globalStorePath());
      const r = repoFile ? readStore(repoFile) : emptyStore();
      const txt =
        `global: blocked=${g.blocked.length} allowed=${g.allowed.length}\n` +
        `repo:   blocked=${r.blocked.length} allowed=${r.allowed.length}\n` +
        `(values are stored locally and intentionally not echoed here)`;
      return { content: [{ type: "text", text: txt }], details: { global: g, repo: r } };
    }

    const terms = dedup(params.terms ?? []);
    if (terms.length === 0) {
      return { content: [{ type: "text", text: "No terms provided." }], details: { ok: false } };
    }

    if (params.action === "block") {
      store.blocked = dedup([...store.blocked, ...terms]);
      store.allowed = store.allowed.filter((t) => !terms.some((x) => x.toLowerCase() === t.toLowerCase()));
    } else if (params.action === "allow") {
      store.allowed = dedup([...store.allowed, ...terms]);
      store.blocked = store.blocked.filter((t) => !terms.some((x) => x.toLowerCase() === t.toLowerCase()));
    } else if (params.action === "unblock") {
      store.blocked = store.blocked.filter((t) => !terms.some((x) => x.toLowerCase() === t.toLowerCase()));
    }
    writeStore(file, store);
    return {
      content: [{ type: "text", text: `Recorded ${terms.length} term(s) as ${params.action} in ${useRepo ? "repo" : "global"} store.` }],
      details: { action: params.action, count: terms.length, scope: useRepo ? "repo" : "global" },
    };
  },
});

// bash commands that PERSIST PROSE TO A (possibly shared/public) REMOTE - commit
// messages, tags, PR/issue/release bodies. This is BOTH the vet-nudge trigger
// AND the enforcement trigger: the guard scans the *payload* of these commands
// (message text + staged diff + message-file contents), never arbitrary bash.
//
// Deliberately narrow. The old WRITE_BASH also matched `>>?`, `\btee\b`,
// `\bsd\b`, `\bsed -i\b`, `\bdd\b` - which meant a READ/SEARCH command that
// merely contained a redirect or a coincidental word (`grep x 2>/dev/null`,
// `rg term | tee log`, even the `git filter-repo` that REMOVES a term) tripped
// the scan and got blocked because the search *pattern* was a blocked term.
// Reading/searching is the safest possible op; it must never be blocked. Normal
// file writes are already covered by the write/edit/apply_patch payload scan
// above, and a `>`-redirect into a tracked prose file is caught by the pre-push
// hook backstop - so dropping those tokens here is a net safety gain.
const COMMIT_PERSIST =
  /\bgit\s+commit\b|\bgit\s+(?:tag|notes)\b|\bgh\s+(?:pr|issue|release)\s+(?:create|edit|comment)\b/;

/** True when a bash command persists a commit message / PR / issue body. */
export function isCommitPersist(cmd: string): boolean {
  return COMMIT_PERSIST.test(cmd);
}

// Message-file flags whose *contents* are part of the persisted payload:
//   git commit -F <file> / --file=<file>
//   git tag    -F <file> / --file=<file>
//   gh ... --body-file <file>
// The `-` sentinel (stdin) is excluded - we can't read it here; the heredoc
// body (if any) is already inline in the command string and gets scanned.
const MESSAGE_FILE_FLAG =
  /(?:^|\s)(?:-F|--file|--body-file)(?:=|\s+)(['"]?)([^'"\s]+)\1/g;

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
// identifier appearing anywhere trips the boundary regex, so we don't need the
// whole thing - just enough to catch the common case without stalling a huge
// commit. 512 KiB is generous for messages + a normal diff.
const PAYLOAD_SCAN_CAP = 512 * 1024;

/** Staged diff for a repo (the content half of a `git commit` payload). */
function stagedDiff(cwd: string): string {
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
 *   - the command string itself (captures inline `-m` / `--body` / heredoc)
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

function extractPatchPaths(patchText: string): string[] {
  const out: string[] = [];
  for (const line of patchText.split(/\r?\n/)) {
    const m = line.match(/^\*\*\* (?:Add|Update|Delete|Move(?: to)?) File: (.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

function blockMsg(masked: string, where: string): string {
  return (
    `tool-guard[confidential-write]: blocked — ${where} contains a user-blocked term. ` +
    `Context: ${masked}\nThis identifier was previously confirmed confidential. Replace it with a ` +
    `placeholder ("Customer", "the partner", "<redacted>"). To change the decision, use the ` +
    `\`confidential_terms\` tool (action "allow"/"unblock"). Kill switch: PI_CONFIDENTIAL_GUARD_OFF=1.`
  );
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_CONFIDENTIAL_GUARD_OFF === "1") return;

  pi.registerTool(confidentialTermsTool);

  pi.on("tool_call", async (event) => {
    const tool = event.toolName;

    // write / edit / write_stream — enforce blocked terms + nudge on prose
    if (tool === "write" || tool === "edit" || tool === "write_stream") {
      const input = event.input as {
        path?: string;
        file_path?: string;
        content?: string;
        // edit: current schema is edits[]; top-level newText is legacy (old sessions).
        newText?: string;
        edits?: Array<{ oldText?: string; newText?: string }>;
      };
      const target = input.path ?? input.file_path;
      if (typeof target !== "string" || isStoreFile(target)) return undefined;

      const blocked = blockedTermsFor(target);
      const editTexts = Array.isArray(input.edits) ? input.edits.map((e) => e?.newText ?? "") : [];
      for (const blob of [target, input.content ?? "", input.newText ?? "", ...editTexts]) {
        const hit = scanForBlocked(blob, blocked);
        if (hit) return { block: true, reason: blockMsg(hit.masked, `${tool} → ${target}`) };
      }

      // once-per-repo prose/commit nudge to run the ask-loop
      const root = findRepoRoot(path.isAbsolute(target) ? target : path.resolve(target));
      if (root && isProsePath(target) && !nudgedRepos.has(root)) {
        nudgedRepos.add(root);
        return { block: true, reason: NUDGE(root, repoHasRemote(root)) };
      }
      return undefined;
    }

    if (tool === "apply_patch") {
      const patchText = (event.input as { patchText?: string }).patchText ?? "";
      const paths = extractPatchPaths(patchText);
      if (paths.length > 0 && paths.every(isStoreFile)) return undefined;
      const hit = scanForBlocked(patchText, blockedTermsFor(paths[0] ?? process.cwd()));
      if (hit) return { block: true, reason: blockMsg(hit.masked, "apply_patch") };
      return undefined;
    }

    // bash - ONLY commit/PR/issue persists (never read/search/redirect commands).
    // We scan the persisted PAYLOAD (message + staged diff + message files), not
    // the raw argv, so search patterns in read commands can't false-positive and
    // an identifier in the staged content is still caught.
    if (tool === "bash") {
      const cmd = (event.input as { command?: string }).command;
      if (typeof cmd !== "string" || !isCommitPersist(cmd)) return undefined;
      const bashCwd = resolveBashCwd(cmd);

      const blocked = blockedTermsFor(bashCwd);
      if (blocked.length > 0) {
        for (const blob of collectCommitPayload(cmd, bashCwd)) {
          const hit = scanForBlocked(blob, blocked);
          if (hit) return { block: true, reason: blockMsg(hit.masked, "bash (commit/PR payload)") };
        }
      }

      // once-per-repo commit/PR/issue vet nudge (independent of the prose nudge)
      const root = findRepoRoot(bashCwd);
      if (root && !commitNudgedRepos.has(root)) {
        commitNudgedRepos.add(root);
        return { block: true, reason: COMMIT_NUDGE(root, repoHasRemote(root)) };
      }
      return undefined;
    }

    return undefined;
  });
}
