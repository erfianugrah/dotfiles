/**
 * epistemic-guard END-TO-END: drives the REAL hooks through a fake pi runtime.
 *
 * Focus is the contract that makes the guard usable rather than annoying:
 *   - a specific with provenance in a tool result NEVER blocks
 *   - a specific without provenance blocks ONCE, then the retry passes
 *   - verifying mid-session (new tool result) silences a claim for good
 *   - code payloads only surface pins/CVEs; prose surfaces everything
 *   - the chat footer annotates a final answer and leaves working steps alone
 *
 * Run: ./.pi/agent/tests/run.sh   (separate bun process from the unit suite)
 */
import { beforeEach, describe, expect, test } from "bun:test";

// ExtensionAPI is a type-only import in the extension; node:path is the only
// runtime dependency, so no SDK mock is needed.
import guard from "../../extensions/epistemic-guard.ts";

type HookFn = (e: unknown, c: unknown) => Promise<unknown> | unknown;
type Block = { block?: boolean; reason?: string } | undefined;

let hooks: Record<string, HookFn[]>;
let entries: unknown[];
let ctx: unknown;

const pi = {
  on: (evt: string, fn: HookFn) => {
    (hooks[evt] ||= []).push(fn);
  },
  registerTool: () => {},
  registerCommand: () => {},
} as never;

function toolResultEntry(text: string): unknown {
  return {
    type: "message",
    message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text }] },
  };
}

function userEntry(text: string): unknown {
  return { type: "message", message: { role: "user", content: text } };
}

async function toolCall(toolName: string, input: unknown): Promise<Block> {
  let last: Block;
  for (const fn of hooks["tool_call"] ?? []) {
    const r = (await fn({ toolName, input }, ctx)) as Block;
    if (r) last = r;
  }
  return last;
}

async function answer(text: string, withToolCall = false): Promise<string | undefined> {
  const content: unknown[] = [{ type: "text", text }];
  if (withToolCall) content.push({ type: "toolCall", id: "1", name: "bash", arguments: {} });
  const message = { role: "assistant", content };
  let out: string | undefined;
  for (const fn of hooks["message_end"] ?? []) {
    const r = (await fn({ message }, ctx)) as { message?: { content?: Array<{ text?: string }> } };
    if (r?.message) out = r.message.content?.map((b) => b.text ?? "").join("\n");
  }
  return out;
}

beforeEach(() => {
  hooks = {};
  entries = [];
  ctx = {
    hasUI: true,
    sessionManager: {
      getSessionFile: () => "/tmp/pi-epistemic-e2e.jsonl",
      getEntries: () => entries,
    },
    getSystemPrompt: () => "harness paths live under ~/.pi/agent",
  };
  delete process.env.PI_EPISTEMIC_GUARD_OFF;
  delete process.env.PI_EPISTEMIC_FOOTER_OFF;
  guard(pi);
});

describe("epistemic-guard e2e / write gate", () => {
  test("PASSES a doc whose version came from a tool result", async () => {
    entries.push(toolResultEntry("caddy version v2.11.4 h1:abcdef"));
    const r = await toolCall("write", {
      path: "docs/edge.md",
      content: "The edge runs Caddy 2.11.4 in host mode.",
    });
    expect(r?.block).toBeUndefined();
  });

  test("BLOCKS a doc whose version is recalled, and names the specific", async () => {
    const r = await toolCall("write", {
      path: "docs/edge.md",
      content: "The edge runs Caddy 2.11.4 in host mode.",
    });
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("2.11.4");
    expect(r?.reason).toContain("no provenance");
  });

  test("the retry passes - one flag per specific per session, never a wall", async () => {
    const first = await toolCall("write", { path: "docs/e.md", content: "Caddy 2.11.4 is current." });
    expect(first?.block).toBe(true);
    const retry = await toolCall("write", { path: "docs/e.md", content: "Caddy 2.11.4 is current." });
    expect(retry?.block).toBeUndefined();
  });

  test("verifying mid-session silences the claim before it is ever flagged", async () => {
    entries.push(userEntry("check the knot version first"));
    entries.push(toolResultEntry("Knot DNS, version 3.5.4"));
    const r = await toolCall("write", { path: "docs/dns.md", content: "We run Knot 3.5.4." });
    expect(r?.block).toBeUndefined();
  });

  test("a user-supplied specific counts as provenance", async () => {
    entries.push(userEntry("pin it to caddy 2.11.4 please"));
    const r = await toolCall("write", { path: "docs/e.md", content: "Pinned to Caddy 2.11.4." });
    expect(r?.block).toBeUndefined();
  });

  test("system-prompt paths count as provenance (prefix-tolerant)", async () => {
    const r = await toolCall("write", {
      path: "docs/x.md",
      content: "Extensions live in ~/.pi/agent/extensions.",
    });
    expect(r?.block).toBeUndefined();
  });

  test("a claim labelled next to the number is left alone", async () => {
    const r = await toolCall("write", {
      path: "docs/e.md",
      content: "Caddy 2.11.4 (unverified - recalled, not checked against the registry).",
    });
    expect(r?.block).toBeUndefined();
  });

  test("a hedge far from the claim does NOT buy a payload-wide pass", async () => {
    const r = await toolCall("write", {
      path: "docs/e.md",
      content: "Numbers here may be unverified.\n\n" + "filler. ".repeat(60) + "Caddy 2.11.4 is current.",
    });
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("2.11.4");
  });
});

describe("epistemic-guard e2e / payload scoping", () => {
  test("code: a dependency pin is a claim", async () => {
    const r = await toolCall("write", {
      path: "src/deps.ts",
      content: 'import { z } from "zod@^4.9.1";',
    });
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("4.9.1");
  });

  test("code: a flag or system path is an instruction, not a claim", async () => {
    const r = await toolCall("write", {
      path: "src/run.ts",
      content: 'spawn("caddy", ["--nonexistent-flag", "/etc/nowhere/x.conf"]);',
    });
    expect(r?.block).toBeUndefined();
  });

  test("prose: a fenced command block is an instruction too", async () => {
    const r = await toolCall("write", {
      path: "docs/run.md",
      content: "How to run it:\n\n```bash\ncaddy run --nonexistent-flag\n```\n",
    });
    expect(r?.block).toBeUndefined();
  });

  test("prose: the same flag OUTSIDE the fence is an assertion", async () => {
    const r = await toolCall("write", {
      path: "docs/run.md",
      content: "Pass --nonexistent-flag to enable it.",
    });
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("--nonexistent-flag");
  });

  test("scratch and generated targets are skipped entirely", async () => {
    expect((await toolCall("write", { path: "/tmp/notes.md", content: "Caddy 9.9.9" }))?.block).toBeUndefined();
    expect((await toolCall("write", { path: "bun.lock", content: "x@9.9.9" }))?.block).toBeUndefined();
  });

  test("edit uses the edits[] schema (top-level newText is legacy)", async () => {
    const r = await toolCall("edit", {
      path: "docs/e.md",
      edits: [{ oldText: "a", newText: "Postgres 17.9 ships this." }],
    });
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("17.9");
  });

  test("apply_patch scans added lines only", async () => {
    const patch =
      "*** Begin Patch\n*** Update File: docs/e.md\n@@ ctx\n-old line about 5.5.5\n+new line about Redis 7.7.7\n*** End Patch";
    const r = await toolCall("apply_patch", { patchText: patch });
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("7.7.7");
    expect(r?.reason).not.toContain("5.5.5");
  });

  test("commit messages are scanned; unrelated bash is not", async () => {
    const blocked = await toolCall("bash", {
      command: 'git commit -m "fix: bump to 8.8.8 and cut latency to 12ms"',
    });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("8.8.8");

    const passed = await toolCall("bash", { command: "rg --files | rg 9.9.9" });
    expect(passed?.block).toBeUndefined();
  });
});

describe("epistemic-guard e2e / unattended runs (pi -p, loops, subagents)", () => {
  beforeEach(() => {
    (ctx as { hasUI: boolean }).hasUI = false;
    delete process.env.PI_EPISTEMIC_MAX_BLOCKS;
  });

  test("NEVER annotates the answer - that text is the subagent's return payload", async () => {
    expect(await answer("Knot DNS 3.5.9 handles that natively.")).toBeUndefined();
  });

  test("blocks up to the budget, then degrades to observe-only", async () => {
    process.env.PI_EPISTEMIC_MAX_BLOCKS = "2";
    expect((await toolCall("write", { path: "docs/a.md", content: "Knot 3.1.1" }))?.block).toBe(true);
    expect((await toolCall("write", { path: "docs/b.md", content: "Knot 3.2.2" }))?.block).toBe(true);
    expect((await toolCall("write", { path: "docs/c.md", content: "Knot 3.3.3" }))?.block).toBeUndefined();
  });

  test("PI_EPISTEMIC_MAX_BLOCKS=0 is observe-only from the first write", async () => {
    process.env.PI_EPISTEMIC_MAX_BLOCKS = "0";
    expect((await toolCall("write", { path: "docs/a.md", content: "Knot 3.1.1" }))?.block).toBeUndefined();
  });

  test("provenance still applies - a verified specific never blocks", async () => {
    process.env.PI_EPISTEMIC_MAX_BLOCKS = "2";
    entries.push(toolResultEntry("Knot DNS, version 3.1.1"));
    expect((await toolCall("write", { path: "docs/a.md", content: "Knot 3.1.1" }))?.block).toBeUndefined();
  });
});

describe("epistemic-guard e2e / chat annotation", () => {
  test("annotates a final answer with recalled specifics", async () => {
    const out = await answer("Knot DNS 3.5.9 handles that natively.");
    expect(out).toContain("recalled, not verified");
    expect(out).toContain("3.5.9");
  });

  test("leaves a verified answer untouched", async () => {
    entries.push(toolResultEntry("Knot DNS, version 3.5.9"));
    expect(await answer("Knot DNS 3.5.9 handles that natively.")).toBeUndefined();
  });

  test("leaves working steps (messages that call tools) untouched", async () => {
    expect(await answer("Checking Knot 3.5.9 now.", true)).toBeUndefined();
  });

  test("respects PI_EPISTEMIC_FOOTER_OFF", async () => {
    hooks = {};
    process.env.PI_EPISTEMIC_FOOTER_OFF = "1";
    guard(pi);
    expect(await answer("Knot DNS 3.5.9 handles that natively.")).toBeUndefined();
    // the write gate still runs
    expect((await toolCall("write", { path: "docs/e.md", content: "Knot 3.5.9" }))?.block).toBe(true);
  });

  test("PI_EPISTEMIC_GUARD_OFF disables everything", async () => {
    hooks = {};
    process.env.PI_EPISTEMIC_GUARD_OFF = "1";
    guard(pi);
    expect(hooks["tool_call"]).toBeUndefined();
    expect(hooks["message_end"]).toBeUndefined();
  });
});
