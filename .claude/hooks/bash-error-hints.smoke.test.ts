/**
 * Smoke test for the bash-error-hints PostToolUse hook. Spawns the hook as a
 * real subprocess and pipes sample PostToolUse payloads to stdin, asserting
 * the additionalContext annotation contract - no `claude` binary needed.
 *
 *   bun test .claude/hooks/bash-error-hints.smoke.test.ts
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const hookPath = path.join(import.meta.dir, "bash-error-hints.ts");

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

describe("bash-error-hints PostToolUse hook", () => {
  test("annotates a Bash result whose stderr matches a footgun pattern", async () => {
    const { code, stdout } = await runHook({
      session_id: "smoke-1",
      tool_name: "Bash",
      tool_input: { command: "git mv notes/plan.md notes/PLAN.md" },
      tool_response: {
        stdout: "",
        stderr: "fatal: not under version control, source=notes/plan.md, destination=notes/PLAN.md",
      },
    });
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("notes/plan.md");
    expect(out.hookSpecificOutput.additionalContext).toContain("git check-ignore");
  });

  test("emits nothing for clean Bash output (exit 0, empty stdout)", async () => {
    const { code, stdout } = await runHook({
      session_id: "smoke-2",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      tool_response: { stdout: "hi\n", stderr: "" },
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("ignores non-Bash tools", async () => {
    const { stdout } = await runHook({
      session_id: "smoke-3",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/x", content: "fatal: not a git repository" },
      tool_response: { filePath: "/tmp/x" },
    });
    expect(stdout.trim()).toBe("");
  });

  test("handles a string tool_response body", async () => {
    const { stdout } = await runHook({
      session_id: "smoke-4",
      tool_name: "Bash",
      tool_input: { command: "foo" },
      tool_response: "bash: foo: command not found",
    });
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain("isn't in PATH");
  });

  test("oncePerSession routing hint fires once, then is suppressed for the same session_id", async () => {
    // Unique per run: the hook persists a fired-set keyed by session_id to a
    // tmp dir, so a fixed id would be pre-suppressed on the second test run.
    const payload = {
      session_id: `smoke-once-${process.pid}-${Date.now()}`,
      tool_name: "Bash",
      tool_input: { command: "cat session" },
      tool_response: { stdout: "/Users/erfi/.pi/agent/sessions/a.jsonl", stderr: "" },
    };
    const first = await runHook(payload);
    expect(JSON.parse(first.stdout).hookSpecificOutput.additionalContext).toContain("session_search");
    const second = await runHook(payload);
    expect(second.stdout.trim()).toBe("");
  });

  test("BASH_ERROR_HINTS_OFF=1 disables the hook", async () => {
    const { stdout } = await runHook(
      {
        session_id: "smoke-off",
        tool_name: "Bash",
        tool_input: { command: "x" },
        tool_response: { stdout: "", stderr: "fatal: not a git repository" },
      },
      { BASH_ERROR_HINTS_OFF: "1" },
    );
    expect(stdout.trim()).toBe("");
  });
});

// regression (code-review): command-only hint patterns must fire in CC even
// when stdout/stderr don't contain the trigger (pi relied on the command echo).
test("command-only hint (git author override) fires with clean stdout", async () => {
  const { stdout } = await runHook({
    tool_name: "Bash",
    session_id: `cmd-hint-${process.pid}-${Date.now()}`,
    tool_input: { command: "git -c user.email=x@y commit -m z" },
    tool_response: { stdout: "[main abc] z", stderr: "" },
  });
  expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toMatch(/author|committer|user\.email/i);
});
