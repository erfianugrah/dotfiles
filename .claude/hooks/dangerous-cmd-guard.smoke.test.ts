/**
 * Smoke test for the dangerous-cmd-guard PreToolUse hook. Spawns the hook as
 * a real subprocess and pipes sample PreToolUse payloads to stdin, asserting
 * the deny/allow contract - no `claude` binary needed.
 *
 *   bun test .claude/hooks/dangerous-cmd-guard.smoke.test.ts
 */

import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import * as path from "node:path";

const hookPath = path.join(import.meta.dir, "dangerous-cmd-guard.ts");
const HOME = homedir();

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

function bashPayload(command: string, cwd = "/tmp") {
  return { tool_name: "Bash", tool_input: { command }, cwd };
}

describe("dangerous-cmd-guard PreToolUse hook", () => {
  test("denies rm -rf on the home directory (critical)", async () => {
    const { code, stdout } = await runHook(bashPayload("rm -rf ~"));
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("rm_home");
  });

  test("denies rm -rf on a real dir under home (confirm tier denies in CC)", async () => {
    const { stdout } = await runHook(bashPayload(`rm -rf ${HOME}/infra/ai`));
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("rm_recursive");
  });

  test("denies dd to a block device", async () => {
    const { stdout } = await runHook(bashPayload("dd if=/dev/zero of=/dev/sda"));
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("allows scratch deletes and ordinary commands", async () => {
    for (const cmd of ["rm -rf /tmp/scratch", "rm -rf ./node_modules", "ls -la", "rm file.txt"]) {
      const { code, stdout } = await runHook(bashPayload(cmd, "/tmp/work"));
      expect(code).toBe(0);
      expect(stdout).toBe("");
    }
  });

  test("ignores non-Bash tools", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: "/x" },
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  test("kill switch DANGEROUS_CMD_GUARD_OFF=1 allows everything", async () => {
    const { code, stdout } = await runHook(bashPayload("rm -rf ~"), {
      DANGEROUS_CMD_GUARD_OFF: "1",
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });
});
