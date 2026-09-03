/**
 * git-gh-gate-core unit tests - pure, no harness, no shell. Covers the bash
 * classifier (segment splitting + every mutating-command family + read-only
 * negatives + compound/subshell forms) and the .git-internals path check.
 *
 *   bun test extensions/tests/git-gh-gate-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  classifyBashCommand,
  classifyWritePath,
  isReadOnlyGhApi,
  matchesBashGate,
  matchesGitInternal,
  splitCommandSegments,
} from "../lib/git-gh-gate-core.ts";

describe("splitCommandSegments", () => {
  test("single command -> one segment", () => {
    expect(splitCommandSegments("git commit -m 'x'")).toEqual(["git commit -m 'x'"]);
  });

  test("splits on && ; | ||", () => {
    expect(splitCommandSegments("cd /r && git commit")).toEqual(["cd /r ", " git commit"]);
    expect(splitCommandSegments("git status; git commit")).toEqual(["git status", " git commit"]);
    expect(splitCommandSegments("git rev-parse HEAD | tee f")).toEqual(["git rev-parse HEAD ", " tee f"]);
  });

  test("extracts $(...) and `...` substitutions as their own segments", () => {
    const segs = splitCommandSegments("echo $(git commit -m x)");
    expect(segs).toContain("git commit -m x");
    const back = splitCommandSegments("echo `git push`");
    expect(back).toContain("git push");
  });
});

describe("matchesBashGate - mutating git commands are gated", () => {
  const MUTATING = [
    "git commit -m 'x'",
    "git push origin main",
    "git reset --hard HEAD~1",
    "git rebase -i main",
    "git merge feature",
    "git revert abc123",
    "git cherry-pick abc123",
    "git tag v1.0.0",
    "git branch -d old",
    "git branch --delete old",
    "git stash drop",
    "git stash pop",
    "git checkout main",
    "git restore file.txt",
    "git switch main",
    "git clean -fd",
    "git am patch.mbox",
    "git apply patch.diff",
    "git rm file.txt",
    "git mv a b",
    "git filter-branch --tree-filter x",
    "git filter-repo --path x",
    "git update-ref refs/heads/x abc",
    "git config user.name x",
    "git remote add origin url",
    "git remote set-url origin url",
    "git submodule update",
    "git worktree add ../wt",
    "git worktree remove ../wt",
  ];
  for (const cmd of MUTATING) {
    test(`gates: ${cmd}`, () => {
      expect(matchesBashGate(cmd)).toBeDefined();
    });
  }
});

describe("matchesBashGate - mutating gh commands are gated", () => {
  const MUTATING = [
    "gh pr create --fill",
    "gh pr merge 12",
    "gh issue close 5",
    "gh release create v1.0",
    "gh repo delete owner/x",
    "gh gist create f.txt",
    "gh api -X POST repos/o/r/issues -f title=x",
    "gh api repos/o/r/issues -f title=x", // no -X + field => gh sends POST
    "gh api -X DELETE repos/o/r",
    "gh api --method PATCH repos/o/r -f name=y",
    "gh api --method=PUT repos/o/r/topics --input topics.json",
    "gh api -XDELETE repos/o/r",
    "gh api graphql -f query='mutation { x }'",
    "gh api repos/o/r --input body.json",
    "gh api -X GET -X POST repos/o/r", // mixed methods: last wins in gh, gate it
    "gh api -X", // dangling flag: ambiguous
    "gh auth login",
    "gh auth logout",
    "gh auth refresh -s repo",
    "gh auth setup-git",
    "gh auth token", // prints a credential; not a mutation but stays gated
    "gh secret set X",
    "gh secret delete X",
    "gh variable set X",
    "gh variable delete X",
    "gh ssh-key add key",
    "gh ssh-key delete 1",
    "gh gpg-key add key",
    "gh gpg-key delete 1",
    "gh workflow run ci.yml",
    "gh run cancel 99",
    "gh run rerun 99",
  ];
  for (const cmd of MUTATING) {
    test(`gates: ${cmd}`, () => {
      expect(matchesBashGate(cmd)).toBeDefined();
    });
  }
});

describe("matchesBashGate - read-only / benign commands are NOT gated", () => {
  const BENIGN = [
    "git status",
    "git log --oneline",
    "git diff HEAD",
    "git show abc123",
    "git rev-parse HEAD",
    "git branch",
    "git branch -a",
    "git stash list",
    "git remote -v",
    "gh pr view 12",
    "gh pr list",
    "gh issue list",
    "gh repo view owner/x",
    "gh run view 99",
    "gh workflow list",
    "gh api -X GET search/code -f q=needle",
    "gh api --method GET repos/o/r",
    "gh api --method=GET repos/o/r/pulls",
    "gh api -XGET rate_limit",
    'gh api -X "GET" repos/o/r',
    "gh api -X get repos/o/r", // method is case-insensitive in gh
    "gh api repos/o/r", // no method, no body => GET
    "gh api repos/o/r/pulls --paginate --jq '.[].number'",
    "gh api -H 'Accept: application/vnd.github+json' repos/o/r",
    "gh auth status",
    "gh secret list",
    "gh variable list",
    "gh variable get FOO",
    "gh ssh-key list",
    "gh gpg-key list",
    "ls -la",
    "echo hello",
    "cat file.txt",
  ];
  for (const cmd of BENIGN) {
    test(`allows: ${cmd}`, () => {
      expect(matchesBashGate(cmd)).toBeUndefined();
    });
  }
});

describe("matchesBashGate - compound / subshell forms", () => {
  test("cd then commit is gated via the second segment", () => {
    expect(matchesBashGate("cd /repo && git commit -m 'x'")).toBeDefined();
  });
  test("read-only chained with mutating is gated", () => {
    expect(matchesBashGate("git status; git push")).toBeDefined();
  });
  test("commit nested in a command substitution is gated", () => {
    expect(matchesBashGate("echo $(git commit -m x)")).toBeDefined();
  });
  test("fully read-only chain stays ungated", () => {
    expect(matchesBashGate("git status && git log && git diff")).toBeUndefined();
  });
  // regression (code-review): the offending command on a line after the first,
  // or backgrounded with a single `&`, must still be gated.
  test("mutating command on a newline (line 2) is gated", () => {
    expect(matchesBashGate("cd /repo\ngit push --force origin main")).toBeDefined();
  });
  test("mutating command backgrounded with single & is gated", () => {
    expect(matchesBashGate("true & git reset --hard origin/main")).toBeDefined();
  });
  test("multi-line fully read-only chain stays ungated", () => {
    expect(matchesBashGate("ls -la\ngit status\npwd")).toBeUndefined();
  });
});

describe("isReadOnlyGhApi - gh api method resolution", () => {
  test("non-gh-api segments are never read-only gh api", () => {
    expect(isReadOnlyGhApi("git status")).toBe(false);
    expect(isReadOnlyGhApi("gh pr list")).toBe(false);
    expect(isReadOnlyGhApi("gh")).toBe(false);
  });
  test("explicit GET wins even with fields (they become query params)", () => {
    expect(isReadOnlyGhApi("gh api -X GET search/code -f q=x -f per_page=5")).toBe(true);
  });
  test("fields without an explicit method mean POST", () => {
    expect(isReadOnlyGhApi("gh api repos/o/r/issues -f title=x")).toBe(false);
    expect(isReadOnlyGhApi("gh api repos/o/r/issues --raw-field body=x")).toBe(false);
    expect(isReadOnlyGhApi("gh api repos/o/r/issues --field=title=x")).toBe(false);
  });
  test("compound segments are handled by the gate", () => {
    expect(matchesBashGate("cd /r && gh api -X GET repos/o/r")).toBeUndefined();
    expect(matchesBashGate("gh api -X GET repos/o/r; gh api -X DELETE repos/o/r")).toBeDefined();
    expect(matchesBashGate("echo $(gh api -X GET rate_limit --jq .rate.remaining)")).toBeUndefined();
  });
});

describe("classifyBashCommand", () => {
  test("gated command returns reason + matched pattern source", () => {
    const d = classifyBashCommand("git push --force");
    expect(d.gated).toBe(true);
    expect(d.reason).toContain("Mutating git/gh command");
    expect(d.matched).toBeTruthy();
  });
  test("benign command is not gated and carries no reason", () => {
    const d = classifyBashCommand("git status");
    expect(d.gated).toBe(false);
    expect(d.reason).toBeUndefined();
  });
  test("empty / non-string input is not gated", () => {
    expect(classifyBashCommand("").gated).toBe(false);
    // @ts-expect-error deliberately wrong type
    expect(classifyBashCommand(undefined).gated).toBe(false);
  });
});

describe("matchesGitInternal + classifyWritePath - .git internals", () => {
  const INTERNAL = [
    ".git/config",
    ".git/COMMIT_EDITMSG",
    "/repo/.git/hooks/pre-commit",
    "repo/.git/refs/heads/main",
    ".git",
    "/a/b/.git",
  ];
  for (const p of INTERNAL) {
    test(`gates .git path: ${p}`, () => {
      expect(matchesGitInternal(p)).toBe(true);
      const d = classifyWritePath(p);
      expect(d.gated).toBe(true);
      expect(d.reason).toContain(".git internals");
    });
  }

  const SAFE = [
    "src/index.ts",
    "README.md",
    "/repo/gitignore",
    "digital.txt", // 'git' substring but not a .git dir
    ".github/workflows/ci.yml",
  ];
  for (const p of SAFE) {
    test(`allows non-.git path: ${p}`, () => {
      expect(matchesGitInternal(p)).toBe(false);
      expect(classifyWritePath(p).gated).toBe(false);
    });
  }

  test("empty path is not gated", () => {
    expect(classifyWritePath("").gated).toBe(false);
  });
});
