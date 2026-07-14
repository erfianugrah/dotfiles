#!/usr/bin/env bun
/**
 * browser-assert.ts - a dependency-free headless-browser SENSOR + smoke tool.
 *
 *   bun browser-assert.ts <url> [step ...] [--timeout ms] [--chromium path]
 *                         [--viewport WxH] [--full-page]
 *
 * Steps run IN ORDER (so you can script a flow), each is one flag:
 *   --wait <cssSelector>       block until the selector exists
 *   --click <cssSelector>      trusted mouse click at the element centre
 *   --type <cssSelector> <txt> click to focus, then insert text (fires input)
 *   --press <key>              Enter|Tab|Escape|Backspace|Arrow{Up,Down,Left,Right}
 *   --assert <jsExpr>          evaluate in page; must be truthy
 *   --screenshot <path>        write a PNG of the current page (+ --full-page)
 *
 * Drives system Chromium over the Chrome DevTools Protocol (Bun's built-in
 * WebSocket + fetch - no puppeteer/playwright). Exits 0 iff every --assert is
 * truthy and no step errored; non-zero otherwise with actual values printed.
 *
 * Two uses:
 *   sensor  - `... http://localhost:4321 --wait '#app' --assert 'document.title.length>0'`
 *   flow    - `... $URL --click '#login' --type '#email' me@x.com --press Enter
 *                     --wait '#dashboard' --assert '...' --screenshot /tmp/after.png`
 *   smoke   - point <url> at a live/prod deployment; same flags.
 */

export type Step =
	| { kind: "wait"; selector: string }
	| { kind: "click"; selector: string }
	| { kind: "type"; selector: string; text: string }
	| { kind: "press"; key: string }
	| { kind: "assert"; expr: string }
	| { kind: "screenshot"; path: string };

export interface Args {
	url: string;
	steps: Step[];
	timeout: number;
	chromium: string;
	viewport: { width: number; height: number };
	fullPage: boolean;
}

function pickChromium(): string {
	for (const c of [
		"/usr/sbin/chromium",
		"/usr/bin/chromium",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/google-chrome",
	]) {
		try {
			if (Bun.file(c).size >= 0) return c;
		} catch {}
	}
	return "chromium";
}

/** Pure arg parser - ordered steps + flags. Throws on misuse (main exits 2). */
export function parseArgs(argv: string[]): Args {
	const [url, ...rest] = argv;
	if (!url || url.startsWith("--")) {
		throw new Error(
			"usage: browser-assert <url> [--wait sel] [--click sel] [--type sel text] [--press key] [--assert expr] [--screenshot path] [--viewport WxH] [--full-page] [--timeout ms] [--chromium path]",
		);
	}
	const args: Args = {
		url,
		steps: [],
		timeout: 15000,
		chromium: pickChromium(),
		viewport: { width: 1280, height: 800 },
		fullPage: false,
	};
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		const need = () => {
			const v = rest[++i];
			if (v === undefined) throw new Error(`${a} needs an argument`);
			return v;
		};
		switch (a) {
			case "--wait": args.steps.push({ kind: "wait", selector: need() }); break;
			case "--click": args.steps.push({ kind: "click", selector: need() }); break;
			case "--type": {
				const selector = need();
				args.steps.push({ kind: "type", selector, text: need() });
				break;
			}
			case "--press": args.steps.push({ kind: "press", key: need() }); break;
			case "--assert": args.steps.push({ kind: "assert", expr: need() }); break;
			case "--screenshot": args.steps.push({ kind: "screenshot", path: need() }); break;
			case "--viewport": {
				const [w, h] = need().split("x").map((n) => Number.parseInt(n, 10));
				if (!w || !h) throw new Error("--viewport wants WxH, e.g. 1440x900");
				args.viewport = { width: w, height: h };
				break;
			}
			case "--full-page": args.fullPage = true; break;
			case "--timeout": args.timeout = Number.parseInt(need(), 10); break;
			case "--chromium": args.chromium = need(); break;
			default: throw new Error(`unknown flag: ${a}`);
		}
	}
	return args;
}

/** Minimal CDP client over a single WebSocket (flat sessions). */
export class CDP {
	private ws: WebSocket;
	private id = 0;
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
	private closed = false;

	private constructor(ws: WebSocket) {
		this.ws = ws;
		this.ws.addEventListener("message", (ev) => {
			const msg = JSON.parse(ev.data as string);
			if (msg.id && this.pending.has(msg.id)) {
				const { resolve, reject } = this.pending.get(msg.id)!;
				this.pending.delete(msg.id);
				if (msg.error) reject(new Error(msg.error.message));
				else resolve(msg.result);
			}
		});
		// A wedged or dropped browser must never hang the sensor: reject every
		// in-flight command if the socket closes or errors.
		const failAll = (reason: string) => {
			this.closed = true;
			for (const { reject } of this.pending.values()) reject(new Error(reason));
			this.pending.clear();
		};
		this.ws.addEventListener("close", () => failAll("CDP websocket closed"));
		this.ws.addEventListener("error", () => failAll("CDP websocket error"));
	}

	static async connect(wsUrl: string): Promise<CDP> {
		const ws = new WebSocket(wsUrl);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error("WS connect failed")), { once: true });
		});
		return new CDP(ws);
	}

	send(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
		timeoutMs = 15000,
	): Promise<any> {
		if (this.closed) return Promise.reject(new Error("CDP connection is closed"));
		const id = ++this.id;
		const payload: Record<string, unknown> = { id, method, params };
		if (sessionId) payload.sessionId = sessionId;
		this.ws.send(JSON.stringify(payload));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) {
					reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
				}
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => { clearTimeout(timer); resolve(v); },
				reject: (e) => { clearTimeout(timer); reject(e); },
			});
		});
	}

	close() {
		this.closed = true;
		this.ws.close();
	}
}

const KEYS: Record<string, { key: string; code: string; vk: number }> = {
	Enter: { key: "Enter", code: "Enter", vk: 13 },
	Tab: { key: "Tab", code: "Tab", vk: 9 },
	Escape: { key: "Escape", code: "Escape", vk: 27 },
	Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
	ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
	ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
	ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
	ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
};

async function main() {
	let args: Args;
	try {
		args = parseArgs(Bun.argv.slice(2));
	} catch (err) {
		console.error((err as Error).message);
		process.exit(2);
	}

	const port = 30000 + Math.floor(Math.random() * 5000);
	const userDir = `/tmp/browser-assert-${port}-${Date.now()}`;

	const proc = Bun.spawn(
		[
			args.chromium,
			"--headless=new",
			"--disable-gpu",
			"--no-sandbox",
			"--no-first-run",
			"--no-default-browser-check",
			"--hide-scrollbars",
			`--window-size=${args.viewport.width},${args.viewport.height}`,
			"--remote-allow-origins=*", // Chromium 111+ rejects non-browser WS clients otherwise
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${userDir}`,
			"about:blank",
		],
		{ stdout: "ignore", stderr: "ignore" },
	);

	const cleanup = async () => {
		try { proc.kill(); } catch {}
		try { await Bun.$`rm -rf ${userDir}`.quiet(); } catch {}
	};

	try {
		// Discover the browser WebSocket endpoint.
		const deadline = Date.now() + 10000;
		let wsUrl = "";
		while (Date.now() < deadline) {
			try {
				const r = await fetch(`http://127.0.0.1:${port}/json/version`);
				if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; }
			} catch {}
			await Bun.sleep(150);
		}
		if (!wsUrl) throw new Error("chromium devtools endpoint never came up");

		const cdp = await CDP.connect(wsUrl);
		const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
		const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
		await cdp.send("Page.enable", {}, sessionId);
		await cdp.send("Runtime.enable", {}, sessionId);
		await cdp.send("Page.navigate", { url: args.url }, sessionId);

		const evalExpr = async (expr: string) => {
			const r = await cdp.send(
				"Runtime.evaluate",
				{ expression: expr, returnByValue: true, awaitPromise: true },
				sessionId,
			);
			if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text}`);
			return r.result?.value;
		};

		const waitFor = async (selector: string) => {
			const dl = Date.now() + args.timeout;
			while (Date.now() < dl) {
				if (await evalExpr(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
				await Bun.sleep(120);
			}
			return false;
		};

		const centerOf = async (selector: string) =>
			evalExpr(
				`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;` +
					`e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();` +
					`return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`,
			);

		const clickSel = async (selector: string) => {
			if (!(await waitFor(selector))) throw new Error(`click: selector not found: ${selector}`);
			const c = await centerOf(selector);
			if (!c) throw new Error(`click: element has no box: ${selector}`);
			for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
				await cdp.send(
					"Input.dispatchMouseEvent",
					{ type, x: c.x, y: c.y, button: "left", clickCount: 1 },
					sessionId,
				);
			}
		};

		const press = async (keyName: string) => {
			const k = KEYS[keyName];
			if (!k) throw new Error(`press: unsupported key ${keyName} (${Object.keys(KEYS).join("|")})`);
			for (const type of ["keyDown", "keyUp"]) {
				await cdp.send(
					"Input.dispatchKeyEvent",
					{ type, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk },
					sessionId,
				);
			}
		};

		const screenshot = async (path: string) => {
			const params: Record<string, unknown> = { format: "png", captureBeyondViewport: args.fullPage };
			if (args.fullPage) {
				const { cssContentSize } = await cdp.send("Page.getLayoutMetrics", {}, sessionId);
				params.clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
			}
			const { data } = await cdp.send("Page.captureScreenshot", params, sessionId);
			await Bun.write(path, Buffer.from(data as string, "base64"));
			console.log(`  SHOT  ${path}`);
		};

		// Settle: wait for the initial navigation to finish loading.
		const loadDl = Date.now() + args.timeout;
		while (Date.now() < loadDl) {
			if (await evalExpr("document.readyState==='complete'")) break;
			await Bun.sleep(120);
		}

		// Execute steps in order. --assert failures are counted; anything else
		// that goes wrong throws (which fails the sensor).
		let asserts = 0;
		let failed = 0;
		for (const step of args.steps) {
			switch (step.kind) {
				case "wait":
					if (!(await waitFor(step.selector)))
						throw new Error(`timed out after ${args.timeout}ms waiting for ${step.selector}`);
					console.log(`  WAIT  ${step.selector}`);
					break;
				case "click":
					await clickSel(step.selector);
					console.log(`  CLICK ${step.selector}`);
					break;
				case "type":
					await clickSel(step.selector);
					await cdp.send("Input.insertText", { text: step.text }, sessionId);
					console.log(`  TYPE  ${step.selector} <- ${JSON.stringify(step.text)}`);
					break;
				case "press":
					await press(step.key);
					console.log(`  PRESS ${step.key}`);
					break;
				case "screenshot":
					await screenshot(step.path);
					break;
				case "assert": {
					asserts++;
					const val = await evalExpr(step.expr);
					const ok = Boolean(val);
					console.log(`  ${ok ? "PASS" : "FAIL"}  ${step.expr}  => ${JSON.stringify(val)}`);
					if (!ok) failed++;
					break;
				}
			}
		}

		cdp.close();
		await cleanup();
		if (failed > 0) {
			console.error(`browser-assert: ${failed}/${asserts} assertion(s) failed`);
			process.exit(1);
		}
		console.log(`browser-assert: ${asserts} assertion(s) passed at ${args.url}`);
		process.exit(0);
	} catch (err) {
		await cleanup();
		console.error(`browser-assert: ${(err as Error).message}`);
		process.exit(1);
	}
}

if (import.meta.main) await main();
