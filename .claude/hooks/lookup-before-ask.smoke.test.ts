/**
 * Smoke test for the lookup-before-ask PreToolUse hook. Spawns the hook as a
 * real subprocess and pipes sample AskUserQuestion payloads to stdin,
 * asserting the advisory additionalContext contract - no `claude` binary needed.
 *
 *   bun test .claude/hooks/lookup-before-ask.smoke.test.ts
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const hookPath = path.join(import.meta.dir, "lookup-before-ask.ts");

async function runHook(
  payload: unknown,
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn([process.execPath, hookPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(env ?? {}) },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, stdout };
}

describe("lookup-before-ask PreToolUse hook", () => {
  test("nudges when the agent asks the user for an own-infra fact", async () => {
    const { code, stdout } = await runHook({
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Can you run iperf again and paste the throughput numbers?",
            header: "throughput",
            options: [{ label: "under 5 Gbps" }, { label: "5-10 Gbps" }],
          },
        ],
      },
    });
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("lookup-before-ask");
    // Advisory only: it must NOT deny (a deny would strand the ask).
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  test("stays silent on a preference/design question (no stdout)", async () => {
    const { code, stdout } = await runHook({
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Do you want Option A or Option B?" }] },
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("ignores non-AskUserQuestion tools", async () => {
    const { stdout } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: "/tmp/x", content: "how long is that run?" },
    });
    expect(stdout.trim()).toBe("");
  });

  test("LOOKUP_NUDGE_OFF=1 disables the nudge", async () => {
    const { stdout } = await runHook(
      {
        tool_name: "AskUserQuestion",
        tool_input: { questions: [{ question: "Paste that cable run's iperf numbers?" }] },
      },
      { LOOKUP_NUDGE_OFF: "1" },
    );
    expect(stdout.trim()).toBe("");
  });

  test("PI_LOOKUP_NUDGE_OFF=1 also disables the nudge (pi-parity name)", async () => {
    const { stdout } = await runHook(
      {
        tool_name: "AskUserQuestion",
        tool_input: { questions: [{ question: "Paste that cable run's iperf numbers?" }] },
      },
      { PI_LOOKUP_NUDGE_OFF: "1" },
    );
    expect(stdout.trim()).toBe("");
  });
});
