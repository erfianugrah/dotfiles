/**
 * cd-agents-reload-core unit tests - pure, no harness, no filesystem (fsExists
 * and readFile are injected). Covers cd-target extraction, tilde expansion,
 * the AGENTS.md/CLAUDE.md decision, bounded head rendering, and the
 * harness-agnostic orchestrator (decideForCommand) that both the pi adapter
 * and the Claude Code hook drive.
 *
 *   bun test extensions/tests/cd-agents-reload-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  buildInjection,
  buildStartupSet,
  decideForCommand,
  decideTarget,
  expandTilde,
  extractCdTargets,
  MAX_HEAD_LINES,
  readHead,
} from "../lib/cd-agents-reload-core.ts";

describe("extractCdTargets", () => {
  test("plain cd at start of command", () => {
    expect(extractCdTargets("cd /home/erfi/whisper-transcribe && docker compose up")).toEqual([
      "/home/erfi/whisper-transcribe",
    ]);
  });
  test("home-shortcut + chained + semicolon", () => {
    expect(extractCdTargets("cd ~/a && x && cd ~/b")).toEqual(["~/a", "~/b"]);
    expect(extractCdTargets("cd /tmp/foo; cd /tmp/bar")).toEqual(["/tmp/foo", "/tmp/bar"]);
  });
  test("quoted targets with spaces", () => {
    expect(extractCdTargets("cd '/home/erfi/has space/repo' && ls")).toEqual([
      "/home/erfi/has space/repo",
    ]);
    expect(extractCdTargets('cd "/home/erfi/has space/repo" && ls')).toEqual([
      "/home/erfi/has space/repo",
    ]);
  });
  test("skips cd with no arg / cd - / cd / / cd $VAR", () => {
    expect(extractCdTargets("cd && ls")).toEqual([]);
    expect(extractCdTargets("cd - && pwd")).toEqual([]);
    expect(extractCdTargets("cd / && ls")).toEqual([]);
    expect(extractCdTargets("cd $HOME && ls")).toEqual([]);
    expect(extractCdTargets('cd "$REPO_ROOT" && make')).toEqual([]);
  });
  test("no real cd -> empty (echo cd is not a cd)", () => {
    expect(extractCdTargets("ls -la")).toEqual([]);
    expect(extractCdTargets("echo cd /tmp/foo")).toEqual([]);
  });
});

describe("expandTilde", () => {
  test("bare ~ and ~/x expand; absolute + relative unchanged", () => {
    expect(expandTilde("~")).not.toContain("~");
    expect(expandTilde("~/repo").endsWith("/repo")).toBe(true);
    expect(expandTilde("/abs/path")).toBe("/abs/path");
    expect(expandTilde("rel/path")).toBe("rel/path");
  });
});

describe("buildStartupSet", () => {
  test("contains cwd and every ancestor up to root", () => {
    const s = buildStartupSet("/home/erfi/dotfiles");
    expect(s.has("/home/erfi/dotfiles")).toBe(true);
    expect(s.has("/home/erfi")).toBe(true);
    expect(s.has("/home")).toBe(true);
    expect(s.has("/")).toBe(true);
  });
});

describe("decideTarget", () => {
  const startupLoaded = new Set(["/home/erfi/dotfiles", "/home/erfi", "/"]);
  test("skips ancestor already loaded at startup", () => {
    expect(
      decideTarget({ target: "/home/erfi", startupLoaded, alreadyWarned: new Set(), fsExists: () => true }),
    ).toBeNull();
  });
  test("skips already-warned target", () => {
    expect(
      decideTarget({
        target: "/x/repo",
        startupLoaded,
        alreadyWarned: new Set(["/x/repo"]),
        fsExists: () => true,
      }),
    ).toBeNull();
  });
  test("prefers AGENTS.md, falls back to CLAUDE.md, null when neither", () => {
    const t = "/x/repo";
    expect(
      decideTarget({ target: t, startupLoaded, alreadyWarned: new Set(), fsExists: () => true }),
    ).toBe(`${t}/AGENTS.md`);
    expect(
      decideTarget({
        target: t,
        startupLoaded,
        alreadyWarned: new Set(),
        fsExists: (p) => p === `${t}/CLAUDE.md`,
      }),
    ).toBe(`${t}/CLAUDE.md`);
    expect(
      decideTarget({ target: t, startupLoaded, alreadyWarned: new Set(), fsExists: () => false }),
    ).toBeNull();
  });
});

describe("readHead (bounded, injectable read)", () => {
  test("returns full body when short", () => {
    const body = "line1\nline2\nline3";
    expect(readHead("/x/AGENTS.md", () => body)).toBe(body);
  });
  test("truncates past the line cap and annotates", () => {
    const total = MAX_HEAD_LINES + 40;
    const body = Array.from({ length: total }, (_, i) => `L${i}`).join("\n");
    const head = readHead("/x/AGENTS.md", () => body);
    expect(head).toContain(`full file is ${total} lines`);
    expect(head).toContain("L0");
    expect(head).not.toContain(`L${total - 1}`);
  });
  test("read error -> empty string (guard no-fires)", () => {
    expect(
      readHead("/x/AGENTS.md", () => {
        throw new Error("ENOENT");
      }),
    ).toBe("");
  });
});

describe("buildInjection", () => {
  const msg = buildInjection({
    target: "/home/erfi/whisper-transcribe",
    startupCwd: "/home/erfi/dotfiles",
    agentsPath: "/home/erfi/whisper-transcribe/AGENTS.md",
    head: "# Rules\nUse make build",
    rerunFullNotice: "RERUN-NOTICE-SENTINEL",
  });
  test("names the target dir, the file, and embeds the head + notice", () => {
    expect(msg).toContain("cd'd into /home/erfi/whisper-transcribe");
    expect(msg).toContain("AGENTS.md");
    expect(msg).toContain("Use make build");
    expect(msg).toContain("RERUN-NOTICE-SENTINEL");
    expect(msg).toContain("fires once per target dir per session");
  });
  test("omits the notice when not provided", () => {
    const m2 = buildInjection({
      target: "/x",
      startupCwd: "/y",
      agentsPath: "/x/CLAUDE.md",
      head: "hi",
    });
    expect(m2).not.toContain("RERUN-NOTICE-SENTINEL");
    expect(m2).toContain("/x/CLAUDE.md");
  });
});

describe("decideForCommand (orchestrator)", () => {
  const startupCwd = "/home/erfi/dotfiles";
  const startupLoaded = buildStartupSet(startupCwd);

  test("fires on a cd into a repo with AGENTS.md; marks warned (once-per-dir)", () => {
    const warned = new Set<string>();
    const opts = {
      command: "cd /home/erfi/whisper-transcribe && make build",
      startupCwd,
      startupLoaded,
      alreadyWarned: warned,
      fsExists: (p: string) => p === "/home/erfi/whisper-transcribe/AGENTS.md",
      readFile: () => "# Project rules\nUse `make build` not docker compose",
      rerunFullNotice: "NOTICE",
    };
    const first = decideForCommand(opts);
    expect(first).not.toBeNull();
    expect(first!.target).toBe("/home/erfi/whisper-transcribe");
    expect(first!.agentsPath).toBe("/home/erfi/whisper-transcribe/AGENTS.md");
    expect(first!.message).toContain("Use `make build`");
    expect(warned.has("/home/erfi/whisper-transcribe")).toBe(true);

    // second identical call is suppressed (already warned)
    expect(decideForCommand(opts)).toBeNull();
  });

  test("no-op when command has no cd", () => {
    expect(
      decideForCommand({
        command: "docker compose up -d",
        startupCwd,
        startupLoaded,
        alreadyWarned: new Set(),
        fsExists: () => true,
        readFile: () => "x",
      }),
    ).toBeNull();
  });

  test("no-op when cd target has no instruction file", () => {
    expect(
      decideForCommand({
        command: "cd /home/erfi/plain-dir && ls",
        startupCwd,
        startupLoaded,
        alreadyWarned: new Set(),
        fsExists: () => false,
        readFile: () => "x",
      }),
    ).toBeNull();
  });

  test("skips ancestor already loaded at startup", () => {
    expect(
      decideForCommand({
        command: "cd /home/erfi && ls",
        startupCwd,
        startupLoaded,
        alreadyWarned: new Set(),
        fsExists: () => true,
        readFile: () => "x",
      }),
    ).toBeNull();
  });

  test("empty head (read failure) marks warned but does not fire", () => {
    const warned = new Set<string>();
    const res = decideForCommand({
      command: "cd /home/erfi/repo && ls",
      startupCwd,
      startupLoaded,
      alreadyWarned: warned,
      fsExists: () => true,
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(res).toBeNull();
    expect(warned.has("/home/erfi/repo")).toBe(true);
  });
});

// Regression: the dotfiles AGENTS.md stow rule must stay inside the injected
// head. It is the rule that prevents shipping an unlinked (dead) extension,
// and it was originally at line ~225 - far below the 80-line/4000-char cap -
// which is why the 2026-08-27 ai-tell-guard incident happened at all. If a
// future edit pushes it back below the cut, this fails.
describe("dotfiles AGENTS.md: stow rule survives head truncation", () => {
  const path = `${process.env.HOME}/dotfiles/AGENTS.md`;

  test("the stow-link + verify rule is in the injected head", () => {
    const head = readHead(path);
    if (!head) return; // not on a dotfiles machine; nothing to assert
    for (const probe of ["stow-linked", "stow-drift", "UNLINKED", "stow -d ~/dotfiles"]) {
      expect(head).toContain(probe);
    }
  });
});
