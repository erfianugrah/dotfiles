/**
 * Unit tests for lib/dangerous-cmd-guard-core.ts.
 *
 * Run: ./.pi/agent/tests/run.sh dangerous-cmd-guard
 */

import { describe, expect, test } from "bun:test";

import {
  classifyBashCommand,
  isScratchPath,
  normalizePath,
  tokenize,
  unwrapPrefixes,
  type GuardEnv,
} from "../extensions/lib/dangerous-cmd-guard-core.ts";

const ENV: GuardEnv = { cwd: "/home/erfi/work/repo", home: "/home/erfi" };

function rule(cmd: string, env: GuardEnv = ENV): string | null {
  const d = classifyBashCommand(cmd, env);
  return d.dangerous ? (d.rule ?? null) : null;
}

function tier(cmd: string, env: GuardEnv = ENV): string | null {
  const d = classifyBashCommand(cmd, env);
  return d.dangerous ? (d.tier ?? null) : null;
}

describe("tokenize", () => {
  test("splits on whitespace and strips quotes", () => {
    expect(tokenize('rm -rf "$HOME"/x y').map((t) => t.text)).toEqual(["rm", "-rf", "$HOME/x", "y"]);
  });

  test("single quotes are literal", () => {
    expect(tokenize("rm -rf 'a b'").map((t) => t.text)).toEqual(["rm", "-rf", "a b"]);
  });

  test("tracks unquoted glob chars only", () => {
    const toks = tokenize("rm -rf '*' foo/*");
    expect(toks[2].glob).toBe(false); // quoted * is literal
    expect(toks[3].glob).toBe(true);
  });

  test("backslash escapes", () => {
    expect(tokenize("rm -rf a\\ b").map((t) => t.text)).toEqual(["rm", "-rf", "a b"]);
  });
});

describe("normalizePath", () => {
  test("expands ~ and $HOME", () => {
    expect(normalizePath("~", ENV)).toBe("/home/erfi");
    expect(normalizePath("~/infra/ai", ENV)).toBe("/home/erfi/infra/ai");
    expect(normalizePath("$HOME", ENV)).toBe("/home/erfi");
    expect(normalizePath("${HOME}/x", ENV)).toBe("/home/erfi/x");
  });

  test("absolutizes against cwd and resolves dot segments", () => {
    expect(normalizePath(".", ENV)).toBe("/home/erfi/work/repo");
    expect(normalizePath("./dist", ENV)).toBe("/home/erfi/work/repo/dist");
    expect(normalizePath("../other", ENV)).toBe("/home/erfi/work/other");
    expect(normalizePath("/a/b/../c/", ENV)).toBe("/a/c");
  });
});

describe("unwrapPrefixes", () => {
  const texts = (s: string) => unwrapPrefixes(tokenize(s)).map((t) => t.text);

  test("strips sudo and its value flags", () => {
    expect(texts("sudo rm -rf /")).toEqual(["rm", "-rf", "/"]);
    expect(texts("sudo -u root rm -rf /")).toEqual(["rm", "-rf", "/"]);
  });

  test("strips env assignments and stacked prefixes", () => {
    expect(texts("FOO=bar rm -rf /")).toEqual(["rm", "-rf", "/"]);
    expect(texts("env FOO=bar rm -rf /")).toEqual(["rm", "-rf", "/"]);
    expect(texts("sudo nice -n 5 rm -rf /")).toEqual(["rm", "-rf", "/"]);
  });
});

describe("rm - critical tier", () => {
  test("rm -rf / is critical", () => {
    expect(rule("rm -rf /")).toBe("rm_root");
    expect(tier("rm -rf /")).toBe("critical");
  });

  test("rm -rf /* is critical", () => {
    expect(rule("rm -rf /*")).toBe("rm_root");
  });

  test("rm -rf --no-preserve-root / is critical", () => {
    expect(rule("rm -rf --no-preserve-root /")).toBe("rm_no_preserve_root");
  });

  test("rm -rf on home (all spellings) is critical", () => {
    expect(rule("rm -rf ~")).toBe("rm_home");
    expect(rule("rm -rf ~/")).toBe("rm_home");
    expect(rule("rm -rf $HOME")).toBe("rm_home");
    expect(rule('rm -rf "$HOME"')).toBe("rm_home");
    expect(rule("rm -rf /home/erfi")).toBe("rm_home");
    expect(rule("rm -rf ~/*")).toBe("rm_home");
  });

  test("rm -rf on the cwd itself is critical", () => {
    expect(rule("rm -rf .")).toBe("rm_cwd_wipe");
    expect(rule("rm -rf ./")).toBe("rm_cwd_wipe");
    expect(rule("rm -rf *")).toBe("rm_cwd_wipe");
    expect(rule("rm -rf ./*")).toBe("rm_cwd_wipe");
    expect(rule("rm -rf /home/erfi/work/repo")).toBe("rm_cwd_wipe");
  });

  test("sudo-wrapped and compound forms still classify", () => {
    expect(rule("sudo rm -rf /")).toBe("rm_root");
    expect(rule("cd /tmp && rm -rf ~")).toBe("rm_home");
    expect(rule("ls; rm -rf /")).toBe("rm_root");
  });

  test("GNU-style flags after the operand still classify", () => {
    expect(rule("rm / -rf")).toBe("rm_root");
  });
});

describe("rm - confirm tier (the 2026-08 incident shape)", () => {
  test("rm -rf on a real dir under home prompts", () => {
    expect(rule("rm -rf ~/infra/ai")).toBe("rm_recursive");
    expect(tier("rm -rf ~/infra/ai")).toBe("confirm");
  });

  test("rm -rf on relative non-scratch paths prompts", () => {
    expect(rule("rm -rf src")).toBe("rm_recursive");
    expect(rule("rm -rf ../sibling-repo")).toBe("rm_recursive");
  });

  test("rm -r without -f still prompts", () => {
    expect(rule("rm -r ~/work/repo/data")).toBe("rm_recursive");
  });

  test("rm --recursive prompts", () => {
    expect(rule("rm --recursive --force ~/work/repo/data")).toBe("rm_recursive");
  });

  test("glob with a non-scratch static prefix prompts", () => {
    expect(rule("rm -rf ~/work/*")).toBe("rm_recursive_glob");
  });
});

describe("rm - scratch allowlist (safe)", () => {
  test("/tmp and friends are safe", () => {
    expect(rule("rm -rf /tmp/scratch")).toBeNull();
    expect(rule("rm -rf /var/tmp/x")).toBeNull();
    expect(rule("rm -rf /dev/shm/x")).toBeNull();
    expect(rule("rm -rf /tmp/foo/*")).toBeNull();
  });

  test("build-artifact basenames are safe", () => {
    expect(rule("rm -rf node_modules")).toBeNull();
    expect(rule("rm -rf ./dist")).toBeNull();
    expect(rule("rm -rf packages/web/build")).toBeNull();
    expect(rule("rm -rf target")).toBeNull();
    expect(rule("rm -rf .next")).toBeNull();
    expect(rule("rm -rf ~/.cache/pip")).toBeNull();
  });

  test("non-recursive rm is safe", () => {
    expect(rule("rm file.txt")).toBeNull();
    expect(rule("rm -f a b c")).toBeNull();
  });

  test("rm-looking strings inside other commands are safe", () => {
    expect(rule('echo "rm -rf ~"')).toBeNull();
    expect(rule("git commit -m 'rm -rf /'")).toBeNull();
    expect(rule("grep -rn 'rm -rf' src/")).toBeNull();
  });
});

describe("block-device and filesystem destruction - critical", () => {
  test("dd to a disk device", () => {
    expect(rule("dd if=/dev/zero of=/dev/sda")).toBe("dd_disk");
    expect(rule("dd if=img.iso of=/dev/nvme0n1")).toBe("dd_disk");
    expect(rule("dd if=/dev/zero of=/tmp/file")).toBeNull();
  });

  test("mkfs / wipefs / mkswap", () => {
    expect(rule("mkfs.ext4 /dev/sda1")).toBe("mkfs");
    expect(rule("wipefs -a /dev/sda")).toBe("mkfs");
  });

  test("redirect to a disk device", () => {
    expect(rule("cat x > /dev/sda")).toBe("redirect_disk");
  });

  test("shred on a device", () => {
    expect(rule("shred /dev/sdb")).toBe("shred_disk");
    expect(rule("shred -u secret.txt")).toBeNull();
  });

  test("fork bomb", () => {
    expect(rule(":(){ :|:& };:")).toBe("fork_bomb");
  });

  test("recursive chmod/chown on / or ~", () => {
    expect(rule("chmod -R 777 /")).toBe("recursive_perm_root");
    expect(rule("chown -R user:user ~")).toBe("recursive_perm_root");
    expect(rule("chmod -R 755 ./src")).toBeNull();
    expect(rule("chmod 644 file")).toBeNull();
  });
});

describe("confirm tier - other rules", () => {
  test("unfiltered find -delete prompts; scoped is safe", () => {
    expect(rule("find ~/work -delete")).toBe("find_delete");
    expect(rule("find . -name '*.log' -delete")).toBeNull();
    expect(rule("find /tmp -delete")).toBeNull();
  });

  test("find / -delete and find ~ -delete are critical", () => {
    expect(rule("find / -delete")).toBe("find_delete_root");
    expect(rule("find ~ -delete")).toBe("find_delete_home");
  });

  test("xargs rm -rf prompts", () => {
    expect(rule("ls | xargs rm -rf")).toBe("xargs_rm_recursive");
    expect(rule("printf 'a\\0' | xargs -0 rm -rf")).toBe("xargs_rm_recursive");
    expect(rule("ls | xargs rm")).toBeNull();
    expect(rule("ls | xargs echo")).toBeNull();
  });

  test("partition tools prompt", () => {
    expect(rule("fdisk /dev/sda")).toBe("partition_tool");
    expect(rule("parted /dev/sda print")).toBe("partition_tool");
  });

  test("power cycle prompts", () => {
    expect(rule("shutdown -h now")).toBe("power_cycle");
    expect(rule("sudo reboot")).toBe("power_cycle");
    expect(rule("systemctl poweroff")).toBe("power_cycle");
    expect(rule("systemctl restart caddy")).toBeNull();
  });
});

describe("compound commands", () => {
  test("critical wins over confirm regardless of position", () => {
    const d = classifyBashCommand("rm -rf ~/work/x && rm -rf /", ENV);
    expect(d.tier).toBe("critical");
    expect(d.rule).toBe("rm_root");
  });

  test("safe segments around a dangerous one still classify", () => {
    expect(rule("ls -la && rm -rf ~/infra/ai && echo done")).toBe("rm_recursive");
  });

  test("empty command is safe", () => {
    expect(rule("")).toBeNull();
  });
});

describe("isScratchPath", () => {
  test("prefixes and basenames", () => {
    expect(isScratchPath("/tmp/x", ENV.home)).toBe(true);
    expect(isScratchPath("/home/erfi/.cache/y", ENV.home)).toBe(true);
    expect(isScratchPath("/home/erfi/work/repo/dist", ENV.home)).toBe(true);
    expect(isScratchPath("/home/erfi/infra/ai", ENV.home)).toBe(false);
    expect(isScratchPath("/home/erfi", ENV.home)).toBe(false);
  });
});
