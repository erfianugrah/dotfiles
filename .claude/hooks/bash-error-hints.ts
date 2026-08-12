#!/usr/bin/env bun
/**
 * bash-error-hints - Claude Code PostToolUse hook (matcher: Bash). Reads the
 * completed Bash tool result, scans the combined stdout+stderr for known
 * footgun patterns, and if any fire, injects the rendered one-line hints as
 * additionalContext so the model sees the next-probe pointer on the next turn.
 *
 * Shares .pi/agent/extensions/lib/bash-error-hints-core.ts with the pi adapter
 * (bash-error-hints.ts) - one pattern table, two harnesses. The core is
 * zero-dependency, so this runs identically from the repo checkout or the
 * stowed ~/.claude/hooks/ symlink (no node_modules needed).
 *
 * PostToolUse additionalContext is used (not the pi tool_result mutation) -
 * CC hooks cannot rewrite a completed tool result, but additionalContext is
 * the documented, guaranteed channel for appending model-visible text after a
 * tool runs. The original stderr is untouched; the hint is purely additive.
 *
 * oncePerSession policy: PostToolUse fires one subprocess per Bash call with no
 * cross-invocation memory, so we cannot dedupe routing hints across a session
 * from here. We keep a best-effort per-session fired-set on disk keyed by
 * CC's session_id (payload.session_id) so the session-jsonl routing hint stays
 * fire-once. If session_id is absent we fall back to emitting every match.
 *
 * Kill switch: BASH_ERROR_HINTS_OFF=1 (parallels pi's convention).
 */

import { tmpdir } from "node:os";
import * as path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  type HintMatch,
  applyOncePerSession,
  extractText,
  matchHintsDetailed,
} from "../../.pi/agent/extensions/lib/bash-error-hints-core.ts";

function emit(context: string): never {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: context,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

/**
 * CC's PostToolUse payload carries the finished result under tool_response
 * (shape varies by tool). Bash's result is typically { stdout, stderr,
 * interrupted, ... } or a string; be defensive and pull every stringy field.
 */
function bashOutputText(payload: Record<string, unknown>): string {
  const resp = payload.tool_response ?? payload.tool_result ?? payload.result;
  if (typeof resp === "string") return resp;
  if (resp && typeof resp === "object") {
    const r = resp as Record<string, unknown>;
    // Prefer explicit stdout/stderr; fall back to the generic content extractor.
    const parts: string[] = [];
    if (typeof r.stdout === "string") parts.push(r.stdout);
    if (typeof r.stderr === "string") parts.push(r.stderr);
    if (parts.length) return parts.join("\n");
    if ("content" in r) return extractText(r.content);
  }
  // Some payloads may surface the merged output at the top level.
  if (typeof payload.output === "string") return payload.output;
  return extractText(resp);
}

// Best-effort on-disk fired-set for oncePerSession dedupe across invocations.
function firedSetFor(sessionId: string | undefined): { set: Set<string>; save: (keys: string[]) => void } {
  if (!sessionId) return { set: new Set(), save: () => {} };
  const dir = path.join(tmpdir(), "cc-bash-error-hints");
  const file = path.join(dir, `${sessionId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  let set = new Set<string>();
  try {
    if (existsSync(file)) {
      const arr = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(arr)) set = new Set(arr.map(String));
    }
  } catch { /* ignore corrupt state */ }
  const save = (keys: string[]) => {
    if (keys.length === 0) return;
    try {
      mkdirSync(dir, { recursive: true });
      for (const k of keys) set.add(k);
      writeFileSync(file, JSON.stringify([...set]));
    } catch { /* ignore */ }
  };
  return { set, save };
}

async function main() {
  if (process.env.BASH_ERROR_HINTS_OFF === "1") process.exit(0);

  const raw = await Bun.stdin.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // not our concern; let the call proceed
  }

  // Only annotate Bash results.
  if (payload.tool_name && payload.tool_name !== "Bash") process.exit(0);

  const text = bashOutputText(payload);
  if (!text) process.exit(0);

  const matches = matchHintsDetailed(text);
  if (matches.length === 0) process.exit(0);

  const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;
  const { set, save } = firedSetFor(sessionId);
  const { kept, newlyFired }: { kept: HintMatch[]; newlyFired: string[] } = applyOncePerSession(matches, set);
  save(newlyFired);
  if (kept.length === 0) process.exit(0);

  emit(kept.map((m) => `• ${m.rendered}`).join("\n"));
}

await main();
