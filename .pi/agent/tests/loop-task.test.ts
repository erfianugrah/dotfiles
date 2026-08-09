/**
 * Loop sensor tests - task.ts subagent progress streaming.
 *
 * THE CONTRACT for the self-correcting loop. Red at baseline, must go green
 * without editing this file.
 *
 * Required exports from ../extensions/task.ts:
 *   - parseSubagentEventLine(line): parsed JSON event object, or null on
 *     garbage/blank input. Must not throw.
 *   - createTaskProgress(description, now?): a tracker with:
 *       observeEvent(ev): void       - consume one parsed event
 *       statusLine(): string         - one-line live status (see assertions)
 *       finalText(): string          - last assistant text (mirrors the
 *                                      pre-existing close-time parse rules)
 *       sessionId: string | undefined
 *     `now` is an injectable clock (ms) defaulting to Date.now.
 *   - taskTool: the defineTool(...) object (defineTool is identity-stubbed
 *     by preload.ts), so tests can drive execute() directly.
 *
 * statusLine format (asserted via toContain, implementation has layout
 * freedom):
 *   task "<description>" ... <elapsed "1m05s"> ... <N> tools ... last: <label>
 * plus, when a nested task tool reports progress via tool_execution_update,
 * a " |-> <nested line>" suffix.
 *
 * execute() behavioral contract:
 *   - calls onUpdate with { content: [{ type: "text", text: <statusLine> }] }
 *     as subagent events arrive: first update promptly, subsequent updates
 *     throttled to >=1s apart, plus a final flush if updates were suppressed.
 *   - aborting the passed AbortSignal kills the subprocess and resolves
 *     promptly (a sleeping fake `pi` must not hang execute()).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSubagentEventLine,
  createTaskProgress,
  taskTool,
} from "../extensions/task.ts";

describe("parseSubagentEventLine", () => {
  test("parses a valid JSONL event", () => {
    const ev = parseSubagentEventLine('{"type":"session","id":"s1"}') as {
      type: string;
      id: string;
    };
    expect(ev.type).toBe("session");
    expect(ev.id).toBe("s1");
  });

  test("returns null on garbage, blank, and non-object lines", () => {
    expect(parseSubagentEventLine("not json")).toBeNull();
    expect(parseSubagentEventLine("")).toBeNull();
    expect(parseSubagentEventLine("   ")).toBeNull();
    expect(parseSubagentEventLine("{broken")).toBeNull();
  });
});

describe("createTaskProgress", () => {
  test("status line shows description, zero state at start", () => {
    let now = 1_000;
    const t = createTaskProgress("research caddy", () => now);
    const line = t.statusLine();
    expect(line).toContain('task "research caddy"');
    expect(line).toContain("0 tools");
  });

  test("captures session id", () => {
    const t = createTaskProgress("d", () => 0);
    t.observeEvent({ type: "session", id: "abc-123" });
    expect(t.sessionId).toBe("abc-123");
  });

  test("tracks tool count and last tool label", () => {
    let now = 0;
    const t = createTaskProgress("d", () => now);
    t.observeEvent({
      type: "tool_execution_start",
      toolCallId: "1",
      toolName: "webfetch",
      args: { url: "https://example.com/x" },
    });
    t.observeEvent({
      type: "tool_execution_start",
      toolCallId: "2",
      toolName: "bash",
      args: { command: "ls -la" },
    });
    const line = t.statusLine();
    expect(line).toContain("2 tools");
    expect(line).toContain("bash");
    expect(line).toContain("ls -la");
  });

  test("elapsed time renders as m:ss once past a minute", () => {
    let now = 1_000;
    const t = createTaskProgress("d", () => now);
    now += 65_000;
    expect(t.statusLine()).toContain("1m05s");
  });

  test("relays nested task progress from tool_execution_update", () => {
    const t = createTaskProgress("outer", () => 0);
    t.observeEvent({
      type: "tool_execution_update",
      toolCallId: "9",
      toolName: "task",
      args: { description: "inner" },
      partialResult: {
        content: [
          { type: "text", text: 'task "inner" · 2m00s · 1 tools · last: bash ls' },
        ],
      },
    });
    const line = t.statusLine();
    expect(line).toContain("|->");
    expect(line).toContain("inner");
  });

  test("finalText: last assistant text wins across event kinds", () => {
    const t = createTaskProgress("d", () => 0);
    t.observeEvent({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "first" }] },
    });
    t.observeEvent({
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "second" }] },
    });
    expect(t.finalText()).toBe("second");
    t.observeEvent({
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "ignored" }] },
        { role: "assistant", content: [{ type: "text", text: "third" }] },
      ],
    });
    expect(t.finalText()).toBe("third");
  });

  test("ignores unknown and malformed events without throwing", () => {
    const t = createTaskProgress("d", () => 0);
    t.observeEvent(null);
    t.observeEvent({ type: "mystery" });
    t.observeEvent({ type: "message_end", message: { role: "user" } });
    expect(t.finalText()).toBe("");
    expect(t.statusLine()).toContain('task "d"');
  });
});

// ---------------------------------------------------------------------------
// Integration: drive taskTool.execute() against a fake `pi` on PATH.
// ---------------------------------------------------------------------------

interface OnUpdateCall {
  content?: Array<{ type: string; text?: string }>;
}

function makeFakePi(dir: string, script: string): void {
  const path = join(dir, "pi");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

const origPath = process.env.PATH ?? "";
let tmpDirs: string[] = [];

afterEach(() => {
  process.env.PATH = origPath;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

function withFakePi(script: string): void {
  const dir = mkdtempSync(join(tmpdir(), "loop-task-fakepi-"));
  tmpDirs.push(dir);
  makeFakePi(dir, script);
  process.env.PATH = `${dir}:${origPath}`;
}

const SLOW_SCRIPT = `#!/usr/bin/env bash
echo '{"type":"session","id":"s-int"}'
echo '{"type":"tool_execution_start","toolCallId":"1","toolName":"webfetch","args":{"url":"https://slow.example.com/page"}}'
sleep 1.3
echo '{"type":"tool_execution_start","toolCallId":"2","toolName":"bash","args":{"command":"ls -la"}}'
sleep 1.3
echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"FINAL ANSWER"}]}}'
echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"FINAL ANSWER"}]}]}'
`;

describe("taskTool.execute integration (fake pi)", () => {
  test(
    "streams onUpdate progress and returns final text",
    async () => {
      withFakePi(SLOW_SCRIPT);
      const updates: string[] = [];
      const result = (await taskTool.execute(
        "call-1",
        {
          description: "slow research",
          prompt: "do things",
          subagent_type: "explore",
        },
        undefined,
        (u: OnUpdateCall) => {
          const text = u?.content?.map((c) => c.text ?? "").join("\n") ?? "";
          if (text) updates.push(text);
        },
        {},
      )) as { content: Array<{ type: string; text?: string }> };

      const finalText = result.content.map((c) => c.text ?? "").join("\n");
      expect(finalText).toContain("FINAL ANSWER");
      expect(finalText).toContain("s-int");

      // >=2 streamed updates over a ~2.6s run: first prompt, then throttled.
      expect(updates.length).toBeGreaterThanOrEqual(2);
      const all = updates.join("\n");
      expect(all).toContain("webfetch");
      expect(all).toContain("slow.example.com");
      expect(all).toContain("bash");
    },
    20_000,
  );

  test(
    "abort kills the subprocess and resolves promptly",
    async () => {
      withFakePi(`#!/usr/bin/env bash
echo '{"type":"session","id":"s-abort"}'
sleep 30
`);
      const ac = new AbortController();
      const started = Date.now();
      const promise = taskTool.execute(
        "call-2",
        { description: "hang", prompt: "zzz", subagent_type: "explore" },
        ac.signal,
        () => {},
        {},
      );
      setTimeout(() => ac.abort(), 200);
      await promise; // must resolve, not hang for the child's 30s sleep
      expect(Date.now() - started).toBeLessThan(10_000);
    },
    20_000,
  );
});
