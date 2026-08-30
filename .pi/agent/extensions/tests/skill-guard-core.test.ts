/**
 * skill-guard-core unit tests - pure, no harness. Covers the three matchers
 * (intent / path / bash), the apply_patch path extractor, the two nudge-text
 * builders, and the harness-agnostic matchToolCall orchestrator that both the
 * pi adapter and the CC hook drive.
 *
 *   bun test extensions/tests/skill-guard-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  matchIntent,
  matchPath,
  matchBash,
  extractPatchPaths,
  intentMessage,
  actionReason,
  matchToolCall,
} from "../lib/skill-guard-core.ts";

describe("skill-guard-core.matchIntent", () => {
  test("fires on a scaffold/new-project prompt", () => {
    const hits = matchIntent("please scaffold a new dashboard for me");
    expect(hits.map((h) => h.id)).toContain("scaffold_new_project");
  });

  test("fires fly + gh when both phrases present", () => {
    const hits = matchIntent("open a PR then fly deploy the app");
    const ids = hits.map((h) => h.id);
    expect(ids).toContain("gh_intent");
    expect(ids).toContain("fly_intent");
  });

  test("empty prompt -> no hits", () => {
    expect(matchIntent("")).toEqual([]);
  });

  test("unrelated prompt -> no hits", () => {
    expect(matchIntent("what is the capital of France")).toEqual([]);
  });

  test("hint carries skill + why", () => {
    const [h] = matchIntent("cut a release");
    expect(h.skill).toBe("gh");
    expect(h.why.length).toBeGreaterThan(0);
  });
});

describe("skill-guard-core.matchPath", () => {
  const CASES: Array<[string, string]> = [
    ["infra/docker-compose.yml", "infrastructure-stack"],
    ["compose.yaml", "infrastructure-stack"],
    ["services/api/Dockerfile", "docker"],
    ["Dockerfile.prod", "docker"],
    ["main.tf", "terraform"],
    ["vars.tfvars", "terraform"],
    ["slides.qmd", "quarto"],
    ["edge/Caddyfile", "caddy"],
  ];
  for (const [p, skill] of CASES) {
    test(`${p} -> ${skill}`, () => {
      expect(matchPath(p)?.skill).toBe(skill);
    });
  }
  test("plain source file -> null", () => {
    expect(matchPath("src/index.ts")).toBeNull();
  });
  test("empty path -> null", () => {
    expect(matchPath("")).toBeNull();
  });
});

describe("skill-guard-core.matchBash", () => {
  const CASES: Array<[string, string]> = [
    ["flyctl deploy", "fly"],
    ["fly secrets set A=b", "fly"],
    ["terraform apply -auto-approve", "terraform"],
    ["tofu plan", "terraform"],
    ["wrangler deploy", "cloudflare"],
    ["supabase db push", "supabase"],
  ];
  for (const [cmd, skill] of CASES) {
    test(`${cmd} -> ${skill}`, () => {
      expect(matchBash(cmd)?.skill).toBe(skill);
    });
  }
  test("plain ls -> null", () => {
    expect(matchBash("ls -la")).toBeNull();
  });
  test("empty command -> null", () => {
    expect(matchBash("")).toBeNull();
  });
});

describe("skill-guard-core.extractPatchPaths", () => {
  test("pulls Add/Update/Delete paths", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: infra/compose.yml",
      "*** Update File: src/index.ts",
      "*** Delete File: old/Dockerfile",
      "*** End Patch",
    ].join("\n");
    expect(extractPatchPaths(patch)).toEqual([
      "infra/compose.yml",
      "src/index.ts",
      "old/Dockerfile",
    ]);
  });

  test("Move File captures both source and destination", () => {
    const patch = "*** Move File: a/Caddyfile -> b/Caddyfile";
    expect(extractPatchPaths(patch)).toEqual(["a/Caddyfile", "b/Caddyfile"]);
  });

  test("empty patch -> []", () => {
    expect(extractPatchPaths("")).toEqual([]);
  });
});

describe("skill-guard-core.message builders", () => {
  test("intentMessage lists each hint with the skills dir and default path", () => {
    const hints = matchIntent("scaffold a new project");
    const msg = intentMessage(hints);
    expect(msg).toContain("skill-guard:");
    expect(msg).toContain("scaffold-new-project/SKILL.md");
    expect(msg).toContain("~/.pi/agent/skills");
  });

  test("intentMessage honors a custom skills dir (CC path)", () => {
    const hints = matchIntent("scaffold a new project");
    const msg = intentMessage(hints, "~/.claude/skills");
    expect(msg).toContain("~/.claude/skills/scaffold-new-project/SKILL.md");
  });

  test("actionReason names the rule id + skill and states the per-context retry rule", () => {
    const hint = matchPath("infra/compose.yml")!;
    const r = actionReason(hint);
    expect(r).toContain("skill-guard[compose_infra]");
    expect(r).toContain("infrastructure-stack");
    // Revised 2026-08-30: nudges are per-context, not once-per-session.
    expect(r).toContain("Retrying this same command passes");
  });

  test("actionReason honors a custom skills dir", () => {
    const hint = matchPath("Dockerfile")!;
    expect(actionReason(hint, "~/.claude/skills")).toContain(
      "~/.claude/skills/docker/SKILL.md",
    );
  });
});

describe("skill-guard-core.matchToolCall (CC orchestrator)", () => {
  test("Write to a Dockerfile -> docker hint", () => {
    const h = matchToolCall("Write", { file_path: "services/Dockerfile", content: "x" });
    expect(h?.skill).toBe("docker");
    expect(h?.id).toBe("dockerfile_docker");
  });

  test("Edit to a .tf file -> terraform hint", () => {
    const h = matchToolCall("Edit", { file_path: "main.tf", new_string: "resource" });
    expect(h?.skill).toBe("terraform");
  });

  test("MultiEdit uses file_path too", () => {
    const h = matchToolCall("MultiEdit", { file_path: "edge/Caddyfile", edits: [] });
    expect(h?.skill).toBe("caddy");
  });

  test("Bash flyctl -> fly hint", () => {
    const h = matchToolCall("Bash", { command: "flyctl deploy" });
    expect(h?.skill).toBe("fly");
  });

  test("Write to a plain file -> null", () => {
    expect(matchToolCall("Write", { file_path: "src/index.ts", content: "x" })).toBeNull();
  });

  test("non-string file_path -> null", () => {
    expect(matchToolCall("Write", { file_path: 42 })).toBeNull();
  });

  test("unhandled tool -> null", () => {
    expect(matchToolCall("Read", { file_path: "Dockerfile" })).toBeNull();
  });
});
