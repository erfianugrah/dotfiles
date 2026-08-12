/**
 * Smoke test for the entity-qualifier-nudge PreToolUse hook. Spawns the hook as
 * a real subprocess and pipes sample PreToolUse payloads to stdin, asserting the
 * additionalContext / silent contract - no `claude` binary needed.
 *
 *   bun test .claude/hooks/entity-qualifier-nudge.smoke.test.ts
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const hookPath = path.join(import.meta.dir, "entity-qualifier-nudge.ts");

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

describe("entity-qualifier-nudge PreToolUse hook", () => {
  test("injects additionalContext when a Write cites a bare device id as evidence", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/tmp/note.md",
        content: "you had eth0 flap and downshift events on 2026-08-08, so we need better cabling",
      },
    });
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("entity-qualifier-nudge");
    expect(out.hookSpecificOutput.additionalContext).toContain("host qualifier");
    // Crucially it does NOT deny - advisory only.
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  test("stays silent when the host is named (possessive)", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/tmp/note.md",
        content: "servarr's eth0 flapped last week during the outage",
      },
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("stays silent when the interface is merely named, not cited as evidence", async () => {
    const { stdout } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: "/tmp/net.conf", content: "bind the bridge to br0 and set the MTU" },
    });
    expect(stdout.trim()).toBe("");
  });

  test("fires on Edit new_string too", async () => {
    const { stdout } = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: "/tmp/note.md",
        old_string: "x",
        new_string: "nvme0n1 threw errors during the outage last week",
      },
    });
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain(
      "entity-qualifier-nudge",
    );
  });

  test("fires on MultiEdit across the joined new_strings", async () => {
    const { stdout } = await runHook({
      tool_name: "MultiEdit",
      tool_input: {
        file_path: "/tmp/note.md",
        edits: [
          { old_string: "a", new_string: "harmless config line" },
          { old_string: "b", new_string: "we saw br0 drop packets in the incident" },
        ],
      },
    });
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain(
      "entity-qualifier-nudge",
    );
  });

  test("ENTITY_NUDGE_OFF=1 disables the guard", async () => {
    const { stdout } = await runHook(
      {
        tool_name: "Write",
        tool_input: { file_path: "/tmp/note.md", content: "eth0 flap on 2026-08-08" },
      },
      { ENTITY_NUDGE_OFF: "1" },
    );
    expect(stdout.trim()).toBe("");
  });

  test("non-target tool is ignored", async () => {
    const { stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "echo eth0 flapped last week" },
    });
    expect(stdout.trim()).toBe("");
  });
});
