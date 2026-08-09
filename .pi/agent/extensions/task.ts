/**
 * task - spawn a fresh Pi subprocess to run a delegated task in isolated context.
 *
 * Port of opencode/src/tool/task.ts to Pi. opencode creates a sub-SESSION
 * using its internal session model (`sessions.create({ parentID, ... })`)
 * and runs the prompt in that nested session. Pi has no nested sessions,
 * so we spawn `pi -p <prompt>` as a subprocess - the subprocess gets its
 * own context window, runs in isolation, returns its final output.
 *
 * Subagent types map to "model + restricted tool set" presets defined here.
 * The opencode fork advertises these subagent types:
 *   - explore: read-only file exploration (no edit/write/bash mutations)
 *   - general: full agent for multi-step research/implementation tasks
 *
 * Pi's philosophy is "no built-in subagents - spawn pi instances via tmux".
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
 * event stream incrementally for live progress (onUpdate throttled to ~1/s)
 * and extract the final assistant message on close.
 *
 * Incremental streaming eliminates the "blackout" UX gap where a long-running
 * task subprocess showed no feedback until the child exited.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { summarizeToolArgs, formatElapsed } from "./lib/tool-label.js";

// Subagent type -> tool whitelist + flags (matches opencode fork's subagent presets)
//
// `minimal` = pass --no-extensions --no-skills --no-prompt-templates so the
// subagent process skips loading the parent's full extension surface. Only
// the `--tools` whitelist is available. Big startup-tax saving for read-only
// exploration: no FTS5 worker, no tool-routing inject, no memory inject, no
// superpowers regex match, etc.
//
// `loadExtensions` = explicit list of extension files to re-include via
// `-e <path>` (still works alongside --no-extensions per pi --help). Use
// for extensions that provide tools listed in the whitelist (docs_* etc).
const SUBAGENT_PRESETS: Record<
	string,
	{ tools: string[]; description: string; minimal?: boolean; loadExtensions?: string[] }
> = {
	explore: {
		tools: ["read", "grep", "glob", "docs_search", "docs_read", "docs_grep", "docs_find", "docs_summary", "docs_sources"],
		description: "Read-only exploration. Can read files, search code, browse docs. Cannot edit, write, or run bash.",
		minimal: true,
		loadExtensions: ["docs.ts"],
	},
	general: {
		tools: [], // empty = no restriction (all tools available)
		description: "General-purpose subagent with full tool access. Use for multi-step research + implementation tasks.",
	},
	// Alias for Claude Code-style subagent type names baked into obra/superpowers
	// skills (`requesting-code-review/SKILL.md`, `subagent-driven-development/*`,
	// `writing-plans/plan-document-reviewer-prompt.md`, etc.). Without this alias
	// those skills fail schema validation when the model passes
	// subagent_type="general-purpose".
	"general-purpose": {
		tools: [],
		description: "Alias for `general` - accepts Claude Code-style subagent type names from obra/superpowers skills.",
	},
};

interface SubagentEvent {
	type: string;
	id?: string;
	toolCallId?: string;
	toolName?: string;
	args?: Record<string, unknown>;
	partialResult?: {
		content?: Array<{ type: string; text?: string }>;
	};
	message?: {
		role: string;
		content?: Array<{ type: string; text?: string }>;
	};
	messages?: Array<{
		role: string;
		content?: Array<{ type: string; text?: string }>;
	}>;
	text?: string;
}

// ---------------------------------------------------------------------------
// Public API (tested by loop-task.test.ts)
// ---------------------------------------------------------------------------

/**
 * Parse one line of JSONL subprocess output. Returns the parsed object or
 * null on garbage / blank / non-object input. Never throws.
 */
export function parseSubagentEventLine(line: string): SubagentEvent | null {
	if (!line || !line.trim()) return null;
	try {
		const parsed = JSON.parse(line);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as SubagentEvent;
	} catch {
		return null;
	}
}

/**
 * Live progress tracker for a running subagent. Consumes parsed JSON events
 * and exposes a one-line status string, the final assistant text, and the
 * session id.
 *
 * `now` is an injectable clock (ms) defaulting to Date.now for test determinism.
 * `depth` is the nesting depth (0 for top-level, 1+ for nested subagents).
 */
export function createTaskProgress(description: string, now?: () => number, depth?: number) {
	const clock = now ?? (() => Date.now());
	const startedAt = clock();
	let _sessionId: string | undefined;
	let toolCount = 0;
	let lastToolLabel = "";
	let lastAssistantText = "";
	let nestedLine = "";
	const _depth = depth ?? 0;

	/** Extract plain-text content from an assistant message, or "" if not assistant. */
	const extractAssistantText = (msg: SubagentEvent["message"]): string => {
		if (!msg || msg.role !== "assistant") return "";
		return (
			msg.content
				?.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("\n") ?? ""
		);
	};

	const tracker = {
		get toolCount(): number {
			return toolCount;
		},

		observeEvent(ev: unknown): void {
			if (!ev || typeof ev !== "object") return;
			const e = ev as SubagentEvent;

			if (e.type === "session" && e.id) {
				_sessionId = e.id;
			}
			if (e.type === "tool_execution_start") {
				toolCount++;
				const label = summarizeToolArgs(e.toolName ?? "?", e.args);
				lastToolLabel = `${e.toolName ?? "?"} ${label}`;
			}
			if (
				e.type === "tool_execution_update" &&
				e.toolName === "task"
			) {
				const text = e.partialResult?.content
					?.map((c) => c.text ?? "")
					.join("\n") ?? "";
				if (text) nestedLine = text;
			}
			if (
				e.type === "message" ||
				e.type === "message_end" ||
				e.type === "message_update" ||
				e.type === "turn_end"
			) {
				const text = extractAssistantText(e.message);
				if (text) lastAssistantText = text;
			}
			if (e.type === "agent_end") {
				const messages = e.messages;
				if (messages) {
					for (const m of messages) {
						const text = extractAssistantText(m);
						if (text) lastAssistantText = text;
					}
				}
			}
			if (e.type === "text" && e.text) {
				lastAssistantText = e.text;
			}
		},

		statusLine(): string {
			const elapsed = formatElapsed(clock() - startedAt);
			let line = `task "${description}" · ${elapsed} · ${toolCount} tools`;
			if (_depth > 0) line += ` · depth ${_depth}`;
			if (lastToolLabel) line += ` · last: ${lastToolLabel}`;
			if (nestedLine) line += ` |-> ${nestedLine}`;
			return line;
		},

		finalText(): string {
			return lastAssistantText;
		},

		get sessionId(): string | undefined {
			return _sessionId;
		},
	};

	return tracker;
}

// ---------------------------------------------------------------------------
// Subprocess execution (streaming)
// ---------------------------------------------------------------------------

interface OnUpdatePayload {
	content: Array<{ type: "text"; text: string }>;
}

interface ExecuteResult {
	content: Array<{ type: "text"; text: string }>;
	details: {
		description: string;
		subagent_type: string;
		sessionId?: string;
	};
}

/**
 * Spawn a pi subprocess and stream progress via onUpdate.
 *
 * Incrementally parses JSONL stdout lines, feeds them into a TaskProgress
 * tracker, and calls onUpdate:
 *   - first update promptly (as soon as the first event arrives),
 *   - subsequent updates throttled to >=1s apart,
 *   - final flush on close if any updates were suppressed.
 *
 * Aborting the signal sends SIGTERM to the child and resolves promptly.
 *
 * PI_TASK_DEPTH is incremented into the child env; the tracker's statusLine
 * includes "depth N" when N > 0.
 */
async function runSubagentStreaming(
	flags: string[],
	description: string,
	env: NodeJS.ProcessEnv,
	signal: AbortSignal | undefined,
	onUpdate: ((u: OnUpdatePayload) => void) | undefined,
	depth: number,
): Promise<{ output: string; sessionId?: string }> {
	return new Promise((resolve) => {
		const proc = spawn("pi", flags, { stdio: ["ignore", "pipe", "pipe"], env });
		const stderrChunks: Buffer[] = [];
		proc.stderr.on("data", (b: Buffer) => stderrChunks.push(b));

		const progress = createTaskProgress(description, undefined, depth);
		let lastUpdateMs = 0;
		let suppressed = false;
		let resolved = false;

		const sendUpdate = () => {
			lastUpdateMs = Date.now();
			suppressed = false;
			onUpdate?.({ content: [{ type: "text", text: progress.statusLine() }] });
		};

		let firstUpdateSent = false;

		const maybeUpdate = () => {
			const now = Date.now();
			if (!firstUpdateSent) {
				// Defer the first update until we have at least one tool event -
				// a status line showing "0 tools" is noise. This also ensures
				// multi-line chunks are fully observed before the first paint.
				if (progress.toolCount === 0) return;
				sendUpdate();
				firstUpdateSent = true;
			} else if (now - lastUpdateMs >= 1000) {
				sendUpdate();
			} else {
				suppressed = true;
			}
		};

		const finish = () => {
			if (resolved) return;
			resolved = true;

			if (suppressed && onUpdate) {
				onUpdate({ content: [{ type: "text", text: progress.statusLine() }] });
			}

			// Same final-result logic as the original buffer-until-close path.
			let finalText = progress.finalText();
			const sessionId = progress.sessionId;
			const err = Buffer.concat(stderrChunks).toString("utf-8");

			if (process.env.PI_VERBOSE === "1") {
				// eslint-disable-next-line no-console
				console.error(`[task] stderr:\n${err}`);
			}

			if (!finalText && err) {
				const cleaned = err
					.split("\n")
					.filter((l) => !/^\d+\s*\|/.test(l) && !/at\s+(emit|process)/.test(l))
					.join("\n")
					.trim();
				if (cleaned.includes("extension ctx is stale")) {
					finalText =
						"[subagent crashed - a sibling extension is capturing stale ctx]\n" +
						"Check ~/.pi/agent/extensions/ for setFooter/setStatus closures that reference ctx after /reload.\n" +
						"Workaround: restart Pi (full quit + relaunch) and retry.";
				} else {
					finalText = `[no text output from subagent; stderr]\n${cleaned.slice(0, 500)}`;
				}
			}
			if (!finalText) finalText = "[subagent produced no output]";

			resolve({ output: finalText, sessionId });
		};

		// Incremental line-buffered parsing of stdout.
		// We defer maybeUpdate until after ALL complete lines in the current
		// chunk have been observed, so the first update reflects the full
		// state (e.g. both session + tool_execution_start arriving in one
		// write from the child) rather than a half-observed intermediate.
		let buffer = "";
		proc.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf-8");
			const lines = buffer.split("\n");
			// Last element is either a partial line or empty; keep it for the
			// next chunk.
			buffer = lines.pop() ?? "";
			let hadEvents = false;
			for (const line of lines) {
				const ev = parseSubagentEventLine(line);
				if (ev) {
					progress.observeEvent(ev);
					hadEvents = true;
				}
			}
			if (hadEvents) maybeUpdate();
		});

		proc.on("close", () => {
			// Flush any trailing partial line.
			if (buffer.trim()) {
				const ev = parseSubagentEventLine(buffer);
				if (ev) progress.observeEvent(ev);
			}
			finish();
		});

		proc.on("error", (e) => {
			resolve({ output: `[subagent spawn failed] ${e.message}` });
		});

		// AbortSignal: kill the child and resolve promptly.
		if (signal) {
			if (signal.aborted) {
				proc.kill("SIGTERM");
				finish();
				return;
			}
			signal.addEventListener("abort", () => {
				proc.kill("SIGTERM");
				finish();
			}, { once: true });
		}
	});
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const taskTool = defineTool({
	name: "task",
	label: "Task",
	promptSnippet:
		"task - spawn a `pi -p` subagent in isolated context. Use for read-only deep-dives (subagent_type=explore) or full multi-step research that pollutes parent context. Blocks parent until done but streams live subagent progress (elapsed, tool count, last tool, nested relay) to the TUI; abort kills the subprocess. For fire-and-forget use bg_task.",
	promptGuidelines: [
		"explore preset is minimal (--no-extensions --no-skills + just docs.ts) - cheap and fast for code reading.",
		"general preset has full extension set - use for actual work that needs the wrapped tools.",
	],
	description: [
		"Launch a fresh Pi subprocess to handle a delegated task in isolated context.",
		"",
		"Each call spawns a separate `pi -p` subprocess with its own context window and its own tool access - restricted by the `subagent_type` you choose.",
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
				"The task for the agent to perform. Be highly detailed - the subagent starts with a fresh context and only knows what you tell it. Specify exactly what information it should return.",
		}),
		subagent_type: Type.Union(
			Object.keys(SUBAGENT_PRESETS).map((k) => Type.Literal(k)),
			{ description: "The type of specialized agent to use for this task" },
		),
	}),
	async execute(_id, params, _signal, _onUpdate, ctx): Promise<ExecuteResult> {
		// Inherit the parent session's trust decision (saved, temporary, or CLI
		// override). isProjectTrusted may be absent on pi < 0.79.1 - default to
		// true there to preserve the prior always-approve behavior.
		const approve = ctx?.isProjectTrusted?.() ?? true;
		const preset = SUBAGENT_PRESETS[params.subagent_type as string] ?? SUBAGENT_PRESETS.general;

		const flags = ["-p", params.prompt, "--mode", "json", "--no-session"];
		if (approve) flags.push("-a");
		if (preset.tools.length > 0) flags.push("--tools", preset.tools.join(","));
		if (preset.minimal) {
			const extDir = join(getAgentDir(), "extensions");
			for (const name of preset.loadExtensions ?? []) {
				const extPath = join(extDir, name);
				if (existsSync(extPath)) flags.push("-e", extPath);
			}
			flags.push("--no-extensions", "--no-skills", "--no-prompt-templates");
		}

		// Pass PI_TASK_DEPTH incremented into the child so nested subagents can
		// surface their depth. parseInt on undefined gives NaN; ?? "0" handles it.
		const parentDepth = parseInt(process.env.PI_TASK_DEPTH ?? "0", 10) || 0;
		const childDepth = parentDepth + 1;
		const env: NodeJS.ProcessEnv = { ...process.env, PI_TASK_DEPTH: String(childDepth) };

		const { output, sessionId } = await runSubagentStreaming(
			flags,
			params.description,
			env,
			_signal as AbortSignal | undefined,
			_onUpdate as ((u: OnUpdatePayload) => void) | undefined,
			childDepth,
		);

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
				subagent_type: params.subagent_type as string,
				sessionId,
			},
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(taskTool);
}
