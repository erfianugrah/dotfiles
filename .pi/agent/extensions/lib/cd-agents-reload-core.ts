/**
 * cd-agents-reload-core - pure logic for the "cd into another repo" context
 * gap guard. ZERO harness imports (node stdlib only). Shared by the pi adapter
 * (../cd-agents-reload.ts, a block-only tool_call hook) and the Claude Code
 * hook (../../../.claude/hooks/cd-agents-reload.ts).
 *
 * Both harnesses load AGENTS.md / CLAUDE.md from cwd + parents at session
 * start, but neither re-loads when the agent `cd`s into another repo
 * mid-session. So project-specific instructions in `<other-repo>/AGENTS.md`
 * are invisible and project-canonical commands (Makefile targets, `just`
 * recipes) get bypassed for generic `docker compose build` / `npm run build`.
 *
 * The pure pieces are:
 *   - buildStartupSet: cwd + every ancestor pi/CC already loaded at start.
 *   - expandTilde:     `~` / `~/x` -> absolute (no shell).
 *   - extractCdTargets: pull every `cd <dir>` target from a bash command line.
 *   - decideTarget:    given a resolved target + the loaded/warned sets +
 *                      an fsExists probe, return the AGENTS.md/CLAUDE.md path
 *                      to surface, or null.
 *   - readHead:        bounded head of an instruction file (line + char caps).
 *   - buildInjection:  render the guard message body (harness-neutral).
 *   - decideForCommand: the harness-agnostic orchestrator - runs the whole
 *                       pipeline over a bash command and returns the first
 *                       instruction file to surface + rendered message, or null.
 *
 * The commit-nudge absorption (guard-commit-shared) is a pi-only concern:
 * pi short-circuits tool_call handlers on the first block, so cd-agents-reload
 * must absorb the confidential-write guard's nudge. That coupling stays in the
 * pi adapter; the CC hook (PreToolUse Bash on `cd`, or SessionStart) has no
 * such ordering constraint. See .pi/agent/docs/pi-to-claude-code-port.md.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

export const MAX_HEAD_LINES = 80;
export const MAX_HEAD_CHARS = 4000;
const HOME = homedir();

/**
 * Pre-seed with the session's startup cwd + every ancestor - the harness
 * loaded those at startup so the agent already has their AGENTS.md content.
 */
export function buildStartupSet(cwd: string): Set<string> {
  const s = new Set<string>();
  let d = cwd;
  while (true) {
    s.add(d);
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return s;
}

export function expandTilde(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return HOME + p.slice(1);
  return p;
}

/**
 * Extract every `cd <dir>` target from a bash command line.
 * - Handles `&&`, `||`, `;`, `|`, `\n` segment delimiters.
 * - Handles single-quoted, double-quoted, bare paths.
 * - Skips `cd -`, `cd` with no arg, paths containing `$` (unresolvable
 *   without a shell), and `cd /` (root, never a project dir).
 */
export function extractCdTargets(command: string): string[] {
  const out: string[] = [];
  const segments = command.split(/&&|\|\||;|\n|\|/);
  for (const seg of segments) {
    const m = seg.match(/^\s*cd\s+(?:'([^']+)'|"([^"]+)"|([^\s;&|]+))/);
    if (!m) continue;
    const raw = m[1] ?? m[2] ?? m[3];
    if (!raw) continue;
    if (raw === "-" || raw === "..") continue;
    if (raw === "/" || raw.includes("$") || raw.startsWith("$")) continue;
    out.push(raw);
  }
  return out;
}

/**
 * Should we fire on this target? Returns the AGENTS.md or CLAUDE.md path to
 * read, or null if nothing to do.
 */
export function decideTarget(args: {
  target: string;
  startupLoaded: Set<string>;
  alreadyWarned: Set<string>;
  fsExists: (p: string) => boolean;
}): string | null {
  if (args.startupLoaded.has(args.target)) return null;
  if (args.alreadyWarned.has(args.target)) return null;
  for (const fname of ["AGENTS.md", "CLAUDE.md"]) {
    const p = `${args.target}/${fname}`;
    if (args.fsExists(p)) return p;
  }
  return null;
}

/** Bounded head of an instruction file (line + char caps). Empty on read error. */
export function readHead(
  path: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): string {
  let text: string;
  try {
    text = read(path);
  } catch {
    return "";
  }
  const lines = text.split("\n");
  let head = lines.slice(0, MAX_HEAD_LINES).join("\n");
  if (head.length > MAX_HEAD_CHARS) {
    head = head.slice(0, MAX_HEAD_CHARS) + "\n[...truncated at char cap...]";
  }
  if (lines.length > MAX_HEAD_LINES) {
    head += `\n\n[truncated - full file is ${lines.length} lines at ${path}. Use the 'read' tool for the rest.]`;
  }
  return head;
}

/**
 * Render the guard message body. `rerunFullNotice` is passed in so the pi
 * adapter can inject the shared guard-commit-shared notice while the CC hook
 * supplies its own (or omits it). Harness-neutral - no block/deny wrapping.
 */
export function buildInjection(args: {
  target: string;
  startupCwd: string;
  agentsPath: string;
  head: string;
  rerunFullNotice?: string;
}): string {
  const fname = args.agentsPath.split("/").pop();
  const lines = [
    `tool-guard[cd-agents-reload]: you cd'd into ${args.target}, which has its own ${fname} that was NOT loaded at session start.`,
    ``,
    `Session started in ${args.startupCwd}, so the rules below are NOT in your current context. They may include canonical build/deploy commands (e.g. Makefile targets that supersede direct \`docker compose\`/\`npm\` calls), test commands, or project-specific gotchas.`,
    ``,
    `-- ${args.agentsPath} --`,
    args.head,
    `-- end --`,
    ``,
  ];
  if (args.rerunFullNotice) {
    lines.push(args.rerunFullNotice, ``);
  }
  lines.push(
    `Re-run your FULL bash command if it's still correct given the rules above. If a project-canonical command exists for what you were about to do, use that instead.`,
    `This guard fires once per target dir per session.`,
  );
  return lines.join("\n");
}

export interface CdReloadDecision {
  target: string;
  agentsPath: string;
  head: string;
  message: string;
}

/**
 * Harness-agnostic orchestrator. Given a bash command and session state,
 * return the FIRST cd target whose AGENTS.md/CLAUDE.md should be surfaced,
 * with a rendered message - or null if nothing to do.
 *
 * Mutates `alreadyWarned` (adds the fired target) exactly like the pi adapter,
 * so a transient read failure doesn't re-fire and repeats are suppressed.
 * fsExists/readFile/rerunFullNotice are injectable for tests + harness reuse.
 */
export function decideForCommand(args: {
  command: string;
  startupCwd: string;
  startupLoaded: Set<string>;
  alreadyWarned: Set<string>;
  fsExists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  rerunFullNotice?: string;
}): CdReloadDecision | null {
  const fsExists = args.fsExists ?? existsSync;
  const targets = extractCdTargets(args.command);
  if (targets.length === 0) return null;

  for (const raw of targets) {
    const expanded = expandTilde(raw);
    const target = resolve(args.startupCwd, expanded);
    const agentsPath = decideTarget({
      target,
      startupLoaded: args.startupLoaded,
      alreadyWarned: args.alreadyWarned,
      fsExists,
    });
    if (!agentsPath) continue;

    // Mark before reading so a transient read failure doesn't re-fire.
    args.alreadyWarned.add(target);
    const head = args.readFile ? readHead(agentsPath, args.readFile) : readHead(agentsPath);
    if (!head) continue;

    const message = buildInjection({
      target,
      startupCwd: args.startupCwd,
      agentsPath,
      head,
      rerunFullNotice: args.rerunFullNotice,
    });
    return { target, agentsPath, head, message };
  }
  return null;
}
