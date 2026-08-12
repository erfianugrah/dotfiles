/**
 * notify-core unit tests - pure, no harness, no TTY, no subprocess. Covers
 * transport selection across every env branch + the exact bytes/argv each
 * transport produces, so a mis-transcribed OSC sequence or a broken guard
 * fails here.
 *
 *   bun test extensions/tests/notify-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  osc777Bytes,
  osc99Bytes,
  planNotify,
  selectTransport,
  windowsToastScript,
  type NotifyEnv,
} from "../lib/notify-core.ts";

describe("notify-core.selectTransport", () => {
  test("WT_SESSION wins even on a non-TTY (toast writes no stdout)", () => {
    expect(selectTransport({ WT_SESSION: "abc", isTTY: false })).toBe("windows-toast");
    expect(selectTransport({ WT_SESSION: "abc", isTTY: true })).toBe("windows-toast");
  });

  test("non-TTY without WT_SESSION -> skip (protect JSON stream)", () => {
    expect(selectTransport({ isTTY: false })).toBe("skip");
    expect(selectTransport({ KITTY_WINDOW_ID: "1", isTTY: false })).toBe("skip");
  });

  test("TTY + KITTY_WINDOW_ID -> osc99", () => {
    expect(selectTransport({ KITTY_WINDOW_ID: "1", isTTY: true })).toBe("osc99");
  });

  test("TTY, no kitty, no WT -> osc777 default", () => {
    expect(selectTransport({ isTTY: true })).toBe("osc777");
  });

  test("empty env -> skip (isTTY undefined is falsy)", () => {
    expect(selectTransport({})).toBe("skip");
  });
});

describe("notify-core byte builders", () => {
  test("osc777 sequence: ESC ]777;notify;<title>;<body> BEL", () => {
    const b = osc777Bytes("pi", "ready");
    expect(b).toBe("\x1b]777;notify;pi;ready\x07");
    expect(b.endsWith("\x07")).toBe(true); // BEL terminator, not \n
  });

  test("osc99 sequence: two ST-terminated chunks (title, body)", () => {
    const b = osc99Bytes("pi", "ready");
    expect(b).toBe("\x1b]99;i=1:d=0;pi\x1b\\\x1b]99;i=1:p=body;ready\x1b\\");
    expect(b.endsWith("\x1b\\")).toBe(true); // ST terminator
  });

  test("windows toast script embeds title + body and is a single ;-joined line", () => {
    const s = windowsToastScript("myapp", "done");
    expect(s).toContain("Windows.UI.Notifications");
    expect(s).toContain("CreateTextNode('done')");
    expect(s).toContain("CreateToastNotifier('myapp')");
    expect(s.includes("\n")).toBe(false);
  });
});

describe("notify-core.planNotify orchestrator", () => {
  test("osc777 plan carries stdout bytes, no spawn", () => {
    const p = planNotify("pi", "ready for input", { isTTY: true });
    expect(p.transport).toBe("osc777");
    expect(p.stdout).toBe(osc777Bytes("pi", "ready for input"));
    expect(p.spawn).toBeUndefined();
  });

  test("osc99 plan carries kitty bytes", () => {
    const p = planNotify("pi", "ready", { isTTY: true, KITTY_WINDOW_ID: "9" });
    expect(p.transport).toBe("osc99");
    expect(p.stdout).toBe(osc99Bytes("pi", "ready"));
  });

  test("windows-toast plan carries spawn argv, no stdout", () => {
    const p = planNotify("pi", "ready", { WT_SESSION: "x", isTTY: false });
    expect(p.transport).toBe("windows-toast");
    expect(p.stdout).toBeUndefined();
    expect(p.spawn?.file).toBe("powershell.exe");
    expect(p.spawn?.args[0]).toBe("-NoProfile");
    expect(p.spawn?.args[1]).toBe("-Command");
    expect(p.spawn?.args[2]).toBe(windowsToastScript("pi", "ready"));
  });

  test("skip plan is inert: no stdout, no spawn", () => {
    const p = planNotify("pi", "ready", { isTTY: false } as NotifyEnv);
    expect(p.transport).toBe("skip");
    expect(p.stdout).toBeUndefined();
    expect(p.spawn).toBeUndefined();
  });
});
