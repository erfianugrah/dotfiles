/**
 * Smoke test for the secret-output-guard CC hook. Spawns the hook as a real
 * subprocess and pipes sample PreToolUse/PostToolUse payloads to stdin,
 * asserting the deny/alarm/allow contract - no `claude` binary needed.
 *
 * Secret fixtures are SYNTHETIC and built by repeat() so no token-looking
 * literal sits in the repo.
 *
 *   bun test .claude/hooks/secret-output-guard.smoke.test.ts
 */

import { describe, expect, test, beforeAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const hookPath = path.join(import.meta.dir, "secret-output-guard.ts");
const FAKE_KEY = "ck_" + "e5f6a7b8".repeat(8); // synthetic, matches ck_ format

async function runHook(
  payload: unknown,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn([process.execPath, hookPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extraEnv },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, stdout };
}

describe("secret-output-guard PreToolUse (deny env dumps)", () => {
  test("denies `env | grep`", async () => {
    const { code, stdout } = await runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "env | grep -i composer" },
    });
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("env");
  });

  test("denies bare `export -p`", async () => {
    const { stdout } = await runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "export -p" },
    });
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("allows credential USE by var reference", async () => {
    const { code, stdout } = await runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: 'curl -H "X-API-Key: $COMPOSER_API_KEY" https://x.test/api' },
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  test("allows assignment forms and non-Bash tools", async () => {
    for (const payload of [
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "env FOO=1 make build" } },
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "set -euo pipefail" } },
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/tmp/x" } },
    ]) {
      const { code, stdout } = await runHook(payload);
      expect(code).toBe(0);
      expect(stdout).toBe("");
    }
  });
});

describe("secret-output-guard PostToolUse (leak alarm)", () => {
  test("alarms on an env-value leak, naming the var but never the value", async () => {
    const { code, stdout } = await runHook(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo $TEST_SECRET_KEY" },
        tool_response: `the value is ${FAKE_KEY} ok`,
      },
      { TEST_SECRET_KEY: FAKE_KEY },
    );
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("env:TEST_SECRET_KEY");
    expect(ctx).not.toContain(FAKE_KEY);
    expect(ctx).not.toContain(FAKE_KEY.slice(0, 12));
  });

  test("alarms on a token-format leak with no matching env var", async () => {
    const ghp = "ghp_" + "A".repeat(36);
    const { stdout } = await runHook({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/notes.txt" },
      tool_response: `backup key: ${ghp}`,
    });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("format:github-token");
    expect(ctx).not.toContain(ghp);
  });

  test("stays silent on clean output", async () => {
    const { code, stdout } = await runHook({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: "file1.txt\nfile2.txt",
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  test("kill switch disables both halves", async () => {
    for (const payload of [
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "env" } },
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo $TEST_SECRET_KEY" },
        tool_response: FAKE_KEY,
      },
    ]) {
      const { code, stdout } = await runHook(payload, {
        PI_SECRET_GUARD_OFF: "1",
        TEST_SECRET_KEY: FAKE_KEY,
      });
      expect(code).toBe(0);
      expect(stdout).toBe("");
    }
  });
});

// ── known-value layer (secretctl registry) ───────────────────────────────────
//
// A fixture registry with one dotenv store holding a synthetic value; the hook
// runs the real secretctl against it (SECRETCTL_SOURCES) and keeps its digest
// cache in a temp dir (SECRET_GUARD_CACHE_DIR). Skipped when secretctl is not
// on PATH.

const haveSecretctl = (() => {
  try {
    return Bun.spawnSync(["secretctl", "help"]).exitCode === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!haveSecretctl)("secret-output-guard known-value layer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sog-registry-"));
  const store = path.join(root, "cfg", "app", "env");
  const copy = path.join(root, "compose.yaml");
  const clean = path.join(root, "README.md");
  const registry = path.join(root, "sources");
  const cache = path.join(root, "cache");
  // synthetic: 48 hex chars built from a repeat, never a real token
  // synthetic 48-hex value from six DISTINCT blocks (a repeated block would
  // make every "piece" the same window and never reach the assembly threshold)
  const VALUE = ["9c3e1f7a", "0b2d4e6f", "81a3c5e7", "f9d1b3a5", "26c8e0a2", "74b6d8f0"].join("");
  const env = { SECRETCTL_SOURCES: registry, SECRET_GUARD_CACHE_DIR: cache };

  beforeAll(() => {
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, `APP_TOKEN=${VALUE}\nOTHER=hello\n`, { mode: 0o600 });
    fs.writeFileSync(copy, `services:\n  app:\n    environment:\n      - TOKEN=${VALUE}\n`);
    fs.writeFileSync(clean, "nothing here\n");
    fs.writeFileSync(registry, `dotenv:${root}/cfg/*/env\n`);
  });

  test("denies Read of a registered store", async () => {
    const { stdout } = await runHook(
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: store } },
      env,
    );
    const out = JSON.parse(stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain("secret_store_read");
    expect(out.permissionDecisionReason).not.toContain(VALUE);
  });

  test("denies Read of a file that merely CONTAINS a registered value", async () => {
    const { stdout } = await runHook(
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: copy } },
      env,
    );
    const out = JSON.parse(stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain("secret_copy_read");
    expect(out.permissionDecisionReason).toContain("#APP_TOKEN");
    expect(out.permissionDecisionReason).not.toContain(VALUE);
  });

  test("denies bash cat / grep aimed at the store, allows the masking idiom", async () => {
    for (const command of [`cat ${store}`, `grep TOKEN ${store}`]) {
      const { stdout } = await runHook(
        { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } },
        env,
      );
      expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    }
    const { stdout } = await runHook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `sed 's/=.*$/=<set>/' ${store}` } },
      env,
    );
    expect(stdout).toBe("");
  });

  test("denies a registered value typed into ANY tool argument", async () => {
    for (const payload of [
      { tool_name: "Bash", tool_input: { command: `echo ${VALUE} > /dev/null` } },
      { tool_name: "Write", tool_input: { file_path: path.join(root, "x.env"), content: `TOKEN=${VALUE}\n` } },
      { tool_name: "Edit", tool_input: { file_path: clean, old_string: "nothing", new_string: `key ${VALUE}` } },
    ]) {
      const { stdout } = await runHook({ hook_event_name: "PreToolUse", ...payload }, env);
      const out = JSON.parse(stdout).hookSpecificOutput;
      expect(out.permissionDecision).toBe("deny");
      expect(out.permissionDecisionReason).toContain("secret_in_args");
      expect(out.permissionDecisionReason).not.toContain(VALUE);
    }
  });

  test("denies a value ASSEMBLED from 8-char pieces (printf-of-chunks workaround)", async () => {
    const chunks = VALUE.match(/.{8}/g)!;
    const { stdout } = await runHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: `X=$(printf '%s' ${chunks.join(" ")}) && echo "$X" > /dev/null && echo done` },
      },
      env,
    );
    const out = JSON.parse(stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain("PIECES that assemble");
    expect(out.permissionDecisionReason).not.toContain(VALUE);
    // a single piece on its own is not a hit
    const single = await runHook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `echo ${chunks[0]}` } },
      env,
    );
    expect(single.stdout).toBe("");
  });

  test("allows a clean read and a var-reference command", async () => {
    for (const payload of [
      { tool_name: "Read", tool_input: { file_path: clean } },
      { tool_name: "Bash", tool_input: { command: 'curl -H "Authorization: Bearer $APP_TOKEN" https://x.test' } },
    ]) {
      const { code, stdout } = await runHook({ hook_event_name: "PreToolUse", ...payload }, env);
      expect(code).toBe(0);
      expect(stdout).toBe("");
    }
  });

  test("PostToolUse alarms on a registered value by digest, naming the label only", async () => {
    const { stdout } = await runHook(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Grep",
        tool_input: { pattern: "TOKEN", path: root },
        tool_response: `./cfg/app/env:1:APP_TOKEN=${VALUE}`,
      },
      env,
    );
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("registry:dotenv:");
    expect(ctx).toContain("#APP_TOKEN");
    expect(ctx).not.toContain(VALUE);
    expect(ctx).not.toContain(VALUE.slice(0, 12));
  });

  test("digest cache is created private and reused", async () => {
    const file = path.join(cache, "secret-guard", "digests.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(cache, "secret-guard")).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(file, "utf8")).not.toContain(VALUE);
  });
});
