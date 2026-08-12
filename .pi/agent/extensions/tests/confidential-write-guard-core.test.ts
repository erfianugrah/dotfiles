/**
 * confidential-write-guard-core unit tests - pure, no harness, no network, no
 * git binary. Covers term matching (boundaries + masking that never echoes the
 * term), store round-trips, commit-payload assembly with injected readFile/diff,
 * cd-cwd resolution, and the evaluateWrite / evaluateCommitBash orchestrators.
 *
 *   bun test extensions/tests/confidential-write-guard-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  blockMsg,
  collectCommitPayload,
  dedup,
  emptyStore,
  evaluateCommitBash,
  evaluateWrite,
  extractMessageFilePaths,
  extractPatchPaths,
  globalStorePath,
  isCommitPersist,
  isProsePath,
  isStoreFile,
  readStore,
  resolveBashCwd,
  scanForBlocked,
  writeStore,
} from "../lib/confidential-write-guard-core.ts";

// ── scanForBlocked (boundary matching + masking) ─────────────────────────────

describe("scanForBlocked", () => {
  test("matches a blocked term on non-alphanumeric boundaries, case-insensitive", () => {
    expect(scanForBlocked("we onboarded Acme/Foo today", ["Acme"])).not.toBeNull();
    expect(scanForBlocked("deal with acme yesterday", ["Acme"])).not.toBeNull();
  });

  test("does NOT match a term embedded in a longer alphanumeric token", () => {
    expect(scanForBlocked("the Acmebot integration", ["Acme"])).toBeNull();
    expect(scanForBlocked("preAcme era", ["Acme"])).toBeNull();
  });

  test("empty text or empty blocklist never matches", () => {
    expect(scanForBlocked("", ["Acme"])).toBeNull();
    expect(scanForBlocked("Acme is here", [])).toBeNull();
  });

  test("masked snippet NEVER echoes the matched term - it is [REDACTED]", () => {
    const hit = scanForBlocked("intro Acme outro", ["Acme"]);
    expect(hit).not.toBeNull();
    expect(hit!.masked).toContain("[REDACTED]");
    expect(hit!.masked.toLowerCase()).not.toContain("acme");
    expect(hit!.masked).toContain("intro");
    expect(hit!.masked).toContain("outro");
  });

  test("regex-special terms are matched literally (no injection)", () => {
    expect(scanForBlocked("project a.b.c launch", ["a.b.c"])).not.toBeNull();
    expect(scanForBlocked("project axbxc launch", ["a.b.c"])).toBeNull();
  });

  test("returns the FIRST blocked term encountered", () => {
    expect(scanForBlocked("only Zeta here", ["Alpha", "Zeta"])).not.toBeNull();
  });
});

// ── isProsePath / isStoreFile / isCommitPersist ──────────────────────────────

describe("path + command classifiers", () => {
  test("isProsePath: prose extensions and docs/ dirs", () => {
    expect(isProsePath("plan.md")).toBe(true);
    expect(isProsePath("a/docs/notes.txt")).toBe(true);
    expect(isProsePath("src/index.ts")).toBe(false);
  });

  test("isStoreFile: only the two store filenames", () => {
    expect(isStoreFile("/x/.git/info/confidential-terms.json")).toBe(true);
    expect(isStoreFile("/agent/confidential-terms.local.json")).toBe(true);
    expect(isStoreFile("/x/README.md")).toBe(false);
  });

  test("isCommitPersist: commit/tag/notes/gh persists, not read/search", () => {
    expect(isCommitPersist("git commit -m x")).toBe(true);
    expect(isCommitPersist("git tag -a v1 -m x")).toBe(true);
    expect(isCommitPersist("gh pr create --body x")).toBe(true);
    expect(isCommitPersist("git log --oneline")).toBe(false);
    expect(isCommitPersist("grep -r Acme .")).toBe(false);
  });
});

// ── resolveBashCwd (last cd target wins) ─────────────────────────────────────

describe("resolveBashCwd", () => {
  test("no cd -> fallback", () => {
    expect(resolveBashCwd("git commit -m x", "/base")).toBe("/base");
  });
  test("cd prefix is resolved relative to fallback (last wins)", () => {
    expect(resolveBashCwd("cd sub && git commit -m x", "/base")).toBe("/base/sub");
    expect(resolveBashCwd("cd a && cd /abs && git commit", "/base")).toBe("/abs");
  });
  test("$-containing cd target is skipped (unresolvable)", () => {
    expect(resolveBashCwd("cd $HOME/x && git commit", "/base")).toBe("/base");
  });
});

// ── extractMessageFilePaths / extractPatchPaths ──────────────────────────────

describe("payload path extraction", () => {
  test("extractMessageFilePaths: -F / --file / --body-file, excludes stdin -", () => {
    expect(extractMessageFilePaths("git commit -F /tmp/msg")).toEqual(["/tmp/msg"]);
    expect(extractMessageFilePaths("git commit --file=/tmp/m2")).toEqual(["/tmp/m2"]);
    expect(extractMessageFilePaths("gh pr create --body-file body.md")).toEqual(["body.md"]);
    expect(extractMessageFilePaths("git commit -F -")).toEqual([]);
  });

  test("extractPatchPaths: pulls Add/Update/Delete/Move file targets", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: docs/plan.md",
      "+hello",
      "*** Update File: src/x.ts",
      "*** End Patch",
    ].join("\n");
    expect(extractPatchPaths(patch)).toEqual(["docs/plan.md", "src/x.ts"]);
  });
});

// ── collectCommitPayload (injected readFile + diff, no git binary) ───────────

describe("collectCommitPayload", () => {
  test("assembles cmd + message-file body + staged diff for git commit", () => {
    const parts = collectCommitPayload(
      "git commit -F /tmp/msg",
      "/repo",
      (p) => (p === "/tmp/msg" ? "message file body" : ""),
      () => "diff --git a/x b/x\n+staged Acme line",
    );
    expect(parts[0]).toBe("git commit -F /tmp/msg");
    expect(parts).toContain("message file body");
    expect(parts.some((p) => p.includes("staged Acme line"))).toBe(true);
  });

  test("no staged diff pulled for a non-commit gh command", () => {
    let diffCalled = false;
    const parts = collectCommitPayload(
      "gh pr create --body 'hi'",
      "/repo",
      () => "",
      () => {
        diffCalled = true;
        return "should not appear";
      },
    );
    expect(diffCalled).toBe(false);
    expect(parts).toEqual(["gh pr create --body 'hi'"]);
  });

  test("relative message-file path resolves against cwd", () => {
    const seen: string[] = [];
    collectCommitPayload(
      "git commit -F rel/msg",
      "/repo",
      (p) => {
        seen.push(p);
        return "";
      },
      () => "",
    );
    expect(seen).toContain(path.resolve("/repo", "rel/msg"));
  });
});

// ── store round-trip (real tmp dir, no network) ──────────────────────────────

describe("store read/write round-trip", () => {
  test("writeStore dedups + trims, readStore parses back, missing -> empty", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwg-"));
    const file = globalStorePath(dir);
    writeStore(file, { blocked: [" Acme ", "Acme", "Beta"], allowed: ["ok"] });
    const back = readStore(file);
    expect(back.blocked.sort()).toEqual(["Acme", "Beta"]);
    expect(back.allowed).toEqual(["ok"]);
    expect(readStore(path.join(dir, "nope.json"))).toEqual(emptyStore());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("dedup trims, drops blanks, de-duplicates", () => {
    expect(dedup([" a ", "a", "", "b"])).toEqual(["a", "b"]);
  });
});

// ── orchestrators: evaluateWrite / evaluateCommitBash ────────────────────────

describe("evaluateWrite orchestrator", () => {
  const KS = "PI_CONFIDENTIAL_GUARD_OFF";

  test("blocks when a blob contains a blocked term; reason masks it", () => {
    const d = evaluateWrite({
      target: "/repo/plan.md",
      blocked: ["Acme"],
      blobs: ["we signed Acme this quarter"],
      where: "write -> /repo/plan.md",
      killSwitchEnv: KS,
    });
    expect(d.block).toBe(true);
    if (d.block) {
      expect(d.reason).toContain("[REDACTED]");
      expect(d.reason.toLowerCase()).not.toContain("acme");
      expect(d.reason).toContain(KS);
    }
  });

  test("blocks when the TARGET PATH itself contains a blocked term", () => {
    const d = evaluateWrite({
      target: "/repo/Acme/notes.md",
      blocked: ["Acme"],
      blobs: ["clean body"],
      where: "write",
      killSwitchEnv: KS,
    });
    expect(d.block).toBe(true);
  });

  test("never blocks a write to the store file itself", () => {
    const d = evaluateWrite({
      target: "/repo/.git/info/confidential-terms.json",
      blocked: ["Acme"],
      blobs: ['{"blocked":["Acme"]}'],
      where: "write",
      killSwitchEnv: KS,
    });
    expect(d.block).toBe(false);
  });

  test("allows clean content", () => {
    const d = evaluateWrite({
      target: "/repo/plan.md",
      blocked: ["Acme"],
      blobs: ["nothing sensitive here"],
      where: "write",
      killSwitchEnv: KS,
    });
    expect(d.block).toBe(false);
  });
});

describe("evaluateCommitBash orchestrator", () => {
  const KS = "PI_CONFIDENTIAL_GUARD_OFF";

  test("ignores non-commit-persist commands entirely", () => {
    const d = evaluateCommitBash({
      cmd: "grep -r Acme .",
      cwd: "/repo",
      blocked: ["Acme"],
      killSwitchEnv: KS,
      collectPayload: () => ["grep -r Acme ."],
    });
    expect(d.block).toBe(false);
  });

  test("empty blocklist -> allow (no payload assembly needed)", () => {
    const d = evaluateCommitBash({
      cmd: "git commit -m x",
      cwd: "/repo",
      blocked: [],
      killSwitchEnv: KS,
    });
    expect(d.block).toBe(false);
  });

  test("blocks when the assembled payload (staged diff via injection) has a term", () => {
    const d = evaluateCommitBash({
      cmd: "git commit -m 'routine'",
      cwd: "/repo",
      blocked: ["Acme"],
      killSwitchEnv: KS,
      collectPayload: () => ["git commit -m 'routine'", "+ added Acme to the readme"],
    });
    expect(d.block).toBe(true);
    if (d.block) {
      expect(d.where).toBe("bash (commit/PR payload)");
      expect(d.reason.toLowerCase()).not.toContain("acme");
    }
  });
});

// ── blockMsg contract (never echoes the term; carries kill switch) ───────────

describe("blockMsg", () => {
  test("includes masked context + where + kill switch, never the raw term", () => {
    const msg = blockMsg("intro [REDACTED] outro", "write -> plan.md", "FOO_OFF");
    expect(msg).toContain("[REDACTED]");
    expect(msg).toContain("write -> plan.md");
    expect(msg).toContain("FOO_OFF=1");
  });
});
