/**
 * cd-agents-reload — close the "cd into another repo" context gap.
 *
 * Pi loads AGENTS.md / CLAUDE.md from cwd + parents AT SESSION START. It
 * does not re-load when the agent `cd`s into another repo mid-session, so
 * project-specific instructions in `<other-repo>/AGENTS.md` are invisible
 * to the LLM and project-canonical commands (Makefile targets, `just`
 * recipes, repo-specific deploy scripts) get bypassed in favour of generic
 * `docker compose build` / `npm run build` calls.
 *
 * This extension fires once per (session × target-dir):
 *
 *   1. Detect `cd <dir>` segments in bash commands.
 *   2. Resolve <dir> against pi's startup cwd; skip if it's an ancestor
 *      already covered by the startup context load.
 *   3. If <target>/AGENTS.md (or CLAUDE.md) exists and we haven't shown
 *      it this session, block the bash call with the file head as the
 *      reason. The agent re-runs the bash after acknowledging the rules.
 *
 * Disable: `PI_NO_CD_AGENTS_RELOAD=1` in env, or comment-out the registration.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_HEAD_LINES = 80;
const MAX_HEAD_CHARS = 4000;
const HOME = homedir();

// Pre-seed with the session's startup cwd + every ancestor — pi loaded those
// at startup so the agent already has their AGENTS.md content.
function buildStartupSet(cwd: string): Set<string> {
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

function expandTilde(p: string): string {
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
 * Exported for unit tests.
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
 * read, or null if nothing to do. Exported for unit tests.
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

function readHead(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  const lines = text.split("\n");
  let head = lines.slice(0, MAX_HEAD_LINES).join("\n");
  if (head.length > MAX_HEAD_CHARS) {
    head = head.slice(0, MAX_HEAD_CHARS) + "\n[…truncated at char cap…]";
  }
  if (lines.length > MAX_HEAD_LINES) {
    head += `\n\n[truncated — full file is ${lines.length} lines at ${path}. Use the 'read' tool for the rest.]`;
  }
  return head;
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_NO_CD_AGENTS_RELOAD === "1") return;

  const startupCwd = process.cwd();
  const startupLoaded = buildStartupSet(startupCwd);
  const warned = new Set<string>();

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return undefined;
    const cmd = (event.input as { command?: string }).command;
    if (typeof cmd !== "string" || cmd.length === 0) return undefined;

    const targets = extractCdTargets(cmd);
    if (targets.length === 0) return undefined;

    for (const raw of targets) {
      const expanded = expandTilde(raw);
      const target = resolve(startupCwd, expanded);
      const agentsPath = decideTarget({
        target,
        startupLoaded,
        alreadyWarned: warned,
        fsExists: existsSync,
      });
      if (!agentsPath) continue;

      // Mark before reading so a transient read failure doesn't re-fire.
      warned.add(target);
      const head = readHead(agentsPath);
      if (!head) continue;

      return {
        block: true,
        reason: [
          `tool-guard[cd-agents-reload]: you cd'd into ${target}, which has its own ${agentsPath.split("/").pop()} that pi did NOT load at session start.`,
          ``,
          `Session started in ${startupCwd}, so the rules below are NOT in your current context. They may include canonical build/deploy commands (e.g. Makefile targets that supersede direct \`docker compose\`/\`npm\` calls), test commands, or project-specific gotchas.`,
          ``,
          `── ${agentsPath} ──`,
          head,
          `── end ──`,
          ``,
          `Re-run your bash if it's still correct given the rules above. If a project-canonical command exists for what you were about to do, use that instead.`,
          `This guard fires once per target dir per session.`,
        ].join("\n"),
      };
    }
    return undefined;
  });
}
