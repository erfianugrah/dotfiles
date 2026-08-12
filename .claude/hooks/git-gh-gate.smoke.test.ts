/**
 * Smoke test for the git-gh-gate PreToolUse hook. Spawns the hook as a real
 * subprocess and pipes sample PreToolUse payloads to stdin, asserting the
 * deny/allow contract - no `claude` binary needed.
 *
 *   bun test .claude/hooks/git-gh-gate.smoke.test.ts
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const hookPath = path.join(import.meta.dir, "git-gh-gate.ts");

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

describe("git-gh-gate PreToolUse hook", () => {
  test("denies a mutating Bash git command and explains why", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'wip'" },
    });
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("Mutating git/gh command");
  });

  test("denies a mutating gh command", async () => {
    const { stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 12" },
    });
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("denies commit hidden after a cd in a compound command", async () => {
    const { stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "cd /repo && git push origin main" },
    });
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("allows a read-only git command (no stdout, exit 0)", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "git status" },
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("denies a Write to .git internals", async () => {
    const { stdout } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: "/repo/.git/config", content: "x" },
    });
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(".git internals");
  });

  test("allows a Write to a normal file", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: "/repo/src/index.ts", content: "x" },
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("GIT_GH_GATE_OFF=1 disables the guard", async () => {
    const { stdout } = await runHook(
      { tool_name: "Bash", tool_input: { command: "git push --force" } },
      { GIT_GH_GATE_OFF: "1" },
    );
    expect(stdout.trim()).toBe("");
  });
});
