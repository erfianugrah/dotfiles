/**
 * dangerous-cmd-guard-core - pure classifier for destructive shell commands.
 * ZERO harness imports (node stdlib + globals only). Source of truth for both
 * the pi adapter (../dangerous-cmd-guard.ts, block/prompt tool_call hook) and
 * the Claude Code hook (../../../.claude/hooks/dangerous-cmd-guard.ts,
 * PreToolUse deny).
 *
 * Born from the 2026-08 incident: an agent typo'd a path while authoring a
 * file, then "cleaned up" with `rm -rf ~/infra/ai` in the SAME compound
 * command as its verification steps - recursively deleting the working trees
 * of three real repos. Prompt rules did not stop it; a runtime gate does.
 *
 * Two tiers:
 *
 *   critical - always block, no prompt, even with a UI. Catastrophic and
 *     never legitimate in agent work: recursive rm on `/` / $HOME / the cwd
 *     itself, `--no-preserve-root`, cwd-wipe globs, block-device writes
 *     (dd of=/dev/..., mkfs, wipefs, > /dev/sdX), fork bombs, recursive
 *     chmod/chown on `/` or $HOME.
 *
 *   confirm - the harness decides: pi prompts via ctx.ui.select (blocks
 *     headless), CC denies with the reason. Recursive rm on any path outside
 *     the scratch allowlist (the ~/infra/ai case), unfiltered
 *     `find <path> -delete`, `xargs rm -r`, power-cycle commands, disk
 *     partition tools.
 *
 * Scratch allowlist (recursive rm is routine, no prompt): /tmp, /var/tmp,
 * /dev/shm, /private/tmp, ~/.cache, and build-artifact basenames
 * (node_modules, dist, build, target, ...). Deliberately narrow - anything
 * under $HOME that is not a known build artifact prompts.
 *
 * Kill switch: DANGEROUS_CMD_GUARD_OFF=1 (checked by the adapters).
 */

import { splitCommandSegments } from "./git-gh-gate-core.ts";

export type DangerTier = "critical" | "confirm";

export interface DangerDecision {
  dangerous: boolean;
  tier?: DangerTier;
  /** stable rule id, e.g. "rm_home" - useful for tests and logging. */
  rule?: string;
  /** human-readable explanation for the block/prompt. */
  reason?: string;
  /** the offending segment or target, for display. */
  matched?: string;
}

export interface GuardEnv {
  cwd: string;
  home: string;
}

const SAFE: DangerDecision = { dangerous: false };

// -- scratch allowlist --------------------------------------------------------

const SCRATCH_PREFIXES = [
  "/tmp",
  "/var/tmp",
  "/dev/shm",
  "/private/tmp",
  "/private/var/tmp",
];

// Build artifacts whose recursive deletion is routine. Matched against the
// FINAL path component only, so `rm -rf ./dist` and `rm -rf foo/node_modules`
// pass but `rm -rf ~/work` does not.
const SCRATCH_BASENAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target", // rust
  "tmp",
  "temp",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".output",
  ".vercel",
  ".wrangler",
  ".svelte-kit",
  ".astro",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".parcel-cache",
]);

export function isScratchPath(normalized: string, home: string): boolean {
  for (const pre of SCRATCH_PREFIXES) {
    if (normalized === pre || normalized.startsWith(pre + "/")) return true;
  }
  const cache = home + "/.cache";
  if (normalized === cache || normalized.startsWith(cache + "/")) return true;
  const base = normalized.split("/").pop() ?? "";
  return SCRATCH_BASENAMES.has(base);
}

// -- shell-ish tokenizer ------------------------------------------------------

export interface Token {
  text: string;
  /** true when the token contains an UNQUOTED glob char (* ? [). */
  glob: boolean;
}

/**
 * Tokenize one command segment. Handles single/double quotes and backslash
 * escapes well enough for flag/target extraction - NOT a full shell parser.
 * Quote removal is applied, so `rm -rf "$HOME"/x` yields the token `$HOME/x`.
 */
export function tokenize(segment: string): Token[] {
  const tokens: Token[] = [];
  let cur = "";
  let glob = false;
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < segment.length && '"\\$'.includes(segment[i + 1])) {
        cur += segment[++i];
      } else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (c === "\\" && i + 1 < segment.length) {
      cur += segment[++i];
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started || cur.length > 0) tokens.push({ text: cur, glob });
      cur = "";
      glob = false;
      started = false;
      continue;
    }
    if (c === "*" || c === "?" || c === "[") glob = true;
    cur += c;
    started = true;
  }
  if (started || cur.length > 0) tokens.push({ text: cur, glob });
  return tokens;
}

// -- path normalization (pure, lexical - no fs) --------------------------------

/**
 * Expand `~` / `$HOME` / `${HOME}`, absolutize against cwd, and resolve
 * `.` / `..` lexically. Never touches the filesystem.
 */
export function normalizePath(p: string, env: GuardEnv): string {
  let s = p;
  if (s === "~" || s.startsWith("~/")) s = env.home + s.slice(1);
  s = s.replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, env.home);
  if (!s.startsWith("/")) {
    s = env.cwd.replace(/\/+$/, "") + "/" + s;
  }
  const out: string[] = [];
  for (const part of s.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

// -- command-prefix unwrapping -------------------------------------------------

// Prefix flags that consume the NEXT token as their value (sudo -u root,
// nice -n 5, ...).
const PREFIX_VALUE_FLAGS = new Set(["-u", "-g", "-p", "-C", "-T", "-t", "-U", "-h", "-r", "-A", "-n"]);
const BARE_PREFIXES = new Set(["sudo", "doas", "command", "builtin", "exec", "nice", "time", "env"]);

/**
 * Strip leading env assignments (FOO=bar) and command prefixes
 * (sudo/doas/command/nice/time/...) so `sudo rm -rf /` classifies as rm.
 * Returns the remaining tokens (may be empty).
 */
export function unwrapPrefixes(tokens: Token[]): Token[] {
  let i = 0;
  // Leading VAR=value assignments + command prefixes, possibly repeated
  // (`sudo nice rm ...`, `env FOO=bar rm ...`).
  let progressed = true;
  while (progressed && i < tokens.length) {
    progressed = false;
    const t = tokens[i].text;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      progressed = true;
      continue;
    }
    const base = t.split("/").pop() ?? t;
    if (BARE_PREFIXES.has(base)) {
      i++;
      progressed = true;
      // Skip flags belonging to the prefix (sudo -E, sudo -u root, nice -n 5).
      while (i < tokens.length && tokens[i].text.startsWith("-")) {
        const f = tokens[i].text;
        i++;
        if (PREFIX_VALUE_FLAGS.has(f) && i < tokens.length) i++;
        if (f === "--") break;
      }
    }
  }
  return tokens.slice(i);
}

// -- rm classification ----------------------------------------------------------

interface RmParse {
  recursive: boolean;
  noPreserveRoot: boolean;
  targets: Token[];
}

function parseRm(tokens: Token[]): RmParse {
  let recursive = false;
  let noPreserveRoot = false;
  const targets: Token[] = [];
  let flagsDone = false; // only `--` ends flag parsing; GNU rm takes flags anywhere
  for (const tok of tokens) {
    const t = tok.text;
    if (!flagsDone && t === "--") {
      flagsDone = true;
      continue;
    }
    if (!flagsDone && t.startsWith("-") && t.length > 1) {
      if (t === "--recursive") recursive = true;
      else if (t === "--no-preserve-root") noPreserveRoot = true;
      else if (t.startsWith("--")) {
        // --force, --verbose, --interactive, ... : no danger signal
      } else {
        // Combined short flags: -rf, -fr, -R -f, ...
        if (/[rR]/.test(t)) recursive = true;
      }
      continue;
    }
    targets.push(tok);
  }
  return { recursive, noPreserveRoot, targets };
}

function critical(rule: string, matched: string, reason: string): DangerDecision {
  return { dangerous: true, tier: "critical", rule, matched, reason };
}

function confirm(rule: string, matched: string, reason: string): DangerDecision {
  return { dangerous: true, tier: "confirm", rule, matched, reason };
}

function classifyRmTargets(parse: RmParse, env: GuardEnv, segment: string): DangerDecision {
  if (parse.noPreserveRoot && parse.recursive) {
    return critical(
      "rm_no_preserve_root",
      segment.trim(),
      "rm with --no-preserve-root opts OUT of the last safety check on `/`. " +
        "This is never legitimate in agent work. Blocked unconditionally.",
    );
  }
  if (parse.targets.length === 0) return SAFE;

  let sawConfirm: DangerDecision | null = null;
  for (const target of parse.targets) {
    const raw = target.text;
    // Glob targets: unquoted * ? [ - classify by the static prefix.
    if (target.glob) {
      const prefix = raw.split(/[*?[]/, 1)[0];
      const normPrefix = normalizePath(prefix.replace(/\/+$/, "") || ".", env);
      if (prefix.startsWith("/") && (prefix === "/" || prefix === "/*")) {
        return critical("rm_root", segment.trim(), "Recursive rm with a root glob (`/*`) wipes the filesystem. Blocked unconditionally.");
      }
      if (normPrefix === "/") {
        return critical("rm_root", segment.trim(), `Recursive rm glob "${raw}" resolves to the filesystem root. Blocked unconditionally.`);
      }
      if (normPrefix === env.home) {
        return critical("rm_home", segment.trim(), `Recursive rm glob "${raw}" resolves to your HOME directory. Blocked unconditionally.`);
      }
      if (normPrefix === env.cwd || prefix === "" || prefix === "." || prefix === "./") {
        return critical("rm_cwd_wipe", segment.trim(), `Recursive rm glob "${raw}" wipes the current working directory (${env.cwd}). Blocked unconditionally.`);
      }
      if (isScratchPath(normPrefix, env.home)) continue; // rm -rf /tmp/x/* is routine
      sawConfirm ??= confirm(
        "rm_recursive_glob",
        segment.trim(),
        `Recursive rm with glob "${raw}" - the match set is computed by the shell, not reviewable beforehand. ` +
          "List the matches first (ls/printf the same glob) or delete exact paths.",
      );
      continue;
    }

    const norm = normalizePath(raw, env);
    if (norm === "/") {
      return critical("rm_root", segment.trim(), "Recursive rm on `/` wipes the filesystem. Blocked unconditionally.");
    }
    if (norm === env.home) {
      return critical(
        "rm_home",
        segment.trim(),
        `Recursive rm on your HOME directory (${env.home}) - every dotfile, repo checkout and credential. Blocked unconditionally.`,
      );
    }
    if (norm === env.cwd) {
      return critical(
        "rm_cwd_wipe",
        segment.trim(),
        `Recursive rm on the current working directory itself (${env.cwd}). Blocked unconditionally - ` +
          "if you mean the contents, say so explicitly and list them first.",
      );
    }
    if (isScratchPath(norm, env.home)) continue;
    sawConfirm ??= confirm(
      "rm_recursive",
      segment.trim(),
      `Recursive rm on "${raw}" (resolves to ${norm}) - outside the scratch allowlist (/tmp, build artifacts). ` +
        "This is the exact shape of the 2026-08 ~/infra/ai data-loss incident: a wrong path plus rm -rf in one shot. " +
        "Verify the path exists and is the one you mean (ls it first), and prefer moving to /tmp over deleting.",
    );
  }
  return sawConfirm ?? SAFE;
}

// -- segment-level classification ------------------------------------------------

const DISK_DEV = String.raw`(?:sd[a-z]+|nvme\d+n\d+(?:p\d+)?|mmcblk\d+(?:p\d+)?|vd[a-z]+|xvd[a-z]+|disk\d+|loop\d+)`;

function classifySegment(segment: string, env: GuardEnv): DangerDecision {
  const tokens = unwrapPrefixes(tokenize(segment));
  if (tokens.length === 0) return SAFE;
  const cmd = tokens[0].text;
  const cmdBase = cmd.split("/").pop() ?? cmd;

  // Block-device writes.
  if (cmdBase === "dd") {
    const of = tokens.find((t) => t.text.startsWith("of="));
    if (of && new RegExp(`^of=/dev/${DISK_DEV}`).test(of.text)) {
      return critical("dd_disk", segment.trim(), `dd writing directly to a block device (${of.text}). Blocked unconditionally.`);
    }
    return SAFE;
  }
  if (/^mkfs(\.[A-Za-z0-9]+)?$/.test(cmdBase) || cmdBase === "wipefs" || cmdBase === "mkswap") {
    return critical("mkfs", segment.trim(), `${cmdBase} destroys a filesystem signature in place. Blocked unconditionally.`);
  }
  if (new RegExp(`>\\s*/dev/${DISK_DEV}`).test(segment)) {
    return critical("redirect_disk", segment.trim(), "Shell redirect writing raw bytes to a block device. Blocked unconditionally.");
  }
  if (cmdBase === "shred" && tokens.some((t) => new RegExp(`^/dev/${DISK_DEV}`).test(t.text))) {
    return critical("shred_disk", segment.trim(), "shred on a block device. Blocked unconditionally.");
  }
  if (["fdisk", "sfdisk", "parted", "sgdisk", "cfdisk"].includes(cmdBase)) {
    return confirm(
      "partition_tool",
      segment.trim(),
      `${cmdBase} edits partition tables. A wrong device argument is unrecoverable. Confirm the device is intended.`,
    );
  }

  // rm family.
  if (cmdBase === "rm") {
    const parse = parseRm(tokens.slice(1));
    if (!parse.recursive) return SAFE; // single-file rm is routine
    return classifyRmTargets(parse, env, segment);
  }

  // find <paths> ... -delete
  if (cmdBase === "find") {
    const args = tokens.slice(1);
    const hasDelete = args.some((t) => t.text === "-delete");
    if (!hasDelete) return SAFE;
    // Scoped deletion (name/path filter) is routine cleanup - allow.
    const scoped = args.some((t) => ["-name", "-iname", "-path", "-ipath", "-regex"].includes(t.text));
    if (scoped) return SAFE;
    // Paths = tokens before the first expression flag.
    const paths: Token[] = [];
    for (const t of args) {
      if (t.text.startsWith("-") || t.text === "!" || t.text === "(") break;
      paths.push(t);
    }
    const checkPaths = paths.length > 0 ? paths : [{ text: ".", glob: false }];
    for (const p of checkPaths) {
      const norm = normalizePath(p.text, env);
      if (norm === "/") {
        return critical("find_delete_root", segment.trim(), "`find / -delete` walks the whole filesystem deleting everything. Blocked unconditionally.");
      }
      if (norm === env.home) {
        return critical("find_delete_home", segment.trim(), "`find ~ -delete` walks your HOME deleting everything. Blocked unconditionally.");
      }
      if (!isScratchPath(norm, env.home)) {
        return confirm(
          "find_delete",
          segment.trim(),
          `Unfiltered \`find ${p.text} -delete\` removes EVERY file under ${norm} (no -name/-path scope). ` +
            "Add a scope filter or delete exact paths.",
        );
      }
    }
    return SAFE;
  }

  // ... | xargs rm -rf  (targets arrive on stdin - unreviewable)
  if (cmdBase === "xargs") {
    const rest = unwrapPrefixes(argsAfterFlags(tokens.slice(1)));
    if (rest.length > 0 && (rest[0].text === "rm" || rest[0].text.endsWith("/rm"))) {
      const parse = parseRm(rest.slice(1));
      if (parse.recursive) {
        return confirm(
          "xargs_rm_recursive",
          segment.trim(),
          "xargs feeding a recursive rm - the target list comes from stdin and is not reviewable in the command line. " +
            "Echo the list first (xargs without rm, or -t) before deleting.",
        );
      }
    }
    return SAFE;
  }

  // Recursive permission/ownership changes on / or ~.
  if (["chmod", "chown", "chgrp"].includes(cmdBase)) {
    const args = tokens.slice(1);
    const recursive = args.some((t) => t.text.startsWith("-") && /[rR]/.test(t.text));
    if (!recursive) return SAFE;
    for (const t of args) {
      if (t.text.startsWith("-")) continue;
      if (/^\d{3,4}$/.test(t.text) || /^[ugoa]*[+=-][rwxXst]+/.test(t.text)) continue; // mode arg
      if (/^[^/]\+/.test(t.text)) continue;
      const norm = normalizePath(t.text, env);
      if (norm === "/" || norm === env.home) {
        return critical(
          "recursive_perm_root",
          segment.trim(),
          `${cmdBase} -R on ${norm === "/" ? "the filesystem root" : "your HOME directory"} breaks permissions/ownership system-wide. Blocked unconditionally.`,
        );
      }
    }
    return SAFE;
  }

  // Power cycle.
  if (["shutdown", "reboot", "poweroff", "halt"].includes(cmdBase)) {
    return confirm("power_cycle", segment.trim(), `${cmdBase} takes the machine down. Confirm this is intended and not a remote host typo.`);
  }
  if (cmdBase === "systemctl" && tokens.some((t) => ["poweroff", "reboot", "halt", "suspend", "hibernate", "kexec"].includes(t.text))) {
    return confirm("power_cycle", segment.trim(), "systemctl power/reboot/suspend action. Confirm this is intended and not a remote host typo.");
  }

  return SAFE;
}

// xargs' own flags (-0, -I {}, -n 1, -P 4, -t, ...) precede the command it runs.
function argsAfterFlags(tokens: Token[]): Token[] {
  const VALUE_FLAGS = new Set(["-I", "-n", "-P", "-s", "-d", "-L", "-E", "-e", "--max-args", "--max-procs", "--replace", "--delimiter", "--eof", "--max-lines", "--max-chars"]);
  let i = 0;
  while (i < tokens.length && tokens[i].text.startsWith("-")) {
    const f = tokens[i].text;
    i++;
    if (f === "--") break;
    if (VALUE_FLAGS.has(f) && i < tokens.length) i++;
    else if (/^-[InPsLdEe]\S/.test(f) || f.startsWith("--") && f.includes("=")) { /* value inline */ }
  }
  return tokens.slice(i);
}

// -- public entry point -----------------------------------------------------------

/**
 * Classify a (possibly compound) bash command. Pure - no I/O, no harness.
 * The caller decides what "critical" and "confirm" mean (block vs prompt vs
 * deny). Returns the FIRST dangerous segment's decision; critical wins over
 * confirm regardless of position.
 */
export function classifyBashCommand(command: string, env: GuardEnv): DangerDecision {
  if (typeof command !== "string" || command.length === 0) return SAFE;
  // Fork bomb: :(){ :|:& };: (any function name variant). Checked on the FULL
  // command - segment splitting would shred it on the & | ; inside.
  if (/[A-Za-z_:][A-Za-z0-9_:]*\s*\(\s*\)\s*\{[^}]*\|[^}]*&\s*\}/.test(command)) {
    return critical("fork_bomb", command.trim(), "Fork bomb (func(){ func|func& };func). Blocked unconditionally.");
  }
  const segments = splitCommandSegments(command);
  let firstConfirm: DangerDecision | null = null;
  for (const seg of segments) {
    if (!seg.trim()) continue;
    const d = classifySegment(seg, env);
    if (!d.dangerous) continue;
    if (d.tier === "critical") return d;
    firstConfirm ??= d;
  }
  return firstConfirm ?? SAFE;
}
