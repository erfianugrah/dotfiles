/**
 * Smoke test for the epistemic-guard PostToolUse hook. Spawns the hook as a
 * real subprocess, writes a transcript JSONL fixture, and pipes a PostToolUse
 * payload to stdin - asserting the annotate/clean contract. No `claude` binary
 * needed.
 *
 *   bun test .claude/hooks/epistemic-guard.smoke.test.ts
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const hookPath = path.join(import.meta.dir, "epistemic-guard.ts");
const tmpFiles: string[] = [];

/** Write a JSONL transcript fixture and return its path. */
function writeTranscript(entries: unknown[]): string {
  const p = path.join(os.tmpdir(), `eg-transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n"));
  tmpFiles.push(p);
  return p;
}

afterAll(() => {
  for (const p of tmpFiles) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
});

async function runHook(
  payload: unknown,
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn([process.execPath, hookPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : process.env,
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, stdout };
}

// A tool_result CC entry carrying bash output that DOES mention 2.8.4.
function toolResultEntry(text: string): unknown {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", content: [{ type: "text", text }] }],
    },
  };
}

describe("epistemic-guard PostToolUse hook", () => {
  test("annotates a Write emitting an unprovenanced version", async () => {
    const transcript = writeTranscript([
      { type: "user", message: { role: "user", content: [{ type: "text", text: "audit the deploy" }] } },
    ]);
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: "/repo/README.md", content: "We deploy Caddy 2.8.4 today." },
      transcript_path: transcript,
    });
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("epistemic-guard");
    expect(out.hookSpecificOutput.additionalContext).toContain("Caddy 2.8.4");
    expect(out.hookSpecificOutput.additionalContext).toContain("PostToolUse Write");
  });

  test("stays silent when the specific has provenance in the transcript", async () => {
    const transcript = writeTranscript([
      toolResultEntry("$ caddy version\nv2.8.4 built with go1.22"),
    ]);
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: "/repo/README.md", content: "We deploy Caddy 2.8.4 today." },
      transcript_path: transcript,
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(""); // literal was seen -> no annotation
  });

  test("assistant text in the transcript is NOT provenance (hallucination cannot self-verify)", async () => {
    const transcript = writeTranscript([
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "It is Caddy 2.8.4" }] } },
    ]);
    const { stdout } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: "/repo/README.md", content: "We deploy Caddy 2.8.4 today." },
      transcript_path: transcript,
    });
    // assistant text does not enter the corpus, so the version is still flagged
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain("2.8.4");
  });

  test("skip target (scratch / lockfile) is never annotated", async () => {
    const transcript = writeTranscript([]);
    const { stdout } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: "/tmp/scratch.md", content: "Caddy 2.8.4" },
      transcript_path: transcript,
    });
    expect(stdout.trim()).toBe("");
  });

  test("non-write tool (Bash) is ignored", async () => {
    const { stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "caddy version" },
      transcript_path: writeTranscript([]),
    });
    expect(stdout.trim()).toBe("");
  });

  test("Edit with a provenanced value passes, unprovenanced flag files", async () => {
    const transcript = writeTranscript([toolResultEntry("only 2.8.4 appears here")]);
    const { stdout } = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: "/repo/docs/guide.md", old_string: "x", new_string: "run with --dns-01 mode" },
      transcript_path: transcript,
    });
    // --dns-01 was never seen -> annotated
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain("--dns-01");
  });

  test("EPISTEMIC_GUARD_OFF=1 disables the guard", async () => {
    const transcript = writeTranscript([]);
    const { stdout } = await runHook(
      {
        tool_name: "Write",
        tool_input: { file_path: "/repo/README.md", content: "Caddy 2.8.4" },
        transcript_path: transcript,
      },
      { EPISTEMIC_GUARD_OFF: "1" },
    );
    expect(stdout.trim()).toBe("");
  });

  test("missing / unreadable transcript_path -> empty corpus, still flags", async () => {
    const { stdout } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: "/repo/README.md", content: "Postgres 17.2 is out." },
      transcript_path: "/nonexistent/path/to/transcript.jsonl",
    });
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain("17.2");
  });
});
