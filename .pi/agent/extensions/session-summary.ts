/**
 * session-summary — at session start, show a compact project briefing.
 *
 * On reason ∈ {"startup", "new"} in a git working tree we collect:
 *   - branch name + ahead/behind vs upstream
 *   - uncommitted file count (staged / modified / untracked)
 *   - last 3 commit subjects
 *   - up to 3 open PRs (if gh CLI is configured and authed)
 *
 * Output is injected via pi.sendMessage as a custom display entry. It does
 * NOT trigger a turn (deliverAs:"nextTurn" — queued, never causes an LLM call).
 *
 * Skipped reasons:
 *   - "resume" / "reload" / "fork" — noisy, user already knows the state
 *   - cwd is not a git repo — extension stays quiet
 *
 * Hard time budget: 1500ms total. Each shell call gets ~400ms before being
 * skipped — we'd rather show partial info than block the TUI.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "session-summary";
const PER_CMD_TIMEOUT_MS = 400;
const TOTAL_BUDGET_MS = 1500;

interface GitSummary {
  branch: string;
  ahead?: number;
  behind?: number;
  upstream?: string;
  staged: number;
  modified: number;
  untracked: number;
  recentCommits: string[];
  openPRs?: Array<{ number: number; title: string; author: string }>;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = PER_CMD_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let done = false;
    const finish = (s: string) => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve(s);
    };
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.on("error", () => finish(""));
    child.on("close", () => finish(stdout));
    setTimeout(() => finish(stdout), timeoutMs);
  });
}

async function collectGitSummary(cwd: string): Promise<GitSummary | undefined> {
  // Quick gate: are we in a git repo?
  const gitDir = (await run("git", ["rev-parse", "--git-dir"], cwd)).trim();
  if (!gitDir) return undefined;

  const [branchRaw, statusRaw, logRaw, upstreamRaw] = await Promise.all([
    run("git", ["branch", "--show-current"], cwd),
    run("git", ["status", "--porcelain=v1"], cwd),
    run("git", ["log", "-3", "--pretty=format:%h %s"], cwd),
    run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd),
  ]);

  const branch = branchRaw.trim() || "(detached)";
  const upstream = upstreamRaw.trim().startsWith("@{u}") ? undefined : upstreamRaw.trim() || undefined;

  // ahead/behind vs upstream
  let ahead: number | undefined;
  let behind: number | undefined;
  if (upstream) {
    const counts = (await run("git", ["rev-list", "--left-right", "--count", `${upstream}...HEAD`], cwd)).trim();
    const m = counts.match(/^(\d+)\s+(\d+)$/);
    if (m) {
      behind = parseInt(m[1], 10);
      ahead = parseInt(m[2], 10);
    }
  }

  // status counts
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  for (const line of statusRaw.split("\n")) {
    if (!line) continue;
    const xy = line.slice(0, 2);
    if (xy === "??") untracked++;
    else {
      if (xy[0] !== " " && xy[0] !== "?") staged++;
      if (xy[1] !== " " && xy[1] !== "?") modified++;
    }
  }

  const recentCommits = logRaw.split("\n").filter(Boolean).slice(0, 3);

  // open PRs (best-effort)
  let openPRs: GitSummary["openPRs"];
  const prJson = await run(
    "gh",
    ["pr", "list", "--state", "open", "--limit", "3", "--json", "number,title,author"],
    cwd,
    PER_CMD_TIMEOUT_MS * 2, // gh is slower
  );
  if (prJson.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(prJson) as Array<{ number: number; title: string; author: { login: string } }>;
      openPRs = parsed.map((p) => ({ number: p.number, title: p.title, author: p.author?.login ?? "?" }));
    } catch { /* ignore */ }
  }

  return { branch, ahead, behind, upstream, staged, modified, untracked, recentCommits, openPRs };
}

function formatSummary(s: GitSummary): string {
  const parts: string[] = [];

  // Line 1: branch + tracking
  let head = `branch: ${s.branch}`;
  if (s.upstream) {
    if (s.ahead && s.behind) head += ` (↑${s.ahead} ↓${s.behind} vs ${s.upstream})`;
    else if (s.ahead) head += ` (↑${s.ahead} vs ${s.upstream})`;
    else if (s.behind) head += ` (↓${s.behind} vs ${s.upstream})`;
    else head += ` (= ${s.upstream})`;
  } else {
    head += " (no upstream)";
  }
  parts.push(head);

  // Line 2: working tree status
  const dirty = s.staged + s.modified + s.untracked;
  if (dirty === 0) {
    parts.push("working tree: clean");
  } else {
    const bits: string[] = [];
    if (s.staged) bits.push(`${s.staged} staged`);
    if (s.modified) bits.push(`${s.modified} modified`);
    if (s.untracked) bits.push(`${s.untracked} untracked`);
    parts.push(`working tree: ${bits.join(", ")}`);
  }

  // Recent commits
  if (s.recentCommits.length) {
    parts.push("recent:");
    for (const c of s.recentCommits) parts.push(`  ${c}`);
  }

  // Open PRs
  if (s.openPRs && s.openPRs.length) {
    parts.push("open PRs:");
    for (const p of s.openPRs) parts.push(`  #${p.number} ${p.title} (@${p.author})`);
  }

  return parts.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    // Only on fresh starts, not on reload/resume/fork (user already has context)
    const reason = (event as { reason?: string }).reason;
    if (reason !== "startup" && reason !== "new") return;

    // Race against the total budget
    const cwd = ctx.cwd;
    const summaryPromise = collectGitSummary(cwd);
    const timeout = new Promise<undefined>((r) => setTimeout(() => r(undefined), TOTAL_BUDGET_MS));
    const summary = await Promise.race([summaryPromise, timeout]);

    if (!summary) return;

    const text = formatSummary(summary);

    // Inject as a custom display entry. deliverAs:"nextTurn" means it's just
    // queued in the session log — does NOT trigger an LLM call. The user sees
    // it in the TUI as a system note before their first prompt.
    try {
      pi.sendMessage(
        {
          customType: ENTRY_TYPE,
          content: text,
          display: true,
          details: { cwd, reason },
        },
        { deliverAs: "nextTurn" },
      );
    } catch {
      // sendMessage can fail in non-interactive print mode — silent fail OK
    }
  });
}
