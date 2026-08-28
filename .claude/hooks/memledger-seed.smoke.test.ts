/**
 * Smoke test for the memledger-seed Stop hook. Spawns the hook as a real
 * subprocess, pipes a sample Stop payload to stdin, and asserts the exit-0
 * no-stdout contract plus the spawned `memledger sync --file ... --file-source
 * claude` args - via a FAKE memledger binary (no real sync, no DB).
 *
 *   bun test .claude/hooks/memledger-seed.smoke.test.ts
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const hookPath = path.join(import.meta.dir, "memledger-seed.ts");

function payload(id: string): unknown {
  return {
    session_id: id,
    transcript_path: "/tmp/t.jsonl",
    stop_hook_active: false,
    hook_event_name: "Stop",
  };
}

function fakeHome(t: { tmp: string }): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccseed-home-"));
  t.tmp = home;
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  const fakeBin = path.join(home, "bin", "memledger");
  fs.writeFileSync(
    fakeBin,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "$MEMLEDGER_FAKE_LOG"\n`,
    { mode: 0o755 },
  );
  return home;
}

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

async function waitFor(path: string, ms = 2000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      return fs.readFileSync(path, "utf8");
    } catch {
      await Bun.sleep(50);
    }
  }
  return "";
}

describe("memledger-seed Stop hook", () => {
  test("spawns memledger sync --file <transcript> --file-source claude", async () => {
    const ctx: { tmp: string } = { tmp: "" };
    const home = fakeHome(ctx);
    const log = path.join(ctx.tmp, "args.log");
    const { code, stdout } = await runHook(payload("s-seed-1"), {
      HOME: home,
      MEMLEDGER_FAKE_LOG: log,
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");

    const args = await waitFor(log);
    expect(args.trim().split("\n")).toEqual([
      "sync",
      "--file",
      "/tmp/t.jsonl",
      "--file-source",
      "claude",
    ]);
  });

  test("throttles: second fire within window does not re-spawn", async () => {
    const ctx: { tmp: string } = { tmp: "" };
    const home = fakeHome(ctx);
    const log = path.join(ctx.tmp, "args.log");
    const env = { HOME: home, MEMLEDGER_FAKE_LOG: log };

    await runHook(payload("s-seed-2"), env);
    const first = await waitFor(log);
    expect(first.trim()).toContain("claude");

    // Clear the log; a second immediate fire must be throttled away.
    fs.writeFileSync(log, "");
    await runHook(payload("s-seed-2"), env);
    await Bun.sleep(200);
    expect(fs.readFileSync(log, "utf8")).toBe("");
  });

  test("MEMLEDGER_SEED_OFF=1 short-circuits with no output", async () => {
    const { code, stdout } = await runHook(payload("s-seed-3"), {
      MEMLEDGER_SEED_OFF: "1",
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  test("non-jsonl transcript path is skipped", async () => {
    const ctx: { tmp: string } = { tmp: "" };
    const home = fakeHome(ctx);
    const log = path.join(ctx.tmp, "args.log");
    const { code, stdout } = await runHook(
      { session_id: "s2", transcript_path: "/tmp/not-a-transcript.txt" },
      { HOME: home, MEMLEDGER_FAKE_LOG: log },
    );
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(fs.existsSync(log)).toBe(false);
  });

  test("empty/malformed stdin exits clean", async () => {
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
});
