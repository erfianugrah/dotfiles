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
import * as path from "node:path";
import {
  COMMIT_NUDGE,
  isCommitNudged,
  isCommitPersist,
  markCommitNudged,
  repoHasRemote,
  RERUN_FULL_NOTICE,
} from "./lib/guard-commit-shared";
import {
  blockedTermsFor as coreBlockedTermsFor,
  collectCommitPayload,
  dedup,
  emptyStore,
  extractMessageFilePaths,
  extractPatchPaths,
  findRepoRoot,
  globalStorePath as coreGlobalStorePath,
  isProsePath,
  isStoreFile,
  readStore,
  repoStorePath,
  resolveBashCwd,
  scanForBlocked,
  writeStore,
  type Store,
} from "./lib/confidential-write-guard-core";

// Re-exported so existing imports (tests) keep working. isCommitPersist's
// canonical home is guard-commit-shared.ts (cd-agents-reload absorbs the nudge
// when IT blocks the same compound commit command first); the pure detection /
// payload helpers live in confidential-write-guard-core.ts, shared with the
// Claude Code hook.
export { collectCommitPayload, extractMessageFilePaths, isCommitPersist, resolveBashCwd, scanForBlocked };

// ── store (bind the agent-dir-parameterised core helpers) ────────────────────

function globalStorePath(): string {
  return coreGlobalStorePath(getAgentDir());
}

/** Merged blocked terms relevant to a target path (global + that path's repo). */
function blockedTermsFor(targetPath: string): string[] {
  return coreBlockedTermsFor(targetPath, getAgentDir());
}

// ── nudge tracking (once per remote-backed repo, per process) ───────────────

// prose-file writes and commit/PR persists nudge independently: a commit is the
// last gate before push, so it earns its own reminder even after a prose nudge.
// The COMMIT tracker lives in guard-commit-shared.ts (isCommitNudged /
// markCommitNudged) so cd-agents-reload can mark it delivered when IT blocks
// the same compound commit command first - avoids a double-block cascade that
// swallows the command's side effects (heredoc message file, git add) twice.
const nudgedRepos = new Set<string>();

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

// The commit-payload assembly (extractMessageFilePaths / collectCommitPayload /
// extractPatchPaths) and term scanning live in confidential-write-guard-core.ts,
// shared with the Claude Code hook. The guard scans the *payload* of commit
// commands (message text + staged diff + message-file contents), never
// arbitrary bash, so a READ/SEARCH command containing a blocked term as a
// search pattern can't false-positive. isCommitPersist (from
// guard-commit-shared.ts) is BOTH the vet-nudge trigger AND the enforcement
// trigger; cd-agents-reload needs the same predicate to absorb the nudge.

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
          // The block swallowed the WHOLE command (heredoc message file,
          // git add) - say so, or the agent retries only the commit suffix.
          if (hit) {
            return {
              block: true,
              reason: blockMsg(hit.masked, "bash (commit/PR payload)") + "\n\n" + RERUN_FULL_NOTICE,
            };
          }
        }
      }

      // once-per-repo commit/PR/issue vet nudge (independent of the prose nudge)
      const root = findRepoRoot(bashCwd);
      if (root && !isCommitNudged(root)) {
        markCommitNudged(root);
        return { block: true, reason: COMMIT_NUDGE(root, repoHasRemote(root)) };
      }
      return undefined;
    }

    return undefined;
  });
}
