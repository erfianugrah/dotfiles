/**
 * skill-guard END-TO-END: drives the REAL before_agent_start + tool_call hooks
 * through a fake pi runtime.
 *
 * Focus:
 *   - intent hook injects a NON-BLOCKING message (not a block) for matching
 *     prompts, and only once per skill per session.
 *   - action hook blocks a matching write/edit ONCE, then passes the retry
 *     (the docs_first "block once, mark session, pass" pattern).
 *   - session isolation: a new session key gets a fresh nudge.
 *
 * Run: ./.pi/agent/tests/run.sh   (separate bun process from the unit suite)
 */
import { beforeAll, describe, expect, test } from "bun:test";

import guard from "../../extensions/skill-guard.ts";

type HookFn = (e: unknown, c: unknown) => Promise<unknown> | unknown;
const hooks: Record<string, HookFn[]> = {};
const pi = {
  on: (evt: string, fn: HookFn) => {
    (hooks[evt] ||= []).push(fn);
  },
  registerTool: () => {},
  registerCommand: () => {},
} as never;

// Distinct fake session per test so the module-scope fired-set doesn't bleed.
let n = 0;
const ctxFor = (key: string) => ({ sessionManager: { getSessionFile: () => key } });
const freshCtx = () => ctxFor(`sess-${Date.now()}-${n++}`);

type BlockResult = { block?: boolean; reason?: string } | undefined;
type IntentResult = { message?: { content?: string } } | undefined;

async function beforeStart(prompt: string, ctx: unknown): Promise<IntentResult> {
  let last: IntentResult;
  for (const fn of hooks["before_agent_start"] ?? []) {
    const r = (await fn({ prompt }, ctx)) as IntentResult;
    if (r) last = r;
  }
  return last;
}
async function toolCall(toolName: string, input: unknown, ctx: unknown): Promise<BlockResult> {
  let last: BlockResult;
  for (const fn of hooks["tool_call"] ?? []) {
    const r = (await fn({ toolName, input }, ctx)) as BlockResult;
    if (r) last = r;
  }
  return last;
}

beforeAll(() => {
  guard(pi);
});

describe("skill-guard e2e / intent (before_agent_start)", () => {
  test("injects a message for a matching prompt", async () => {
    const ctx = freshCtx();
    const r = await beforeStart("deploy this to fly.io please", ctx);
    expect(r?.message?.content).toContain("`fly`");
    expect(r?.message?.content).toContain("SKILL.md");
  });

  test("does NOT block (intent is a nudge, not a gate)", async () => {
    const ctx = freshCtx();
    const r = (await beforeStart("scaffold a new dashboard", ctx)) as { block?: boolean } | undefined;
    expect(r?.block).toBeUndefined();
  });

  test("fires once per skill per session", async () => {
    const ctx = freshCtx();
    const first = await beforeStart("open a PR for this", ctx);
    expect(first?.message?.content).toContain("`gh`");
    const second = await beforeStart("open another PR", ctx);
    expect(second).toBeUndefined();
  });

  test("no match -> no message", async () => {
    const ctx = freshCtx();
    const r = await beforeStart("fix the failing test in parser.ts", ctx);
    expect(r).toBeUndefined();
  });
});

describe("skill-guard e2e / action (tool_call)", () => {
  test("blocks a Dockerfile edit ONCE, then passes the retry", async () => {
    const ctx = freshCtx();
    const first = await toolCall("edit", { path: "app/Dockerfile", edits: [] }, ctx);
    expect(first?.block).toBe(true);
    expect(first?.reason).toContain("skill-guard[dockerfile_docker]");
    // retry (model has now read the skill) must pass
    const second = await toolCall("edit", { path: "app/Dockerfile", edits: [] }, ctx);
    expect(second).toBeUndefined();
  });

  test("blocks a compose write via infrastructure-stack", async () => {
    const ctx = freshCtx();
    const r = await toolCall("write", { path: "stacks/x/docker-compose.yml", content: "" }, ctx);
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("infrastructure-stack");
  });

  test("blocks apply_patch touching a .tf file", async () => {
    const ctx = freshCtx();
    const patch = ["*** Begin Patch", "*** Update File: infra/main.tf", "*** End Patch"].join("\n");
    const r = await toolCall("apply_patch", { patchText: patch }, ctx);
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("terraform");
  });

  test("blocks a flyctl bash command once", async () => {
    const ctx = freshCtx();
    const r = await toolCall("bash", { command: "flyctl deploy -a glory-hole" }, ctx);
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("`fly`");
  });

  test("passes unrelated writes and bash", async () => {
    const ctx = freshCtx();
    expect(await toolCall("edit", { path: "src/index.ts", edits: [] }, ctx)).toBeUndefined();
    expect(await toolCall("bash", { command: "git status" }, ctx)).toBeUndefined();
  });

  test("intent + action share the dedup: intent fly suppresses the flyctl block", async () => {
    const ctx = freshCtx();
    const intent = await beforeStart("let's use fly.io for this", ctx);
    expect(intent?.message?.content).toContain("`fly`");
    // fly already nudged via intent -> the bash action must NOT block again
    const action = await toolCall("bash", { command: "flyctl deploy" }, ctx);
    expect(action).toBeUndefined();
  });

  test("different session gets a fresh block", async () => {
    const a = freshCtx();
    const b = freshCtx();
    expect((await toolCall("write", { path: "Caddyfile", content: "" }, a))?.block).toBe(true);
    expect((await toolCall("write", { path: "Caddyfile", content: "" }, a))).toBeUndefined();
    // brand-new session -> fires again
    expect((await toolCall("write", { path: "Caddyfile", content: "" }, b))?.block).toBe(true);
  });
});
