#!/usr/bin/env bun
/**
 * epistemic-guard - Claude Code PreToolUse hook. Before a Write/Edit/MultiEdit
 * lands, it checks the SPECIFICS the payload is about to emit (versions, urls,
 * cves, perf numbers, flags, syspaths, dates, prices, entities) against a
 * PROVENANCE CORPUS built from the session transcript. A specific that appears
 * in the payload but in NO tool result / bash output / user message is, by
 * construction, recalled from training - unverified - and the tool call is
 * DENIED with the per-class verify hint so the model verifies, labels, or
 * drops it and retries.
 *
 * Why PreToolUse (deny) rather than PostToolUse (annotate):
 *   CC's PreToolUse can hard-block a tool call; PostToolUse can only annotate
 *   after the fact. The pi guard blocks at tool_call time - this restores
 *   parity. The once-per-specific dedup lives in the TRANSCRIPT corpus: after
 *   a deny, the model runs a check (any tool call whose output contains the
 *   literal), the literal enters the corpus on the next invocation, and the
 *   retry passes. A stale claim never lands on disk in the first place.
 *
 * Shares .pi/agent/extensions/lib/epistemic-guard-core.ts with the pi adapter
 * (epistemic-guard.ts) - one claim extractor + corpus + gate, two harnesses.
 * The core is zero-dependency (node:path + node:fs for the entity registry),
 * so this runs identically from the repo checkout or the stowed
 * ~/.claude/hooks/ symlink.
 *
 * Provenance model: CC exposes the session as a JSONL transcript at
 * `transcript_path`. We absorb the text the agent SAW - user messages and
 * tool_result blocks (bash/read/grep output) - and deliberately EXCLUDE
 * assistant text and tool_use inputs, so a hallucination cannot bootstrap
 * itself into "verified". Entry shapes are read defensively: unknown shapes
 * contribute nothing rather than throwing.
 *
 * Kill switch: EPISTEMIC_GUARD_OFF=1 (pi's PI_EPISTEMIC_GUARD_OFF also works;
 * the shared core's block message advertises that name).
 */

import * as fs from "node:fs";
import {
  type Corpus,
  absorb,
  corpusSize,
  gateWrite,
  newCorpus,
  payloadMode,
} from "../../.pi/agent/extensions/lib/epistemic-guard-core.ts";

import { appendFileSync } from "node:fs";

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
  // compaction boundary - harvest defensively across plausible shapes.
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

// -- the about-to-be-written payload ----------------------------------------

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

/** Emit a PreToolUse hard-deny: the tool call never runs, the reason feeds back to the model. */
function deny(reason: string): never {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

async function main() {
  // Honor the pi-named switch too: the shared core's surfaced reason text
  // advertises PI_EPISTEMIC_GUARD_OFF, so that name must actually work here.
  if (process.env[KILL_SWITCH] === "1" || process.env.PI_EPISTEMIC_GUARD_OFF === "1") process.exit(0);

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
  // Fresh flagged-set per invocation: the hook is stateless across calls, so
  // every unprovenanced specific in THIS payload is reported. The corpus
  // dedup (verified literals never re-fire) is the once-per-session analogue.
  const res = gateWrite(corpus, p.target, p.text, new Set(), `PreToolUse ${payload.tool_name} -> ${p.target}`);

  // EPISTEMIC_GUARD_DEBUG=1: append one JSON line per invocation so a session
  // can show WHICH transcript the corpus came from and how big it was. Added
  // 2026-09-05 after eight subagents reported that literals they had just
  // verified with tools were still denied: the hypothesis is that CC hands a
  // subagent hook the PARENT transcript_path (or a not-yet-flushed file), so
  // the subagent's own tool results never enter the corpus. This log is how
  // to confirm or refute that without guessing.
  if (process.env.EPISTEMIC_GUARD_DEBUG === "1") {
    let size = -1;
    try {
      const st = payload.transcript_path ? Bun.file(payload.transcript_path) : undefined;
      size = st ? st.size : -1;
    } catch {}
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      tool: payload.tool_name,
      target: p.target,
      transcript_path: payload.transcript_path,
      transcript_bytes: size,
      corpus_size: corpusSize(corpus),
      denied: Boolean(res),
      pid: process.pid,
    });
    try {
      appendFileSync("/tmp/epistemic-guard.debug.jsonl", line + "\n");
    } catch {}
  }

  if (!res) process.exit(0); // clean: no unprovenanced specifics

  deny(res.reason);
}

await main();
