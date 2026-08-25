import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import piLoopExtension from "../extensions/index.ts";
import type { LoopRecord } from "../extensions/types.ts";
import {
	hasSecondsCountdown,
	LoopPanel,
	renderLoopWidget,
	truncatePlain,
} from "../extensions/ui.ts";

type Handler = (event: any, ctx: any) => any;

function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const entries: any[] = [];
	const messages: any[] = [];
	const notifications: Array<{ message: string; level: string }> = [];

	const pi: any = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		sendMessage(message: unknown, options?: unknown) {
			messages.push({ message, options });
		},
		sendUserMessage(message: unknown, options?: unknown) {
			messages.push({ userMessage: message, options });
		},
		getCommands() {
			return [];
		},
	};

	const ctx: any = {
		mode: "rpc",
		hasUI: true,
		cwd: process.cwd(),
		sessionManager: {
			getBranch: () => entries,
		},
		isIdle: () => true,
		ui: {
			setWidget() {},
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
	};

	piLoopExtension(pi);

	const emit = async (event: string, payload: any = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};

	const latestLoop = () => {
		const stateEntries = entries.filter(
			(entry) => entry.customType === "pi-loop-state" && entry.data?.op === "upsert",
		);
		return stateEntries.at(-1)?.data.loop;
	};

	return { commands, tools, entries, messages, notifications, ctx, emit, latestLoop };
}

test("fixed slash loop fires immediately and settles without overlap", async () => {
	const harness = createHarness();
	await harness.emit("session_start", { reason: "startup" });
	await harness.commands.get("loop").handler("5m check deploy status", harness.ctx);

	const running = harness.latestLoop();
	assert.equal(running.mode, "fixed");
	assert.equal(running.status, "running");
	assert.equal(running.runCount, 1);
	assert.equal(running.prompt, "check deploy status");
	assert.ok(running.nextRunAt > Date.now());
	assert.equal(harness.messages.length, 1);
	assert.equal(harness.messages[0].message.customType, "pi-loop-fire");

	await harness.emit("agent_settled");
	assert.equal(harness.latestLoop().status, "waiting");
	await harness.emit("session_shutdown", { reason: "quit" });
});

test("adaptive loop requires an explicit next delay and clamps it safely", async () => {
	const harness = createHarness();
	await harness.emit("session_start", { reason: "startup" });
	await harness.commands.get("loop").handler("check whether CI passed", harness.ctx);
	const id = harness.latestLoop().id;

	const tool = harness.tools.get("loop_control");
	const result = await tool.execute(
		"call-1",
		{ action: "snooze", id, delay: "30s", reason: "CI is still running" },
		new AbortController().signal,
		undefined,
		harness.ctx,
	);
	assert.equal(result.details.ok, true);
	assert.match(result.details.message, /adjusted from 30s/);

	await harness.emit("agent_settled");
	const waiting = harness.latestLoop();
	assert.equal(waiting.status, "waiting");
	assert.equal(waiting.awaitingDecision, false);
	assert.equal(waiting.missedDecisions, 0);
	assert.ok(waiting.nextRunAt - Date.now() > 55_000);
	assert.equal(waiting.reason, "CI is still running");
	await harness.emit("session_shutdown", { reason: "quit" });
});

test("tool create accepts word-form intervals as fixed loops", async () => {
	const harness = createHarness();
	await harness.emit("session_start", { reason: "startup" });

	const result = await harness.tools.get("loop_control").execute(
		"call-4",
		{ action: "create", prompt: "check the release branch", interval: "an hour", fireImmediately: false },
		new AbortController().signal,
		undefined,
		harness.ctx,
	);
	assert.equal(result.details.ok, true);

	const loop = harness.latestLoop();
	assert.equal(loop.mode, "fixed");
	assert.equal(loop.intervalMs, 60 * 60_000);
	await harness.emit("session_shutdown", { reason: "quit" });
});

test("session state restores the same loop and stop writes a tombstone", async () => {
	const harness = createHarness();
	await harness.emit("session_start", { reason: "startup" });
	await harness.commands.get("loop").handler("10m review the current PR", harness.ctx);
	await harness.emit("agent_settled");
	const id = harness.latestLoop().id;

	await harness.emit("session_tree");
	const listResult = await harness.tools.get("loop_control").execute(
		"call-2",
		{ action: "list" },
		new AbortController().signal,
		undefined,
		harness.ctx,
	);
	assert.equal(listResult.details.loops.length, 1);
	assert.equal(listResult.details.loops[0].id, id);

	const stopResult = await harness.tools.get("loop_control").execute(
		"call-3",
		{ action: "stop", id: id.slice(0, 4) },
		new AbortController().signal,
		undefined,
		harness.ctx,
	);
	assert.equal(stopResult.details.ok, true);
	assert.ok(
		harness.entries.some(
			(entry) => entry.customType === "pi-loop-state" && entry.data?.op === "remove" && entry.data.id === id,
		),
	);
	await harness.emit("session_shutdown", { reason: "quit" });
});

test("plain truncation emits no ANSI, so box backgrounds survive the ellipsis", () => {
	const truncated = truncatePlain("检查部署状态并汇报所有新的失败用例", 10);
	assert.ok(!truncated.includes("\x1b"));
	assert.ok(truncated.endsWith("..."));
	assert.ok(visibleWidth(truncated) <= 10);
	assert.equal(truncatePlain("short", 10), "short");
});

test("seconds countdown is detected only inside the final minute", () => {
	const now = Date.now();
	const base: LoopRecord = {
		id: "a",
		prompt: "p",
		usesDefaultPrompt: false,
		mode: "fixed",
		intervalMs: 60_000,
		createdAt: now,
		expiresAt: now + 60_000_000,
		runCount: 0,
		status: "waiting",
		overdue: false,
		awaitingDecision: false,
		missedDecisions: 0,
	};
	assert.equal(hasSecondsCountdown([{ ...base, nextRunAt: now + 30_000 }], now), true);
	assert.equal(hasSecondsCountdown([{ ...base, nextRunAt: now + 300_000 }], now), false);
	assert.equal(
		hasSecondsCountdown([{ ...base, status: "paused", nextRunAt: now + 30_000 }], now),
		false,
	);
});

test("Pi-themed widget and management panel render compact loop state", () => {
	const now = Date.now();
	const loop: LoopRecord = {
		id: "abc12345",
		prompt: "check deploy status and report new failures",
		usesDefaultPrompt: false,
		mode: "fixed",
		intervalMs: 5 * 60_000,
		createdAt: now,
		expiresAt: now + 7 * 24 * 60 * 60_000,
		nextRunAt: now + 4 * 60_000,
		runCount: 3,
		status: "waiting",
		overdue: false,
		awaitingDecision: false,
		missedDecisions: 0,
	};
	const theme: any = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};

	const widget = renderLoopWidget([loop], 80, theme).join("\n");
	assert.match(widget, /1 loop/);
	assert.match(widget, /next in 4m/);

	let stopped: string | undefined;
	const panel = new LoopPanel(theme, {
		getLoops: () => [loop],
		runNow() {},
		togglePause() {},
		stop: (id) => {
			stopped = id;
		},
		close() {},
		requestRender() {},
	});
	const panelText = panel.render(60).join("\n");
	assert.match(panelText, /Loops 1/);
	assert.match(panelText, /Every 5m/);
	assert.match(panelText, /check deploy status/);
	panel.handleInput("x");
	panel.handleInput("x");
	assert.equal(stopped, loop.id);
	panel.dispose();
});
