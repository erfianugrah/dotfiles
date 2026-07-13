#!/usr/bin/env bun
/**
 * browser-assert.ts - a dependency-free headless-browser SENSOR.
 *
 *   bun browser-assert.ts <url> [--wait <cssSelector>] [--assert <jsExpr>]...
 *                         [--timeout <ms>] [--chromium <path>]
 *
 * Launches the system Chromium headless, drives it over the Chrome DevTools
 * Protocol (Bun's built-in WebSocket + fetch - no puppeteer/playwright npm
 * dep), navigates to <url>, optionally waits for a selector, then evaluates
 * each --assert expression in the page. Exits 0 iff every assert is truthy,
 * non-zero otherwise with the actual values printed (good loop feedback).
 *
 * This is the "behaviour harness" layer for web targets: a deterministic,
 * computational browser check you can drop into a manifest sensor, e.g.
 *   { "name": "e2e", "cmd": "bun .../browser-assert.ts http://localhost:4321 \
 *                            --wait '#app' --assert 'document.title.length>0'" }
 *
 * For a running dev server, wrap start/stop around this in the sensor cmd.
 */

interface Args {
	url: string;
	wait?: string;
	asserts: string[];
	timeout: number;
	chromium: string;
}

function parseArgs(argv: string[]): Args {
	const [url, ...rest] = argv;
	if (!url) {
		console.error("usage: bun browser-assert.ts <url> [--wait sel] [--assert expr]...");
		process.exit(2);
	}
	const args: Args = { url, asserts: [], timeout: 15000, chromium: pickChromium() };
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		const v = rest[i + 1];
		if (a === "--wait") { args.wait = v; i++; }
		else if (a === "--assert") { args.asserts.push(v); i++; }
		else if (a === "--timeout") { args.timeout = Number.parseInt(v, 10); i++; }
		else if (a === "--chromium") { args.chromium = v; i++; }
	}
	return args;
}

function pickChromium(): string {
	for (const c of ["/usr/sbin/chromium", "/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"]) {
		try {
			if (Bun.file(c).size >= 0) return c;
		} catch {}
	}
	return "chromium";
}

/** Minimal CDP client over a single WebSocket (flat sessions). */
class CDP {
	private ws: WebSocket;
	private id = 0;
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

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
	}

	static async connect(wsUrl: string): Promise<CDP> {
		const ws = new WebSocket(wsUrl);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error("WS connect failed")), { once: true });
		});
		return new CDP(ws);
	}

	send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
		const id = ++this.id;
		const payload: Record<string, unknown> = { id, method, params };
		if (sessionId) payload.sessionId = sessionId;
		this.ws.send(JSON.stringify(payload));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}

	close() {
		this.ws.close();
	}
}

async function main() {
	const args = parseArgs(Bun.argv.slice(2));
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
			// Chromium 111+ rejects non-browser WS clients without this:
			"--remote-allow-origins=*",
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

		// Wait for document ready (+ optional selector).
		const waitDeadline = Date.now() + args.timeout;
		const readyExpr = args.wait
			? `document.readyState==='complete' && !!document.querySelector(${JSON.stringify(args.wait)})`
			: `document.readyState==='complete'`;
		let ready = false;
		while (Date.now() < waitDeadline) {
			if (await evalExpr(readyExpr)) { ready = true; break; }
			await Bun.sleep(120);
		}
		if (!ready) {
			const title = await evalExpr("document.title").catch(() => "?");
			throw new Error(
				`timed out after ${args.timeout}ms waiting for ${args.wait ? `selector ${args.wait}` : "load"} (title: ${JSON.stringify(title)})`,
			);
		}

		// Run assertions.
		let failed = 0;
		for (const expr of args.asserts) {
			const val = await evalExpr(expr);
			const ok = Boolean(val);
			console.log(`  ${ok ? "PASS" : "FAIL"}  ${expr}  => ${JSON.stringify(val)}`);
			if (!ok) failed++;
		}

		cdp.close();
		await cleanup();
		if (failed > 0) {
			console.error(`browser-assert: ${failed}/${args.asserts.length} assertion(s) failed`);
			process.exit(1);
		}
		console.log(`browser-assert: ${args.asserts.length} assertion(s) passed at ${args.url}`);
		process.exit(0);
	} catch (err) {
		await cleanup();
		console.error(`browser-assert: ${(err as Error).message}`);
		process.exit(1);
	}
}

await main();
