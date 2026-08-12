/**
 * Smoke test for the skill-guard PreToolUse hook. Spawns the hook as a real
 * subprocess and pipes sample PreToolUse payloads to stdin, asserting the
 * additionalContext (nudge) / no-op (allow) contract - no `claude` binary
 * needed.
 *
 *   bun test .claude/hooks/skill-guard.smoke.test.ts
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const hookPath = path.join(import.meta.dir, "skill-guard.ts");

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

describe("skill-guard PreToolUse hook", () => {
  test("nudges a Write to a Dockerfile with the docker skill pointer", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: "services/api/Dockerfile", content: "FROM alpine" },
    });
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("skill-guard[dockerfile_docker]");
    expect(out.hookSpecificOutput.additionalContext).toContain("~/.claude/skills/docker/SKILL.md");
    // non-blocking: no permissionDecision field
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  test("nudges a Bash `flyctl deploy` with the fly skill pointer", async () => {
    const { stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "flyctl deploy --remote-only" },
    });
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain("skill-guard[flyctl_fly]");
    expect(out.hookSpecificOutput.additionalContext).toContain("fly");
  });

  test("allows a plain-source Write (no stdout, exit 0)", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: "src/index.ts", content: "export const x = 1;" },
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("allows a benign Bash `ls` (no stdout)", async () => {
    const { stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });
    expect(stdout.trim()).toBe("");
  });

  test("ignores tools it does not guard (Read a Dockerfile)", async () => {
    const { stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "Dockerfile" },
    });
    expect(stdout.trim()).toBe("");
  });

  test("SKILL_GUARD_OFF=1 disables the guard", async () => {
    const { stdout } = await runHook(
      { tool_name: "Write", tool_input: { file_path: "Dockerfile", content: "x" } },
      { SKILL_GUARD_OFF: "1" },
    );
    expect(stdout.trim()).toBe("");
  });

  test("malformed stdin is a no-op (exit 0, allow)", async () => {
    const proc = Bun.spawn([process.execPath, hookPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write("not json{");
    await proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });
});
