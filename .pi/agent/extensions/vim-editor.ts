/**
 * vim-editor - modal (vim-style) editing for pi's input box.
 *
 * The default editor is emacs-style. This extension swaps in a modal editor:
 * start in INSERT mode, press Escape for NORMAL mode, and use vim motions
 * (hjkl, w/b, 0/$, x, D/C, dd, p, u, i/a/A/I, o/O). Escape in NORMAL mode
 * still aborts the agent, exactly as before.
 *
 * Implementation: this is a THIN MOTION LAYER. It does not reimplement text
 * editing - every vim key is translated into the byte sequence the base
 * editor's own keybindings already handle (arrows, ctrl+a/e, ctrl+k/u/y,
 * meta-f/b for word motion). So all motions share the base editor's buffer,
 * kill ring, and undo history, and stay consistent with whatever is bound
 * in ~/.pi/agent/keybindings.json.
 *
 * simplify: no counts (3dd), no registers, no visual mode, no ex-commands.
 * The escape-sequence translations below are the ones the official
 * examples/extensions/modal-editor.ts ships plus the ctrl/meta chords from
 * the keybindings table. If a chord misbehaves on your terminal, tweak the
 * map; the base editor still works in insert mode regardless.
 *
 * Usage: drop-in. Loads on session start; no keybindings.json changes needed.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Normal-mode key -> escape sequence fed to the base editor, or null for a
// pure mode switch (no editor input).
const CTRL_A = "\x01"; // line start  (tui.editor.cursorLineStart)
const CTRL_E = "\x05"; // line end    (tui.editor.cursorLineEnd)
const CTRL_K = "\x0b"; // delete to line end (tui.editor.deleteToLineEnd)
const CTRL_U = "\x15"; // delete to line start (tui.editor.deleteToLineStart)
const CTRL_Y = "\x19"; // paste kill ring (tui.editor.yank)
const CTRL_MINUS = "\x1f"; // undo (tui.editor.undo: ctrl+-; alt+z on WSL)
const ALT_B = "\x1bb"; // word left  (tui.editor.cursorWordLeft)
const ALT_F = "\x1bf"; // word right (tui.editor.cursorWordRight)
const ARROW_LEFT = "\x1b[D";
const ARROW_DOWN = "\x1b[B";
const ARROW_UP = "\x1b[A";
const ARROW_RIGHT = "\x1b[C";
const DELETE_FWD = "\x1b[3~"; // delete char forward
const BACKSPACE = "\x7f"; // delete char backward
const NEWLINE = "\x0a"; // ctrl+j -> tui.input.newLine

// Motion primitives that need to know whether to switch to insert mode.
type Motion =
	| { seq: string }
	| { seq: string; insert: true }
	| { mode: "insert" };

const MOTIONS: Record<string, Motion> = {
	h: { seq: ARROW_LEFT },
	j: { seq: ARROW_DOWN },
	k: { seq: ARROW_UP },
	l: { seq: ARROW_RIGHT },
	"0": { seq: CTRL_A },
	$: { seq: CTRL_E },
	w: { seq: ALT_F },
	b: { seq: ALT_B },
	x: { seq: DELETE_FWD },
	X: { seq: BACKSPACE },
	i: { mode: "insert" },
	a: { seq: ARROW_RIGHT, insert: true },
	A: { seq: CTRL_E, insert: true },
	I: { seq: CTRL_A, insert: true },
	D: { seq: CTRL_K },
	C: { seq: CTRL_K, insert: true },
	o: { seq: CTRL_E + NEWLINE, insert: true },
	O: { seq: CTRL_A + NEWLINE + ARROW_UP + CTRL_A, insert: true },
	p: { seq: CTRL_Y },
	u: { seq: CTRL_MINUS },
};

class VimEditor extends CustomEditor {
	private mode: "normal" | "insert" = "insert";
	private pending: string | null = null; // for two-key motions (dd, cc)

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.mode === "insert") {
				this.mode = "normal";
			} else {
				super.handleInput(data); // abort agent
			}
			this.pending = null;
			return;
		}

		if (this.mode === "insert") {
			super.handleInput(data);
			return;
		}

		// NORMAL mode. Two-key motions: dd (delete line), cc (change line).
		if (this.pending !== null) {
			const key = this.pending + data;
			this.pending = null;
			if (key === "dd") {
				super.handleInput(CTRL_U); // delete to line start
				super.handleInput(CTRL_K); // then to line end -> empty line
				return;
			}
			if (key === "cc") {
				super.handleInput(CTRL_U);
				super.handleInput(CTRL_K);
				this.mode = "insert";
				return;
			}
			return; // unknown two-key motion: drop
		}

		if (data === "d" || data === "c") {
			this.pending = data;
			return;
		}

		const motion = MOTIONS[data];
		if (motion) {
			if ("mode" in motion) {
				this.mode = "insert";
			} else {
				super.handleInput(motion.seq);
				if (motion.insert) this.mode = "insert";
			}
			return;
		}

		// Pass control sequences (ctrl+c, ctrl+d, etc.) through; swallow
		// printable chars so stray typing in normal mode doesn't leak.
		if (data.length === 1 && data.charCodeAt(0) >= 32) return;
		super.handleInput(data);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;

		const label = this.mode === "normal" ? " NORMAL " : " INSERT ";
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
		}
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, kb) => new VimEditor(tui, theme, kb, { embedWorkingStatus: true }));
	});
}
