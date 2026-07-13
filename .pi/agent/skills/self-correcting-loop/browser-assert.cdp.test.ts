/**
 * F2 regression: the CDP client must never hang the sensor. A wedged browser
 * (no reply) must time out; a dropped socket must reject in-flight commands.
 * Uses a local WebSocket server that accepts the connection but never replies.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { CDP } from "./browser-assert.ts";

let server: ReturnType<typeof Bun.serve>;
let url: string;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch(req, srv) {
			if (srv.upgrade(req)) return undefined;
			return new Response("no upgrade", { status: 400 });
		},
		websocket: {
			message() {
				/* deliberately never reply - simulate a wedged CDP peer */
			},
		},
	});
	url = `ws://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

test("send() rejects on timeout instead of hanging", async () => {
	const cdp = await CDP.connect(url);
	const t0 = Date.now();
	await expect(cdp.send("Page.enable", {}, undefined, 200)).rejects.toThrow(/timed out/);
	expect(Date.now() - t0).toBeLessThan(3000);
	cdp.close();
});

test("send() rejects when the socket closes mid-flight", async () => {
	const cdp = await CDP.connect(url);
	const inflight = cdp.send("Runtime.evaluate", {}, undefined, 5000);
	cdp.close(); // drop the socket -> failAll rejects pending
	await expect(inflight).rejects.toThrow(/closed/);
});

test("send() after close rejects immediately", async () => {
	const cdp = await CDP.connect(url);
	cdp.close();
	await expect(cdp.send("Page.enable", {}, undefined, 5000)).rejects.toThrow(/closed/);
});
