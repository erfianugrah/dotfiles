/**
 * epistemic-guard - mechanical provenance checking for the specifics the
 * agent emits, so "do not be confidently wrong" stops being prose and starts
 * being enforcement.
 *
 * Why this exists:
 *   APPEND_SYSTEM.md has an "Epistemic calibration" section, and two skills
 *   cover adjacent ground (`verification-before-completion` for your OWN work,
 *   `validating-empirically` for external RUNTIME behaviour). All three are
 *   read-time guidance. None of them fire at claim time, which is the moment
 *   that matters: the model states `Caddy 2.8.4`, `--dns-01`, `/etc/knot/knot.conf`,
 *   `https://caddyserver.com/docs/caddyfile/directives/tls`, "40% faster" - and
 *   nothing in the harness knows whether it read that or remembered it.
 *
 * The asset a harness has that a chatbot does not:
 *   A session is a PROVENANCE CORPUS. Every tool result, every bash output,
 *   every user message is a record of what the agent actually saw. A specific
 *   literal that appears in the agent's output but in NO tool result is, by
 *   construction, recalled from training - unverified by definition.
 *
 *   That check is cheap, deterministic, and self-healing: the moment the agent
 *   verifies a claim with any tool, the literal enters the corpus and never
 *   flags again. The guard literally rewards checking.
 *
 * Three surfaces:
 *   1. tool_call gate (write / edit / write_stream / apply_patch, and the
 *      MESSAGE half of a git-commit / gh-pr persist) - blocks with the list.
 *   2. message_end footer - appends a one-line "recalled, not verified"
 *      annotation to a final chat answer. Non-blocking.
 *   3. /epistemics - on-demand report: corpus size, what has been flagged.
 *
 * Unattended runs (pi -p, task/bg_task subagents) get different treatment:
 *   - NO chat footer when !ctx.hasUI (the assistant text IS the stdout).
 *   - BLOCK BUDGET when !ctx.hasUI (PI_EPISTEMIC_MAX_BLOCKS, default 3).
 *
 * Kill switches: PI_EPISTEMIC_GUARD_OFF=1 (everything),
 *                PI_EPISTEMIC_FOOTER_OFF=1 (chat annotation only),
 *                PI_EPISTEMIC_MAX_BLOCKS=0 (observe-only in unattended runs).
 *
 * Pure logic lives in ./lib/epistemic-guard-core.ts (shared with the Claude
 * Code PostToolUse hook); this file is the thin pi adapter and re-exports the
 * pure helpers so existing importers (tests/extensions.test.ts,
 * tests/loop-date-class.test.ts) keep resolving them here.
 *
 * Companion skill: ~/.pi/agent/skills/epistemics/SKILL.md
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type Claim,
  type ClaimClass,
  type Corpus,
  type PayloadMode,
  type Segment,
  absorb,
  assistantAnswerText,
  blockReason,
  commitMessageText,
  corpusSize,
  derivedNear,
  extractClaims,
  footerLine,
  hasProvenance,
  hedgedNear,
  isMessagePersist,
  newCorpus,
  patchAddedText,
  patchTargets,
  payloadMode,
  provenanceText,
  unprovenanced,
} from "./lib/epistemic-guard-core.ts";

// Re-export the pure surface so pi tests keep importing it from this adapter.
export {
  type Claim,
  type ClaimClass,
  type Corpus,
  type PayloadMode,
  type Segment,
  absorb,
  assistantAnswerText,
  blockReason,
  commitMessageText,
  corpusSize,
  derivedNear,
  extractClaims,
  footerLine,
  hasProvenance,
  hedgedNear,
  isMessagePersist,
  newCorpus,
  patchAddedText,
  patchTargets,
  payloadMode,
  provenanceText,
  unprovenanced,
};

// -- extension ---------------------------------------------------------------

interface SessionState {
  corpus: Corpus;
  cursor: number;
  flagged: Set<string>;
  seededSystemPrompt: boolean;
  blocks: number;
  footers: number;
  suppressed: number;
}

/**
 * Block budget for an unattended run. Interactive sessions are unbudgeted -
 * per-specific dedup is enough noise control when a human is watching. `pi -p`
 * restarts with an empty corpus each iteration, so the same recalled specifics
 * re-block every pass; capping keeps that a bounded tax, and 0 turns the gate
 * into pure observation.
 */
function unattendedBudget(): number {
  const raw = process.env.PI_EPISTEMIC_MAX_BLOCKS;
  if (raw === undefined) return 3;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_EPISTEMIC_GUARD_OFF === "1") return;
  const footerOff = process.env.PI_EPISTEMIC_FOOTER_OFF === "1";

  const states = new Map<string, SessionState>();

  const sessionKey = (ctx: unknown): string => {
    try {
      const sm = (ctx as { sessionManager?: { getSessionFile?: () => string } }).sessionManager;
      return sm?.getSessionFile?.() ?? "default";
    } catch {
      return "default";
    }
  };

  const stateFor = (ctx: unknown): SessionState => {
    const key = sessionKey(ctx);
    let s = states.get(key);
    if (!s) {
      s = {
        corpus: newCorpus(),
        cursor: 0,
        flagged: new Set(),
        seededSystemPrompt: false,
        blocks: 0,
        footers: 0,
        suppressed: 0,
      };
      states.set(key, s);
    }
    return s;
  };

  /**
   * Bring the corpus up to date with the session. Cursor-based so a long
   * session costs nothing per call, and re-derived from sessionManager rather
   * than accumulated in-process so /resume and forks inherit provenance.
   */
  const sync = (ctx: unknown): SessionState => {
    const s = stateFor(ctx);
    const c = ctx as {
      sessionManager?: { getEntries?: () => unknown[] };
      getSystemPrompt?: () => string;
    };

    if (!s.seededSystemPrompt) {
      s.seededSystemPrompt = true;
      try {
        absorb(s.corpus, c.getSystemPrompt?.() ?? "");
      } catch {
        /* older pi: no getSystemPrompt */
      }
    }

    let entries: unknown[] = [];
    try {
      entries = c.sessionManager?.getEntries?.() ?? [];
    } catch {
      return s;
    }
    for (let i = s.cursor; i < entries.length; i++) {
      const t = provenanceText(entries[i]);
      if (t) absorb(s.corpus, t);
    }
    s.cursor = entries.length;
    return s;
  };

  // 1. write / commit gate ---------------------------------------------------
  pi.on("tool_call", async (event, ctx) => {
    const e = event as {
      toolName: string;
      input: {
        path?: string;
        file_path?: string;
        content?: string;
        newText?: string;
        edits?: Array<{ newText?: string }>;
        patchText?: string;
        command?: string;
      };
    };

    let mode: PayloadMode = "skip";
    let text = "";
    let where = "";

    if (e.toolName === "write" || e.toolName === "write_stream" || e.toolName === "edit") {
      const target = e.input.path ?? e.input.file_path;
      if (typeof target !== "string") return undefined;
      mode = payloadMode(target);
      if (mode === "skip") return undefined;
      const edits = Array.isArray(e.input.edits) ? e.input.edits.map((x) => x?.newText ?? "") : [];
      text = [e.input.content ?? "", e.input.newText ?? "", ...edits].join("\n");
      where = `${e.toolName} -> ${target}`;
    } else if (e.toolName === "apply_patch") {
      const patchText = e.input.patchText ?? "";
      const targets = patchTargets(patchText);
      const modes = targets.map(payloadMode);
      mode = modes.includes("prose") ? "prose" : modes.includes("code") ? "code" : "skip";
      if (mode === "skip") return undefined;
      text = patchAddedText(patchText);
      where = "apply_patch";
    } else if (e.toolName === "bash") {
      const cmd = e.input.command;
      if (typeof cmd !== "string" || !isMessagePersist(cmd)) return undefined;
      text = commitMessageText(cmd);
      if (!text.trim()) return undefined;
      mode = "prose";
      where = "commit/PR message";
    } else {
      return undefined;
    }

    if (!text.trim()) return undefined;

    const s = sync(ctx);
    const claims = extractClaims(text, mode);
    if (claims.length === 0) return undefined;

    const hits = unprovenanced(s.corpus, claims, s.flagged);
    if (hits.length === 0) return undefined;

    const hasUI = (ctx as { hasUI?: boolean }).hasUI !== false;
    if (!hasUI && s.blocks >= unattendedBudget()) {
      s.suppressed += hits.length;
      return undefined;
    }

    s.blocks++;
    return { block: true, reason: blockReason(hits, where) };
  });

  // 2. chat answer annotation ------------------------------------------------
  pi.on("message_end", async (event, ctx) => {
    if (footerOff) return undefined;
    if ((ctx as { hasUI?: boolean }).hasUI === false) return undefined;

    const e = event as { message?: { role?: string; content?: unknown } };
    const msg = e.message;
    if (!msg || msg.role !== "assistant") return undefined;

    const answer = assistantAnswerText(msg);
    if (!answer.trim()) return undefined;

    const s = sync(ctx);
    const hits = unprovenanced(s.corpus, extractClaims(answer, "prose"), s.flagged);
    if (hits.length === 0) return undefined;

    const content = msg.content as Array<{ type?: string; text?: string }>;
    let lastText = -1;
    for (let i = content.length - 1; i >= 0; i--) {
      if (content[i]?.type === "text" && typeof content[i]?.text === "string") {
        lastText = i;
        break;
      }
    }
    if (lastText === -1) return undefined;

    s.footers++;
    const patched = content.map((b, i) =>
      i === lastText ? { ...b, text: `${b.text}\n\n${footerLine(hits)}` } : b,
    );
    return { message: { ...msg, content: patched } };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    states.delete(sessionKey(ctx));
  });

  // 3. /epistemics -----------------------------------------------------------
  pi.registerCommand("epistemics", {
    description: "Provenance report: what this session verified vs recalled (/epistemics [reset])",
    handler: async (args, ctx) => {
      const s = sync(ctx);

      if (args.trim() === "reset") {
        s.flagged.clear();
        ctx.ui.notify("epistemic-guard: flagged set cleared", "info");
        return;
      }

      const c = s.corpus;
      const lines: string[] = [
        "epistemic-guard - session provenance",
        "",
        `corpus (literals seen in tool output / user messages): ${corpusSize(c)}`,
        `  version ${c.version.size}  url ${c.url.size}  cve ${c.cve.size}` +
          `  perf ${c.perf.size}  flag ${c.flag.size}  syspath ${c.syspath.size}`,
        `entries scanned: ${s.cursor}   writes blocked: ${s.blocks}` +
          `   answers annotated: ${s.footers}` +
          (s.suppressed ? `   suppressed (budget spent): ${s.suppressed}` : ""),
        "",
      ];

      if (s.flagged.size === 0) {
        lines.push("flagged this session: none - every specific emitted so far had provenance.");
      } else {
        lines.push(`flagged this session (recalled, not verified) - ${s.flagged.size}:`);
        for (const id of [...s.flagged].slice(0, 40)) {
          const i = id.indexOf(":");
          lines.push(`  - ${id.slice(i + 1)}  (${id.slice(0, i)})`);
        }
        if (s.flagged.size > 40) lines.push(`  ... and ${s.flagged.size - 40} more`);
      }

      let entries: unknown[] = [];
      try {
        entries = ctx.sessionManager.getEntries();
      } catch {
        entries = [];
      }
      for (let i = entries.length - 1; i >= 0; i--) {
        const en = entries[i] as { type?: string; message?: unknown };
        if (en?.type !== "message") continue;
        const answer = assistantAnswerText(en.message);
        if (!answer) continue;
        const claims = extractClaims(answer, "prose");
        const open = claims.filter((x) => !hasProvenance(s.corpus, x));
        lines.push("", `last answer: ${claims.length} specific(s), ${open.length} without provenance`);
        for (const x of open.slice(0, 10)) lines.push(`  - ${x.raw}  (${x.cls})`);
        break;
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
