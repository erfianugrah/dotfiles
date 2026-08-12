/**
 * Smoke test for the ascii-guard PreToolUse hook. Spawns the hook as a real
 * subprocess and pipes sample PreToolUse payloads to stdin, asserting the
 * deny/allow contract - no `claude` binary needed.
 *
 *   bun test .claude/hooks/ascii-guard.smoke.test.ts
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const hookPath = path.join(import.meta.dir, "ascii-guard.ts");

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

describe("ascii-guard PreToolUse hook", () => {
  test("denies a Write containing an em dash and returns the ASCII-folded form", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: "/tmp/x.md", content: "title — body" },
    });
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("em dash");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("title - body");
  });

  test("allows clean-ASCII Write (no stdout, exit 0)", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: "/tmp/x.md", content: "clean ascii - nothing to fix" },
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("denies a Bash commit with a smart quote, ignores a plain-print bash", async () => {
    const bad = await runHook({
      tool_name: "Bash",
      tool_input: { command: "git commit -m “fix”" },
    });
    expect(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecision).toBe("deny");

    const benign = await runHook({
      tool_name: "Bash",
      tool_input: { command: "echo “just printing”" },
    });
    expect(benign.stdout.trim()).toBe(""); // not a WRITE_BASH command -> allowed
  });

  const EM = "\u2014"; // em dash - escaped so this repo's own ascii-guard permits the test file

  test("ASCII_GUARD_OFF=1 disables the guard", async () => {
    const { stdout } = await runHook(
      { tool_name: "Write", tool_input: { file_path: "a.md", content: `x ${EM} y` } },
      { ASCII_GUARD_OFF: "1" },
    );
    expect(stdout.trim()).toBe("");
  });

  test("PI_ASCII_GUARD_OFF=1 also disables the guard (the name the deny reason advertises)", async () => {
    const { stdout } = await runHook(
      { tool_name: "Write", tool_input: { file_path: "a.md", content: `x ${EM} y` } },
      { PI_ASCII_GUARD_OFF: "1" },
    );
    expect(stdout.trim()).toBe("");
  });

  test("PI_ASCII_GUARD_SCOPE=prose lets code files pass but still denies prose", async () => {
    const env = { PI_ASCII_GUARD_SCOPE: "prose" };
    const code = await runHook(
      { tool_name: "Write", tool_input: { file_path: "/tmp/x.ts", content: `const s = "x ${EM} y";` } },
      env,
    );
    expect(code.stdout.trim()).toBe("");
    const prose = await runHook(
      { tool_name: "Write", tool_input: { file_path: "/tmp/x.md", content: `x ${EM} y` } },
      env,
    );
    expect(JSON.parse(prose.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
