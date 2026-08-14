/**
 * Unit tests for the pure helpers in extensions/lib/pwsh-core.ts.
 *
 * Run: ./.pi/agent/tests/run.sh pwsh-core
 */

import { describe, expect, test } from "bun:test";

import { buildArgs, buildCommand, capStream, renderPwshResult, stripAnsi, type PwshRun } from "../extensions/lib/pwsh-core.ts";

describe("stripAnsi", () => {
  test("removes CSI color and DEC private mode sequences", () => {
    expect(stripAnsi("\x1b[?1h\x1b[?1l\x1b[31;1mboom\x1b[0m")).toBe("boom");
  });
  test("leaves plain text alone", () => {
    expect(stripAnsi("plain $var `tick")).toBe("plain $var `tick");
  });
});

describe("buildArgs", () => {
  test("non-interactive, no profile, script from stdin", () => {
    expect(buildArgs()).toEqual(["-NoProfile", "-NonInteractive", "-Command", "-"]);
  });
});

describe("buildCommand", () => {
  test("local run is plain pwsh", () => {
    expect(buildCommand()).toEqual({
      program: "pwsh",
      args: ["-NoProfile", "-NonInteractive", "-Command", "-"],
    });
  });
  test("remote run wraps in ssh with option-parsing terminator", () => {
    const { program, args } = buildCommand("laplaptop");
    expect(program).toBe("ssh");
    expect(args[0]).toBe("--");
    expect(args[1]).toBe("laplaptop");
    expect(args.slice(2)).toEqual(["pwsh", "-NoProfile", "-NonInteractive", "-Command", "-"]);
  });
});

describe("capStream", () => {
  test("passes through text under the cap", () => {
    expect(capStream("hello", 100)).toBe("hello");
  });
  test("strips ANSI before measuring", () => {
    expect(capStream("\x1b[31mred\x1b[0m", 100)).toBe("red");
  });
  test("keeps head and tail, elides the middle with a marker", () => {
    const text = "H".repeat(50) + "M".repeat(100) + "T".repeat(50);
    const out = capStream(text, 60);
    expect(out).toContain("[elided 140 chars]");
    expect(out.startsWith("H".repeat(30))).toBe(true);
    expect(out.endsWith("T".repeat(30))).toBe(true);
    expect(out).not.toContain("M");
  });
});

function run(over: Partial<PwshRun>): PwshRun {
  return { ok: true, stdout: "", stderr: "", code: 0, binaryMissing: false, timedOut: false, ...over };
}

describe("renderPwshResult", () => {
  test("clean run returns stdout, not an error", () => {
    const r = renderPwshResult(run({ stdout: "42\n" }));
    expect(r.text).toBe("42");
    expect(r.isError).toBeUndefined();
  });
  test("empty output says so", () => {
    expect(renderPwshResult(run({})).text).toBe("(no output)");
  });
  test("non-zero exit is an error and shows the code", () => {
    const r = renderPwshResult(run({ stdout: "x", code: 1 }));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("[exit 1]");
  });
  test("stderr alone is an error (non-terminating PS errors)", () => {
    const r = renderPwshResult(run({ stdout: "ok", stderr: "Write-Error: boom", code: 0 }));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("[stderr]");
    expect(r.text).toContain("Write-Error: boom");
  });
  test("timeout reports partial output and error", () => {
    const r = renderPwshResult(run({ timedOut: true, code: -1, stdout: "partial" }));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("timed out");
    expect(r.text).toContain("partial");
  });
  test("host lands in details", () => {
    const r = renderPwshResult(run({ stdout: "x" }), "laplaptop");
    expect(r.details.host).toBe("laplaptop");
  });
});
