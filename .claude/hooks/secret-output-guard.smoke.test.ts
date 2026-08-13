/**
 * Smoke test for the secret-output-guard CC hook. Spawns the hook as a real
 * subprocess and pipes sample PreToolUse/PostToolUse payloads to stdin,
 * asserting the deny/alarm/allow contract - no `claude` binary needed.
 *
 * Secret fixtures are SYNTHETIC and built by repeat() so no token-looking
 * literal sits in the repo.
 *
 *   bun test .claude/hooks/secret-output-guard.smoke.test.ts
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const hookPath = path.join(import.meta.dir, "secret-output-guard.ts");
const FAKE_KEY = "ck_" + "e5f6a7b8".repeat(8); // synthetic, matches ck_ format

async function runHook(
  payload: unknown,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn([process.execPath, hookPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extraEnv },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, stdout };
}

describe("secret-output-guard PreToolUse (deny env dumps)", () => {
  test("denies `env | grep`", async () => {
    const { code, stdout } = await runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "env | grep -i composer" },
    });
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("env");
  });

  test("denies bare `export -p`", async () => {
    const { stdout } = await runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "export -p" },
    });
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("allows credential USE by var reference", async () => {
    const { code, stdout } = await runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: 'curl -H "X-API-Key: $COMPOSER_API_KEY" https://x.test/api' },
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  test("allows assignment forms and non-Bash tools", async () => {
    for (const payload of [
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "env FOO=1 make build" } },
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "set -euo pipefail" } },
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/tmp/x" } },
    ]) {
      const { code, stdout } = await runHook(payload);
      expect(code).toBe(0);
      expect(stdout).toBe("");
    }
  });
});

describe("secret-output-guard PostToolUse (leak alarm)", () => {
  test("alarms on an env-value leak, naming the var but never the value", async () => {
    const { code, stdout } = await runHook(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo $TEST_SECRET_KEY" },
        tool_response: `the value is ${FAKE_KEY} ok`,
      },
      { TEST_SECRET_KEY: FAKE_KEY },
    );
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("env:TEST_SECRET_KEY");
    expect(ctx).not.toContain(FAKE_KEY);
    expect(ctx).not.toContain(FAKE_KEY.slice(0, 12));
  });

  test("alarms on a token-format leak with no matching env var", async () => {
    const ghp = "ghp_" + "A".repeat(36);
    const { stdout } = await runHook({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/notes.txt" },
      tool_response: `backup key: ${ghp}`,
    });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("format:github-token");
    expect(ctx).not.toContain(ghp);
  });

  test("stays silent on clean output", async () => {
    const { code, stdout } = await runHook({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: "file1.txt\nfile2.txt",
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  test("kill switch disables both halves", async () => {
    for (const payload of [
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "env" } },
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo $TEST_SECRET_KEY" },
        tool_response: FAKE_KEY,
      },
    ]) {
      const { code, stdout } = await runHook(payload, {
        PI_SECRET_GUARD_OFF: "1",
        TEST_SECRET_KEY: FAKE_KEY,
      });
      expect(code).toBe(0);
      expect(stdout).toBe("");
    }
  });
});
