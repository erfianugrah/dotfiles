#!/usr/bin/env bun
/**
 * epistemic-guard - Claude Code PostToolUse hook. After a Write/Edit/MultiEdit
 * lands, it checks the SPECIFICS the payload emitted (versions, urls, cves, perf
 * numbers, flags, syspaths, dates) against a PROVENANCE CORPUS built from the
 * session transcript. A specific that appears in the write but in NO tool
 * result / bash output / user message is, by construction, recalled from
 * training - unverified - and gets surfaced as an additionalContext annotation
 * so the model self-corrects (verify, label, or drop it).
 *
 * Why PostToolUse (annotate) and not PreToolUse (deny):
 *   pi's guard BLOCKS at tool_call time. CC's PreToolUse deny would work too,
 *   but the transcript-provenance model is best-effort here (see below), and a
 *   false deny is far more disruptive than a false annotation. PostToolUse
 *   additionalContext is the safe, verified CC surface: the write already
 *   succeeded, the model reads the note and fixes the specific in a follow-up.
 *   This mirrors the pi guard's INTENT (name the unprovenanced specifics + the
 *   per-class verify hint) without the harder deny/allow contract.
 *
 * Shares .pi/agent/extensions/lib/epistemic-guard-core.ts with the pi adapter
 * (epistemic-guard.ts) - one claim extractor + corpus + gate, two harnesses.
 * The core is zero-dependency (node:path only), so this runs identically from
 * the repo checkout or the stowed ~/.claude/hooks/ symlink.
 *
 * Best-effort provenance (marked partial in the port notes): CC exposes the
 * session as a JSONL transcript at `transcript_path`. We absorb the text the
 * agent SAW - user messages, tool_result blocks (bash/read/grep output) - and
 * deliberately EXCLUDE assistant text and tool_use inputs, so a hallucination
 * cannot bootstrap itself into "verified". The JSONL entry shapes are read
 * defensively: unknown shapes contribute nothing rather than throwing.
 *
 * Kill switch: EPISTEMIC_GUARD_OFF=1 (parallels pi's PI_EPISTEMIC_GUARD_OFF).
 */

import * as fs from "node:fs";
import {
  type Corpus,
  absorb,
  gateWrite,
  newCorpus,
  payloadMode,
} from "../../.pi/agent/extensions/lib/epistemic-guard-core.ts";

const KILL_SWITCH = "EPISTEMIC_GUARD_OFF";

// -- CC transcript -> provenance text ---------------------------------------

/** Flatten a CC message `content` (string or block array) to plain text. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (!b || typeof b !== "object") continue;
    const type = b.type;
    // Plain text the user typed.
    if (type === "text" && typeof b.text === "string") {
      out.push(b.text);
      continue;
    }
    // A tool RESULT is provenance: it is what the agent saw come back from a
    // tool (bash stdout, file read, grep hits, MCP output). Its `content` is
    // itself a string or a block array.
    if (type === "tool_result") {
      out.push(contentToText(b.content));
      continue;
    }
    // tool_use (the agent's OWN tool arguments) and any assistant text are
    // intentionally NOT harvested - counting the agent's output as evidence
    // would let a hallucination verify itself.
  }
  return out.join("\n");
}

/**
 * Text from ONE CC transcript entry that counts as provenance.
 *
 * CC records tool results as `user`-role turns whose content carries
 * `tool_result` blocks, and genuine user input as `user` turns with `text`
 * blocks - both are things the agent SAW, so both are absorbed. Assistant
 * turns are skipped wholesale (that is the agent's own output).
 */
function provenanceFromEntry(entry: unknown): string {
  const e = entry as { type?: string; summary?: unknown; message?: { role?: string; content?: unknown } };
  if (!e || typeof e !== "object") return "";
  const role = e.message?.role ?? e.type;
  if (role === "assistant") return ""; // agent's own words are never provenance
  if (role === "user") return contentToText(e.message?.content);
  // Compaction / branch summaries carry verified facts forward past a
  // compaction boundary - the core's provenanceText harvests them, so the CC
  // corpus must too (else a fact verified pre-compaction is falsely flagged as
  // recalled afterwards). CC's exact summary-entry shape could NOT be confirmed
  // against a live transcript (no compaction had occurred), so harvest
  // DEFENSIVELY across plausible shapes. Additive only: never affects the
  // user/assistant paths above.
  if (typeof e.summary === "string" && e.summary) return e.summary;
  if (role === "summary" || role === "compactionSummary" || role === "branchSummary") {
    return contentToText(e.summary ?? e.message?.content);
  }
  return "";
}

/** Build the provenance corpus from the whole transcript, defensively. */
function corpusFromTranscript(transcriptPath: string | undefined): Corpus {
  const corpus = newCorpus();
  if (!transcriptPath) return corpus;
  let raw = "";
  try {
    raw = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return corpus; // no transcript yet -> empty corpus (best-effort)
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // skip a malformed line rather than abort the whole scan
    }
    const text = provenanceFromEntry(entry);
    if (text) absorb(corpus, text);
  }
  return corpus;
}

// -- the just-written payload -----------------------------------------------

/** (target path, added text) for a Write/Edit/MultiEdit tool_input, or null. */
function payloadFor(
  tool: string | undefined,
  input: Record<string, unknown>,
): { target: string; text: string } | null {
  if (tool === "Write") {
    const target = String(input.file_path ?? "");
    return target ? { target, text: String(input.content ?? "") } : null;
  }
  if (tool === "Edit") {
    const target = String(input.file_path ?? "");
    return target ? { target, text: String(input.new_string ?? "") } : null;
  }
  if (tool === "MultiEdit") {
    const target = String(input.file_path ?? "");
    if (!target) return null;
    const edits = Array.isArray(input.edits) ? (input.edits as Array<{ new_string?: string }>) : [];
    return { target, text: edits.map((e) => String(e?.new_string ?? "")).join("\n") };
  }
  return null;
}

function annotate(context: string): never {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: context,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

async function main() {
  if (process.env[KILL_SWITCH] === "1") process.exit(0);

  const raw = await Bun.stdin.text();
  let payload: {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    transcript_path?: string;
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // not our concern
  }

  const p = payloadFor(payload.tool_name, payload.tool_input ?? {});
  if (!p) process.exit(0); // not a write-family tool
  if (payloadMode(p.target) === "skip") process.exit(0); // scratch / generated / vendored
  if (!p.text.trim()) process.exit(0);

  const corpus = corpusFromTranscript(payload.transcript_path);
  // Fresh flagged-set per invocation: the hook is stateless across calls, so we
  // report every unprovenanced specific in THIS payload (the corpus dedup is
  // what stops verified literals from firing).
  const res = gateWrite(corpus, p.target, p.text, new Set(), `PostToolUse ${payload.tool_name} -> ${p.target}`);
  if (!res) process.exit(0); // clean: no unprovenanced specifics

  annotate(res.reason);
}

await main();
