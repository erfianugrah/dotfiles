/**
 * Smoke test for the ai-tell-guard PreToolUse hook. Spawns the hook as a real
 * subprocess and pipes sample PreToolUse payloads to stdin, asserting the
 * deny/allow contract - no `claude` binary needed.
 *
 *   bun test .claude/hooks/ai-tell-guard.smoke.test.ts
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const hookPath = path.join(import.meta.dir, "ai-tell-guard.ts");

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

describe("ai-tell-guard PreToolUse hook", () => {
  test("denies a prose Write with negative parallelism", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/tmp/post.md",
        content:
          "The bookcase scene is a masterpiece. This is not just a stunt, but a whole practical-effects showcase for the era.",
      },
    });
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("negative_parallelism_not_just");
  });

  test("allows the same sentence quoted as an example (masking)", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/tmp/style-guide.md",
        content: "Never write \"not just a stunt, but a showcase\" - it is the number one AI tell.",
      },
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("allows clean technical prose", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/tmp/guide.md",
        content: "The replication slot retains WAL until the consumer acknowledges. Monitor it with pg_replication_slots.",
      },
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("ignores code files entirely", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/tmp/main.ts",
        content: "// it is not just a cache, but a whole subsystem for reads and invalidation",
      },
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("denies importance-announcing, allows plain 'worth reading'", async () => {
    const bad = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/tmp/notes.md",
        content: "It is worth noting that the pooler drops idle connections after five minutes of inactivity.",
      },
    });
    expect(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecisionReason).toContain(
      "importance_announcing",
    );

    const ok = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/tmp/notes.md",
        content: "The migration guide is worth reading before the window opens on Thursday.",
      },
    });
    expect(ok.stdout.trim()).toBe("");
  });

  test("denies a git commit carrying the aphorism tell, ignores plain bash", async () => {
    const bad = await runHook({
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'No CGI, no extra take. Just a desire to make art.'" },
    });
    expect(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecision).toBe("deny");

    const plain = await runHook({
      tool_name: "Bash",
      tool_input: { command: "rg 'not just' docs/" },
    });
    expect(plain.code).toBe(0);
    expect(plain.stdout.trim()).toBe("");
  });

  test("allows a read-only search whose pattern contains a tell (WRITE_BASH tripped by a redirect)", async () => {
    // 2>/dev/null trips WRITE_BASH, but the tell lives in the SEARCH PATTERN,
    // not in authored prose - the command writes nothing.
    const search = await runHook({
      tool_name: "Bash",
      tool_input: { command: "rg -n 'not just a cache, but a whole subsystem for reads' docs/ 2>/dev/null || echo none" },
    });
    expect(search.code).toBe(0);
    expect(search.stdout.trim()).toBe("");

    // a search that ALSO writes authored prose to a real file is still scanned.
    const alsoWrites = await runHook({
      tool_name: "Bash",
      tool_input: { command: "rg foo docs/ && echo 'This is not just a cache, but a whole subsystem for reads.' > note.md" },
    });
    expect(JSON.parse(alsoWrites.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("kill switch disables the hook", async () => {
    const { code, stdout } = await runHook(
      {
        tool_name: "Write",
        tool_input: { file_path: "/tmp/x.md", content: "This is not just a cache, but a subsystem for reads." },
      },
      { PI_AI_TELL_GUARD_OFF: "1" },
    );
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });
});
