/**
 * task — spawn a fresh Pi subprocess to run a delegated task in isolated context.
 *
 * Port of opencode/src/tool/task.ts to Pi. opencode creates a sub-SESSION
 * using its internal session model (`sessions.create({ parentID, ... })`)
 * and runs the prompt in that nested session. Pi has no nested sessions,
 * so we spawn `pi -p <prompt>` as a subprocess — the subprocess gets its
 * own context window, runs in isolation, returns its final output.
 *
 * Subagent types map to "model + restricted tool set" presets defined here.
 * The opencode fork advertises these subagent types:
 *   - explore: read-only file exploration (no edit/write/bash mutations)
 *   - general: full agent for multi-step research/implementation tasks
 *
 * Pi's philosophy is "no built-in subagents — spawn pi instances via tmux".
 * This is the programmatic equivalent: spawn pi with restricted --tools.
 *
 * Compared to opencode:
 *   - No session resume via task_id (Pi sessions are file-based and easily
 *     resumable directly; agents don't generally re-use task subagents)
 *   - No agent-permission inheritance (Pi has no agent system)
 *   - One-shot only: subprocess exits after producing output
 *   - Concurrency: parent agent can launch multiple `task` calls in one
 *     turn; each becomes a separate subprocess
 *
 * The subprocess runs `pi -p "<prompt>" --mode json` and we parse the
 * final assistant message from the event stream. Stdin/stderr piped for
 * debugging if --verbose is set in PI_VERBOSE env.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "child_process";

// Subagent type → tool whitelist (matches opencode fork's subagent presets)
const SUBAGENT_PRESETS: Record<string, { tools: string[]; description: string }> = {
  explore: {
    tools: ["read", "grep", "find", "ls", "docs_search", "docs_read", "docs_grep", "docs_find", "docs_summary", "docs_sources"],
    description: "Read-only exploration. Can read files, search code, browse docs. Cannot edit, write, or run bash.",
  },
  general: {
    tools: [], // empty = no restriction (all tools available)
    description: "General-purpose subagent with full tool access. Use for multi-step research + implementation tasks.",
  },
};

interface JsonEvent {
  type: string;
  message?: {
    role: string;
    content?: Array<{ type: string; text?: string }>;
  };
  text?: string;
}

async function runSubagent(args: {
  prompt: string;
  subagentType: string;
  description: string;
}): Promise<{ output: string; sessionId?: string }> {
  const preset = SUBAGENT_PRESETS[args.subagentType] ?? SUBAGENT_PRESETS.general;
  const flags = ["-p", args.prompt, "--mode", "json", "--no-session"];
  if (preset.tools.length > 0) flags.push("--tools", preset.tools.join(","));

  return await new Promise((resolve) => {
    const proc = spawn("pi", flags, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout.on("data", (b) => stdout.push(b));
    proc.stderr.on("data", (b) => stderr.push(b));
    proc.on("close", () => {
      const out = Buffer.concat(stdout).toString("utf-8");
      const err = Buffer.concat(stderr).toString("utf-8");
      if (process.env.PI_VERBOSE === "1") {
        // eslint-disable-next-line no-console
        console.error(`[task ${args.subagentType}] stderr:\n${err}`);
      }
      // Parse JSON events line-by-line. Last assistant text wins.
      let finalText = "";
      let sessionId: string | undefined;
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        let ev: JsonEvent;
        try {
          ev = JSON.parse(line) as JsonEvent;
        } catch {
          continue;
        }
        if (ev.type === "session" && (ev as { id?: string }).id) {
          sessionId = (ev as { id: string }).id;
        }
        if (ev.type === "message" && ev.message?.role === "assistant") {
          const text =
            ev.message.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n") ?? "";
          if (text) finalText = text;
        }
        if (ev.type === "text" && ev.text) {
          finalText = ev.text;
        }
      }
      if (!finalText && err) finalText = `[no text output from subagent; stderr]\n${err.slice(0, 500)}`;
      if (!finalText) finalText = "[subagent produced no output]";
      resolve({ output: finalText, sessionId });
    });
    proc.on("error", (e) => resolve({ output: `[subagent spawn failed] ${e.message}` }));
  });
}

const taskTool = defineTool({
  name: "task",
  label: "Task",
  description: [
    "Launch a fresh Pi subprocess to handle a delegated task in isolated context.",
    "",
    "Each call spawns a separate `pi -p` subprocess with its own context window and its own tool access — restricted by the `subagent_type` you choose.",
    "",
    "When to use:",
    "- Multi-step research / exploration tasks that don't need to share context with the parent",
    "- Tasks where context isolation matters (e.g. summarising a huge codebase without filling parent context)",
    "- Parallel exploration: launch multiple `task` calls in one turn to run subagents concurrently",
    "",
    "When NOT to use:",
    "- For reading 1-3 known files (use `read` directly)",
    "- For grepping the codebase (use `grep` directly)",
    "- For tasks that need to remember earlier context from this session",
    "",
    "Subagent types:",
    Object.entries(SUBAGENT_PRESETS)
      .map(([k, v]) => `  - ${k}: ${v.description}`)
      .join("\n"),
    "",
    "The subagent's final response is returned as the tool output. The parent agent should summarise the result to the user; the raw output isn't shown in the TUI.",
  ].join("\n"),
  parameters: Type.Object({
    description: Type.String({
      description: "A short (3-5 words) description of the task",
    }),
    prompt: Type.String({
      description:
        "The task for the agent to perform. Be highly detailed — the subagent starts with a fresh context and only knows what you tell it. Specify exactly what information it should return.",
    }),
    subagent_type: Type.Union(
      Object.keys(SUBAGENT_PRESETS).map((k) => Type.Literal(k)),
      { description: "The type of specialized agent to use for this task" },
    ),
  }),
  async execute(_id, params) {
    const { output, sessionId } = await runSubagent({
      prompt: params.prompt,
      subagentType: params.subagent_type,
      description: params.description,
    });
    const sessionLine = sessionId ? `subagent session: ${sessionId}\n\n` : "";
    return {
      content: [
        {
          type: "text",
          text: `${sessionLine}<task_result>\n${output}\n</task_result>`,
        },
      ],
      details: {
        description: params.description,
        subagent_type: params.subagent_type,
        sessionId,
      },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(taskTool);
}
