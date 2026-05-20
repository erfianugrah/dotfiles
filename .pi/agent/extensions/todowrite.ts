/**
 * todowrite — session-scoped todo list, agent-managed.
 *
 * Pi philosophy is "use a TODO.md file, todos in chat context get stale".
 * But the user's existing skills (superpowers) reference TodoWrite by name
 * and the workflow is established. This extension bridges that gap by
 * registering a `todowrite` tool with the opencode semantics — the agent
 * passes the full updated todo list each call, and we render it to a
 * session-scoped JSON file + a status indicator.
 *
 * Storage: ~/.pi/agent/todos/<sessionId>.json
 *   { todos: [{ content, status, priority }] }
 *
 * Session detection: uses the env var PI_SESSION_ID if Pi exposes it, else
 * falls back to "default" (single global todo list).
 *
 * Status line: shows non-completed count, e.g. "todos: 3" or "todos: ✓"
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
type TodoPriority = "high" | "medium" | "low";

interface Todo {
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
}

function todosDir(): string {
  const dir = join(getAgentDir(), "todos");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionTodosPath(sessionId: string): string {
  // Sanitize sessionId for filesystem use
  const safe = sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return join(todosDir(), `${safe}.json`);
}

function statusGlyph(todos: Todo[]): string {
  if (todos.length === 0) return "todos: 0";
  const pending = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled").length;
  if (pending === 0) return "todos: ✓";
  const inProgress = todos.filter((t) => t.status === "in_progress").length;
  return inProgress > 0 ? `todos: ${pending} (${inProgress} active)` : `todos: ${pending}`;
}

const todowriteTool = defineTool({
  name: "todowrite",
  label: "TodoWrite",
  description: [
    "Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness.",
    "",
    "## When to Use This Tool",
    "Use this tool proactively in these scenarios:",
    "1. Complex multistep tasks - When a task requires 3 or more distinct steps or actions",
    "2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations",
    "3. User explicitly requests todo list - When the user directly asks you to use the todo list",
    "4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)",
    "5. After receiving new instructions - Immediately capture user requirements as todos. Feel free to edit the todo list based on new information.",
    "6. After completing a task - Mark it complete and add any new follow-up tasks",
    "7. When you start working on a new task, mark the todo as in_progress. Ideally you should only have one todo as in_progress at a time. Complete existing tasks before starting new ones.",
    "",
    "## When NOT to Use This Tool",
    "Skip using this tool when:",
    "1. There is only a single, straightforward task",
    "2. The task is trivial and tracking it provides no organizational benefit",
    "3. The task can be completed in less than 3 trivial steps",
    "4. The task is purely conversational or informational",
    "",
    "## Task States",
    "- pending: Task not yet started",
    "- in_progress: Currently working on (limit to ONE task at a time)",
    "- completed: Task finished successfully",
    "- cancelled: Task no longer needed",
    "",
    "## Task Management",
    "- Update task status in real-time as you work",
    "- Mark tasks complete IMMEDIATELY after finishing (don't batch completions)",
    "- Only have ONE task in_progress at any time",
    "- Complete current tasks before starting new ones",
    "- Cancel tasks that become irrelevant",
    "",
    "Pass the entire updated todo list each call. The list replaces (not appends to) the previous state.",
  ].join("\n"),
  parameters: Type.Object({
    todos: Type.Array(
      Type.Object({
        content: Type.String({ description: "Brief description of the task" }),
        status: Type.Union(
          [
            Type.Literal("pending"),
            Type.Literal("in_progress"),
            Type.Literal("completed"),
            Type.Literal("cancelled"),
          ],
          { description: "Current status of the task: pending, in_progress, completed, cancelled" },
        ),
        priority: Type.Union(
          [Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")],
          { description: "Priority level of the task: high, medium, low" },
        ),
      }),
      { description: "The updated todo list" },
    ),
  }),

  async execute(_id, params, _signal, _onUpdate, ctx) {
    // Pi session id isn't directly exposed to tools but env var works.
    // Fall back to a per-cwd id so different projects don't clobber.
    const sessionId =
      process.env.PI_SESSION_ID ??
      (ctx as { cwd?: string }).cwd?.replace(/\//g, "-") ??
      "default";

    const file = sessionTodosPath(sessionId);
    writeFileSync(file, JSON.stringify({ todos: params.todos }, null, 2) + "\n");

    // Update status bar if available
    if ((ctx as { hasUI?: boolean }).hasUI) {
      try {
        (ctx as { ui?: { setStatus: (k: string, v: string) => void } }).ui?.setStatus("todos", statusGlyph(params.todos));
      } catch {
        // ui may not be present in non-interactive mode
      }
    }

    const pending = params.todos.filter((t) => t.status !== "completed" && t.status !== "cancelled");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(params.todos, null, 2),
        },
      ],
      details: { count: params.todos.length, pending: pending.length, file },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(todowriteTool);

  // Clear status on session end
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      ctx.ui.setStatus("todos", undefined);
    } catch {
      // ignore
    }
  });
}
