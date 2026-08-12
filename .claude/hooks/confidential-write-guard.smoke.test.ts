/**
 * Smoke test for the confidential-write-guard PreToolUse hook. Spawns the hook
 * as a real subprocess and pipes sample PreToolUse payloads to stdin, asserting
 * the deny/allow contract - no `claude` binary needed.
 *
 * A throwaway tmp "repo" (a dir with .git/info/confidential-terms.json holding
 * one blocked term) provides the user-confirmed store the hook enforces. The
 * deny reason must MASK the term ([REDACTED]) and never echo it.
 *
 *   bun test .claude/hooks/confidential-write-guard.smoke.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const hookPath = path.join(import.meta.dir, "confidential-write-guard.ts");

const TERM = "Zephyrus"; // the confirmed-confidential term for this test repo
let repoDir = "";
let agentDir = "";

beforeAll(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "cwg-repo-"));
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cwg-agent-")); // empty global store
  const info = path.join(repoDir, ".git", "info");
  fs.mkdirSync(info, { recursive: true });
  fs.writeFileSync(
    path.join(info, "confidential-terms.json"),
    JSON.stringify({ blocked: [TERM], allowed: [] }),
  );
});

afterAll(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(agentDir, { recursive: true, force: true });
});

async function runHook(
  payload: unknown,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn([process.execPath, hookPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CONFIDENTIAL_GUARD_AGENT_DIR: agentDir, ...extraEnv },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, stdout };
}

describe("confidential-write-guard PreToolUse hook", () => {
  test("denies a Write whose content contains a blocked term; masks it in the reason", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: path.join(repoDir, "plan.md"), content: `we onboarded ${TERM} today` },
    });
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("[REDACTED]");
    // the reason must NEVER echo the confidential term back into the log
    expect(out.hookSpecificOutput.permissionDecisionReason).not.toContain(TERM);
  });

  test("allows a clean Write (no stdout, exit 0)", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: path.join(repoDir, "plan.md"), content: "nothing sensitive here" },
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("denies an Edit new_string carrying the blocked term", async () => {
    const { stdout } = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(repoDir, "README.md"),
        old_string: "x",
        new_string: `partner ${TERM} signed`,
      },
    });
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("denies a Bash git-commit into the repo whose message has the term", async () => {
    const { stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: `cd ${repoDir} && git commit -m "close ${TERM} deal"` },
    });
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("ignores a read/search Bash even if it contains the term (no false positive)", async () => {
    const { stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: `cd ${repoDir} && grep -r ${TERM} .` },
    });
    expect(stdout.trim()).toBe(""); // not a commit-persist -> allowed
  });

  test("never blocks a write to the terms store file itself", async () => {
    const { stdout } = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: path.join(repoDir, ".git", "info", "confidential-terms.json"),
        content: JSON.stringify({ blocked: [TERM], allowed: [] }),
      },
    });
    expect(stdout.trim()).toBe("");
  });

  test("CONFIDENTIAL_GUARD_OFF=1 disables the guard", async () => {
    const { stdout } = await runHook(
      {
        tool_name: "Write",
        tool_input: { file_path: path.join(repoDir, "plan.md"), content: `leak ${TERM}` },
      },
      { CONFIDENTIAL_GUARD_OFF: "1" },
    );
    expect(stdout.trim()).toBe("");
  });
});
