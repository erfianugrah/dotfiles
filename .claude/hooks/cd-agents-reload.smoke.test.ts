/**
 * Smoke test for the cd-agents-reload PreToolUse (Bash) hook. Spawns the hook
 * as a real subprocess and pipes sample PreToolUse payloads to stdin,
 * asserting the additionalContext / no-op contract - no `claude` binary needed.
 *
 *   bun test .claude/hooks/cd-agents-reload.smoke.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const hookPath = path.join(import.meta.dir, "cd-agents-reload.ts");

// A throwaway "startup cwd" with a sibling repo that carries its own AGENTS.md.
let startupCwd: string;
let siblingRepo: string;

beforeAll(() => {
  const root = mkdtempSync(path.join(tmpdir(), "cd-reload-smoke-"));
  startupCwd = path.join(root, "session");
  siblingRepo = path.join(root, "other-repo");
  mkdirSync(startupCwd, { recursive: true });
  mkdirSync(siblingRepo, { recursive: true });
  writeFileSync(
    path.join(siblingRepo, "AGENTS.md"),
    "# Other repo rules\nUse `make deploy`, never raw docker compose.\n",
  );
});

afterAll(() => {
  try {
    rmSync(path.dirname(startupCwd), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

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

describe("cd-agents-reload PreToolUse hook", () => {
  test("injects the sibling repo's AGENTS.md as additionalContext on cd", async () => {
    const { code, stdout } = await runHook({
      session_id: `sess-${Date.now()}-a`,
      cwd: startupCwd,
      tool_name: "Bash",
      tool_input: { command: `cd ${siblingRepo} && make deploy` },
    });
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("Other repo rules");
    expect(out.hookSpecificOutput.additionalContext).toContain("make deploy");
    // no permissionDecision - this hook injects, it does not block
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  test("fires once per target dir per session (second cd -> no output)", async () => {
    const session_id = `sess-${Date.now()}-once`;
    const first = await runHook({
      session_id,
      cwd: startupCwd,
      tool_name: "Bash",
      tool_input: { command: `cd ${siblingRepo} && ls` },
    });
    expect(JSON.parse(first.stdout).hookSpecificOutput.additionalContext).toContain("Other repo rules");

    const second = await runHook({
      session_id,
      cwd: startupCwd,
      tool_name: "Bash",
      tool_input: { command: `cd ${siblingRepo} && ls` },
    });
    expect(second.stdout.trim()).toBe(""); // already warned this session
  });

  test("no cd -> no output (allowed)", async () => {
    const { stdout } = await runHook({
      session_id: `sess-${Date.now()}-b`,
      cwd: startupCwd,
      tool_name: "Bash",
      tool_input: { command: "docker compose up -d" },
    });
    expect(stdout.trim()).toBe("");
  });

  test("cd into a dir with no AGENTS.md/CLAUDE.md -> no output", async () => {
    const { stdout } = await runHook({
      session_id: `sess-${Date.now()}-c`,
      cwd: startupCwd,
      tool_name: "Bash",
      tool_input: { command: `cd ${path.dirname(startupCwd)} && ls` },
    });
    expect(stdout.trim()).toBe("");
  });

  test("non-Bash tool -> no output", async () => {
    const { stdout } = await runHook({
      session_id: `sess-${Date.now()}-d`,
      cwd: startupCwd,
      tool_name: "Read",
      tool_input: { file_path: `${siblingRepo}/AGENTS.md` },
    });
    expect(stdout.trim()).toBe("");
  });

  test("CD_AGENTS_RELOAD_OFF=1 disables the guard", async () => {
    const { stdout } = await runHook(
      {
        session_id: `sess-${Date.now()}-off`,
        cwd: startupCwd,
        tool_name: "Bash",
        tool_input: { command: `cd ${siblingRepo} && ls` },
      },
      { CD_AGENTS_RELOAD_OFF: "1" },
    );
    expect(stdout.trim()).toBe("");
  });

  test("PI_NO_CD_AGENTS_RELOAD=1 also disables the guard (pi-parity name)", async () => {
    const { stdout } = await runHook(
      {
        session_id: `sess-${Date.now()}-pioff`,
        cwd: startupCwd,
        tool_name: "Bash",
        tool_input: { command: `cd ${siblingRepo} && ls` },
      },
      { PI_NO_CD_AGENTS_RELOAD: "1" },
    );
    expect(stdout.trim()).toBe("");
  });
});
