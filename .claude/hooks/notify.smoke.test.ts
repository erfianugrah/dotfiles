/**
 * Smoke test for the notify Stop hook. Spawns the hook as a real subprocess,
 * pipes a sample Stop payload to stdin, and asserts the emitted bytes under
 * different env conditions - no `claude` binary needed.
 *
 *   bun test .claude/hooks/notify.smoke.test.ts
 *
 * Note: the subprocess stdout is a pipe (NOT a TTY), so the default run selects
 * transport "skip" and emits nothing - exactly the JSON-stream-safe contract.
 * Forcing WT_SESSION exercises the toast path (which produces no stdout either,
 * but we assert the hook still exits clean). We can't fake isTTY from here, so
 * the OSC byte shapes are covered by the pure notify-core.test.ts instead.
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const hookPath = path.join(import.meta.dir, "notify.ts");

const STOP_PAYLOAD = {
  session_id: "s1",
  transcript_path: "/tmp/t.jsonl",
  stop_hook_active: false,
  hook_event_name: "Stop",
};

async function runHook(
  payload: unknown,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn([process.execPath, hookPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, stdout };
}

describe("notify Stop hook", () => {
  test("piped (non-TTY) stdout -> skip: no bytes, exit 0", async () => {
    const { code, stdout } = await runHook(STOP_PAYLOAD);
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  test("empty stdin still exits clean (Stop payload is optional to us)", async () => {
    const proc = Bun.spawn([process.execPath, hookPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  test("NOTIFY_OFF=1 short-circuits with no output", async () => {
    const { code, stdout } = await runHook(STOP_PAYLOAD, { NOTIFY_OFF: "1" });
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  test("WT_SESSION toast path: no stdout corruption, clean exit", async () => {
    // On non-Windows the powershell.exe spawn just fails silently (execFile is
    // fire-and-forget); the hook must still write nothing to stdout and exit 0.
    const { code, stdout } = await runHook(STOP_PAYLOAD, { WT_SESSION: "smoke" });
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });
});
