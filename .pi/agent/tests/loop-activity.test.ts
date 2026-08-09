/**
 * Loop sensor tests - tool-activity extension (live working message).
 *
 * THE CONTRACT for the self-correcting loop. Red at baseline, must go green
 * without editing this file.
 *
 * Required exports:
 *   from ../extensions/lib/tool-label.ts:
 *     - summarizeToolArgs(toolName, args): one-line human label for a tool
 *       call. Known tools surface their key arg; unknown tools fall back to
 *       the bare tool name. Long labels truncate to <=63 chars ending "...".
 *     - formatElapsed(ms): "45s" under a minute, "6m12s" under an hour,
 *       "1h01m" at/above an hour.
 *   from ../extensions/tool-activity.ts:
 *     - createToolActivity(now?): tracker with start(id, toolName, args),
 *       end(id), and summaryLine() (null when idle; otherwise names the
 *       longest-running tool with elapsed, plus "+N more" when >1 active).
 *
 * The extension's pi.on wiring (tool_execution_start/end ->
 * ctx.ui.setWorkingMessage, restore on agent_settled/session_shutdown,
 * ctx.hasUI guard) is not unit-tested here; it is covered by the judge
 * sensor and manual TUI verification.
 */

import { describe, expect, test } from "bun:test";

import { summarizeToolArgs, formatElapsed } from "../extensions/lib/tool-label.ts";
import { createToolActivity } from "../extensions/tool-activity.ts";

describe("formatElapsed", () => {
  test("seconds under a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(45_000)).toBe("45s");
    expect(formatElapsed(59_999)).toBe("59s");
  });

  test("minutes and seconds under an hour", () => {
    expect(formatElapsed(60_000)).toBe("1m00s");
    expect(formatElapsed(372_000)).toBe("6m12s");
  });

  test("hours and minutes at/above an hour", () => {
    expect(formatElapsed(3_600_000)).toBe("1h00m");
    expect(formatElapsed(3_660_000)).toBe("1h01m");
  });
});

describe("summarizeToolArgs", () => {
  test("surfaces the key arg for known tools", () => {
    expect(summarizeToolArgs("bash", { command: "ls -la" })).toBe("ls -la");
    expect(summarizeToolArgs("read", { path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(summarizeToolArgs("edit", { path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(summarizeToolArgs("write", { path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(summarizeToolArgs("grep", { pattern: "foo.*bar" })).toBe("foo.*bar");
    expect(summarizeToolArgs("webfetch", { url: "https://x.dev/y" })).toBe("https://x.dev/y");
    expect(summarizeToolArgs("websearch", { query: "pi tui" })).toBe("pi tui");
    expect(summarizeToolArgs("task", { description: "research foo" })).toBe("research foo");
    expect(summarizeToolArgs("bg_task", { description: "research foo" })).toBe("research foo");
  });

  test("falls back to the tool name for unknown tools or missing args", () => {
    expect(summarizeToolArgs("mystery", { a: 1 })).toBe("mystery");
    expect(summarizeToolArgs("bash", undefined)).toBe("bash");
    expect(summarizeToolArgs("bash", {})).toBe("bash");
    expect(summarizeToolArgs("read", { offset: 5 })).toBe("read");
  });

  test("truncates long labels to <=63 chars ending with ...", () => {
    const long = "x".repeat(100);
    const label = summarizeToolArgs("bash", { command: long });
    expect(label.length).toBeLessThanOrEqual(63);
    expect(label.endsWith("...")).toBe(true);
  });
});

describe("createToolActivity", () => {
  test("summaryLine is null when idle", () => {
    const a = createToolActivity(() => 0);
    expect(a.summaryLine()).toBeNull();
  });

  test("single active tool: name, label, elapsed", () => {
    let now = 1_000;
    const a = createToolActivity(() => now);
    a.start("1", "bash", { command: "sleep 30" });
    now += 12_000;
    const line = a.summaryLine() as string;
    expect(line).toContain("bash");
    expect(line).toContain("sleep 30");
    expect(line).toContain("12s");
  });

  test("multiple active tools: longest-running named, others counted", () => {
    let now = 0;
    const a = createToolActivity(() => now);
    a.start("1", "bash", { command: "sleep 30" });
    now += 12_000;
    a.start("2", "task", { description: "research" });
    now += 5_000;
    const line = a.summaryLine() as string;
    expect(line).toContain("bash");
    expect(line).toContain("17s");
    expect(line).toContain("+1 more");
    a.start("3", "read", { path: "/x.ts" });
    expect(a.summaryLine() as string).toContain("+2 more");
  });

  test("end removes tools; idle again after the last one", () => {
    let now = 0;
    const a = createToolActivity(() => now);
    a.start("1", "bash", { command: "ls" });
    a.start("2", "task", { description: "research" });
    a.end("1");
    const line = a.summaryLine() as string;
    expect(line).toContain("task");
    expect(line).not.toContain("+1 more");
    a.end("2");
    expect(a.summaryLine()).toBeNull();
  });

  test("end on unknown id is a no-op", () => {
    const a = createToolActivity(() => 0);
    a.start("1", "bash", { command: "ls" });
    a.end("nope");
    expect(a.summaryLine() as string).toContain("bash");
  });
});
