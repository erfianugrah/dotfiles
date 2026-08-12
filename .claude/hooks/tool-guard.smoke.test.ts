/**
 * Smoke test for the tool-guard PreToolUse hook. Spawns the hook as a real
 * subprocess and pipes sample PreToolUse payloads to stdin, asserting the
 * deny/allow contract - no `claude` binary needed.
 *
 *   bun test .claude/hooks/tool-guard.smoke.test.ts
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const hookPath = path.join(import.meta.dir, "tool-guard.ts");

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

describe("tool-guard PreToolUse hook", () => {
  test("denies a Bash `ls /docs/...` and names the docs_* tools", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "ls /docs/postgres" },
    });
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("ls_docs");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("docs_");
  });

  test("denies a Bash `npm install` (bun-default project)", async () => {
    const { stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "npm install left-pad" },
    });
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("npm_when_bun");
  });

  test("catches an anti-pattern hidden behind && chaining", async () => {
    const { stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "cd /repo && grep -r needle ." },
    });
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("allows a clean Bash command (no stdout, exit 0)", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "bun test" },
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("denies a WebFetch on docs.erfi.io and maps to /docs path", async () => {
    const { stdout } = await runHook({
      tool_name: "WebFetch",
      tool_input: { url: "https://docs.erfi.io/postgres/tuning" },
    });
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("/docs/postgres/tuning");
  });

  test("allows a WebFetch on a non-docs host", async () => {
    const { stdout } = await runHook({
      tool_name: "WebFetch",
      tool_input: { url: "https://example.com/x" },
    });
    expect(stdout.trim()).toBe("");
  });

  test("allows a Read call untouched", async () => {
    const { stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/repo/src/index.ts" },
    });
    expect(stdout.trim()).toBe("");
  });

  test("TOOL_GUARD_OFF=1 disables the guard", async () => {
    const { stdout } = await runHook(
      { tool_name: "Bash", tool_input: { command: "ls /docs/x" } },
      { TOOL_GUARD_OFF: "1" },
    );
    expect(stdout.trim()).toBe("");
  });
});
