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
 *      nudges once per remote-backed repo so the ask-loop actually runs.
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
import * as fs from "node:fs";
import * as path from "node:path";

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

const nudgedRepos = new Set<string>();

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

// ── bash commands that WRITE (so a term in them is about to be persisted) ───
const WRITE_BASH = /(\bgit\s+commit\b|\btee\b|>>?|\bsd\b|\bsed\s+-i\b|\bperl\s+-i\b|\bdd\b|\bgit\s+(?:tag|notes)\b)/;

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

    // bash — only when the command writes/commits
    if (tool === "bash") {
      const cmd = (event.input as { command?: string }).command;
      if (typeof cmd !== "string" || !WRITE_BASH.test(cmd)) return undefined;
      const hit = scanForBlocked(cmd, blockedTermsFor(process.cwd()));
      if (hit) return { block: true, reason: blockMsg(hit.masked, "bash (writes/commits)") };
      return undefined;
    }

    return undefined;
  });
}
