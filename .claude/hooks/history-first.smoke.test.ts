/**
 * Smoke test for the history-first UserPromptSubmit hook. Spawns the hook as
 * a real subprocess and pipes sample payloads, asserting the advisory
 * additionalContext contract. No `claude` binary needed.
 *
 *   bun test .claude/hooks/history-first.smoke.test.ts
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const hookPath = path.join(import.meta.dir, "history-first.ts");

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

function tmpTranscript(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hf-cc-"));
  const file = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
  return file;
}

const TASK_PROMPT =
  "fix the parse error in crypto.zsh line 445 - zsh reports parse error near )";

describe("history-first UserPromptSubmit hook", () => {
  test("nudges on a substantive first prompt (no transcript yet)", async () => {
    const { code, stdout } = await runHook({ prompt: TASK_PROMPT });
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toContain("history-first");
  });

  test("stays silent on a trivial control prompt", async () => {
    const { code, stdout } = await runHook({ prompt: "y" });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("disarms when the transcript already shows a lookup tool call", async () => {
    const tp = tmpTranscript([
      { type: "user", message: { role: "user", content: TASK_PROMPT } },
      {
        type: "assistant",
        message: { role: "assistant", content: "searching" },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_use",
              name: "mcp__erfi-toolkit__search_messages",
              input: { q: "crypto.zsh parse error" },
            },
          ],
        },
      },
    ]);
    const { stdout } = await runHook({ prompt: "continue with the fix", transcript_path: tp });
    expect(stdout.trim()).toBe("");
  });

  test("bare tool name from a differently-named MCP server also disarms", async () => {
    const tp = tmpTranscript([
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_use", name: "search_ledger", input: { q: "x" } }],
        },
      },
    ]);
    const { stdout } = await runHook({ prompt: TASK_PROMPT, transcript_path: tp });
    expect(stdout.trim()).toBe("");
  });

  test("caps at MAX_FIRES turns without a lookup", async () => {
    // 3 prior user turns, no lookup: turn 4 exceeds the cap of 3.
    const tp = tmpTranscript([
      { type: "user", message: { role: "user", content: "first task prompt here long enough" } },
      { type: "user", message: { role: "user", content: "second task prompt here long enough" } },
      { type: "user", message: { role: "user", content: "third task prompt here long enough" } },
    ]);
    const { stdout } = await runHook({ prompt: TASK_PROMPT, transcript_path: tp });
    expect(stdout.trim()).toBe("");
  });

  test("tool_result blocks in user-role messages do not count as turns", async () => {
    const tp = tmpTranscript([
      { type: "user", message: { role: "user", content: "first task prompt here long enough" } },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "x", content: "grep output" },
          ],
        },
      },
    ]);
    // 1 real user turn -> this prompt is turn 2, still under the cap of 3.
    const { stdout } = await runHook({ prompt: TASK_PROMPT, transcript_path: tp });
    expect(JSON.parse(stdout).hookSpecificOutput).toBeDefined();
  });

  test("HISTORY_FIRST_OFF=1 disables the hook", async () => {
    const { stdout } = await runHook(
      { prompt: TASK_PROMPT },
      { HISTORY_FIRST_OFF: "1" },
    );
    expect(stdout.trim()).toBe("");
  });

  test("PI_HISTORY_FIRST_OFF=1 also disables (pi-parity name)", async () => {
    const { stdout } = await runHook(
      { prompt: TASK_PROMPT },
      { PI_HISTORY_FIRST_OFF: "1" },
    );
    expect(stdout.trim()).toBe("");
  });

  test("malformed stdin is a clean no-op", async () => {
    const proc = Bun.spawn([process.execPath, hookPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    proc.stdin.write("not json at all");
    await proc.stdin.end();
    await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
  });
});
