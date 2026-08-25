import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	formatRelativeTime,
	nextFixedRun,
	normalizeAdaptiveDelay,
	parseDuration,
	parseIntervalArg,
	parseLoopCommand,
	type ParsedDuration,
} from "./duration.js";
import { LoopStore } from "./scheduler.js";
import type {
	LoopFireDetails,
	LoopNotice,
	LoopRecord,
	LoopStateEntry,
	LoopToolDetails,
} from "./types.js";
import { conciseLoopList, LoopPanel, loopSchedule, renderLoopWidget } from "./ui.js";

const STATE_ENTRY = "pi-loop-state";
const NOTICE_ENTRY = "pi-loop-notice";
const FIRE_MESSAGE = "pi-loop-fire";
const WIDGET_ID = "pi-loop";
const LOOP_TTL_MS = 7 * 24 * 60 * 60_000;
const ADAPTIVE_FALLBACK_MS = 20 * 60_000;
const MAX_LOOPS = 50;
const MAX_PROMPT_BYTES = 25_000;

const BUILTIN_MAINTENANCE_PROMPT = `Continue work already authorized in this conversation. First, finish any incomplete task. Then tend to the current branch or pull request: address review comments, failed checks, or merge conflicts. If nothing is pending, do one bounded bug, simplification, or cleanup pass and report the result concisely. Do not start unrelated initiatives. Only take irreversible actions when they clearly continue work the user already authorized.`;

const LoopControlParams = Type.Object({
	action: StringEnum([
		"create",
		"list",
		"update",
		"snooze",
		"stop",
		"pause",
		"resume",
		"run_now",
	] as const),
	id: Type.Optional(Type.String({ description: "Loop ID or unique ID prefix" })),
	prompt: Type.Optional(Type.String({ description: "Standing instruction for each iteration" })),
	interval: Type.Optional(
		Type.String({ description: "Fixed cadence such as 5m, 1 hour, or 2d" }),
	),
	delay: Type.Optional(
		Type.String({ description: "Adaptive snooze delay from 1m to 1h" }),
	),
	reason: Type.Optional(Type.String({ description: "Short reason for the next adaptive delay" })),
	adaptive: Type.Optional(
		Type.Boolean({ description: "On update, switch this loop to adaptive pacing" }),
	),
	fireImmediately: Type.Optional(
		Type.Boolean({ description: "Run the first iteration now; defaults to true" }),
	),
});

function truncateUtf8(text: string, maxBytes = MAX_PROMPT_BYTES): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

function cleanReason(reason: string | undefined): string | undefined {
	if (!reason) return undefined;
	const oneLine = reason.replace(/\s+/g, " ").trim();
	return oneLine ? truncateUtf8(oneLine, 160) : undefined;
}

function readDefaultPrompt(cwd: string): string {
	for (const path of [join(cwd, ".pi", "loop.md"), join(homedir(), ".pi", "agent", "loop.md")]) {
		try {
			if (existsSync(path)) return truncateUtf8(readFileSync(path, "utf8"));
		} catch {
			// Fall through to the next source and finally the built-in prompt.
		}
	}
	return BUILTIN_MAINTENANCE_PROMPT;
}

function firstLine(text: string): string {
	return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function isLoopRecord(value: unknown): value is LoopRecord {
	if (!value || typeof value !== "object") return false;
	const loop = value as Partial<LoopRecord>;
	return (
		typeof loop.id === "string" &&
		typeof loop.prompt === "string" &&
		typeof loop.usesDefaultPrompt === "boolean" &&
		(loop.mode === "fixed" || loop.mode === "adaptive") &&
		typeof loop.createdAt === "number" &&
		typeof loop.expiresAt === "number" &&
		typeof loop.runCount === "number"
	);
}

export default function piLoopExtension(pi: ExtensionAPI) {
	let ctxRef: ExtensionContext | undefined;
	let activeFireId: string | undefined;
	let widgetTui: TUI | undefined;
	let widgetInstalled = false;
	let widgetTicker: NodeJS.Timeout | undefined;

	const store = new LoopStore({
		onDue: (loop) => {
			if (ctxRef) fireLoop(loop, ctxRef);
		},
		onExpired: (loop) => {
			if (activeFireId === loop.id) activeFireId = undefined;
			appendNotice(loop, "expired", "Recurring loops automatically expire after 7 days.");
			ctxRef?.ui.notify(`Loop #${loop.id} expired`, "info");
		},
		persist: (loop) => {
			pi.appendEntry<LoopStateEntry>(STATE_ENTRY, { version: 1, op: "upsert", loop: { ...loop } });
		},
		persistRemoval: (id) => {
			pi.appendEntry<LoopStateEntry>(STATE_ENTRY, { version: 1, op: "remove", id });
		},
		onChange: () => refreshWidget(),
	});

	const effectivePrompt = (loop: LoopRecord): string =>
		loop.usesDefaultPrompt ? readDefaultPrompt(ctxRef?.cwd ?? process.cwd()) : loop.prompt;

	const forgetWidget = () => {
		widgetInstalled = false;
		widgetTui = undefined;
	};

	const refreshWidget = () => {
		const ctx = ctxRef;
		if (!ctx || ctx.mode !== "tui") return;
		if (store.size === 0) {
			forgetWidget();
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}
		if (widgetInstalled) {
			widgetTui?.requestRender();
			return;
		}
		// Install once; renders read live store state, and later changes only
		// request a rerender instead of rebuilding the widget.
		widgetInstalled = true;
		ctx.ui.setWidget(WIDGET_ID, (tui, theme) => {
			widgetTui = tui;
			return {
				render: (width: number) => renderLoopWidget(store.values(), width, theme),
				invalidate: () => {},
			};
		});
	};

	const appendNotice = (loop: LoopRecord, kind: LoopNotice["kind"], reason: string) => {
		pi.appendEntry<LoopNotice>(NOTICE_ENTRY, {
			kind,
			id: loop.id,
			prompt: loop.usesDefaultPrompt ? "Default maintenance prompt" : firstLine(loop.prompt),
			reason,
		});
	};

	const removeLoop = (
		id: string,
		options: { notice?: LoopNotice["kind"]; reason?: string } = {},
	): LoopRecord | undefined => {
		const loop = store.remove(id);
		if (!loop) return undefined;
		if (activeFireId === id) activeFireId = undefined;
		if (options.notice && options.reason) appendNotice(loop, options.notice, options.reason);
		return loop;
	};

	const markQueued = (loop: LoopRecord) => {
		loop.overdue = true;
		if (loop.status !== "running") loop.status = "queued";
		store.save(loop);
	};

	const toolContract = (loop: LoopRecord): string => {
		const common = `\n\nYou are running one bounded iteration of Pi Loop #${loop.id}. Do not wait, sleep, or poll inline. Use the current workspace state and earlier iteration results when available. If the standing instruction's completion condition is satisfied, call loop_control with action \"stop\" and id \"${loop.id}\" before finishing.`;
		if (loop.mode === "fixed") {
			return `${common}\nIf more work remains, finish this iteration normally; the fixed scheduler will run it again.`;
		}
		return `${common}\nIf more work remains, you MUST call loop_control with action \"snooze\", id \"${loop.id}\", a delay from 1m to 1h, and a short reason before finishing. Choose shorter delays while progress is active and longer delays when the external state is quiet.`;
	};

	const shouldExpandPrompt = (prompt: string): boolean => {
		const command = prompt.trim().match(/^\/([^\s]+)/)?.[1];
		if (!command) return false;
		return pi
			.getCommands()
			.some((item) => item.name === command && (item.source === "skill" || item.source === "prompt"));
	};

	const fireLoop = (loop: LoopRecord, ctx: ExtensionContext) => {
		const now = Date.now();
		if (!store.has(loop.id) || loop.status === "paused") return;
		if (loop.expiresAt <= now) {
			store.arm(loop); // arming an expired loop removes it via onExpired
			return;
		}
		if (!ctx.isIdle() || activeFireId) {
			markQueued(loop);
			return;
		}

		store.clearTimer(loop.id);
		const dueAt = loop.nextRunAt ?? now;
		loop.runCount += 1;
		loop.lastRunAt = now;
		loop.status = "running";
		loop.overdue = false;
		loop.lastError = undefined;
		if (loop.mode === "fixed") {
			loop.nextRunAt = nextFixedRun(dueAt, loop.intervalMs ?? 60_000, now);
			loop.awaitingDecision = false;
		} else {
			loop.nextRunAt = undefined;
			loop.awaitingDecision = true;
		}
		activeFireId = loop.id;
		store.save(loop);

		const prompt = truncateUtf8(effectivePrompt(loop));
		const details: LoopFireDetails = {
			id: loop.id,
			mode: loop.mode,
			schedule: loopSchedule(loop),
			prompt: firstLine(prompt),
			runCount: loop.runCount,
			expiresAt: loop.expiresAt,
		};

		try {
			if (shouldExpandPrompt(prompt)) {
				pi.sendMessage({ customType: FIRE_MESSAGE, content: [], display: true, details });
				pi.sendUserMessage(prompt, { deliverAs: "followUp", expandPromptTemplates: true });
			} else {
				pi.sendMessage(
					{ customType: FIRE_MESSAGE, content: prompt, display: true, details },
					{ deliverAs: "followUp", triggerTurn: true },
				);
			}
		} catch (error) {
			activeFireId = undefined;
			loop.status = "error";
			loop.lastError = error instanceof Error ? error.message : String(error);
			if (loop.mode === "adaptive") {
				loop.awaitingDecision = false;
				loop.nextRunAt = Date.now() + ADAPTIVE_FALLBACK_MS;
				loop.reason = "delivery failed; retrying with fallback delay";
			}
			store.save(loop);
			ctx.ui.notify(`Loop #${loop.id} could not start: ${loop.lastError}`, "error");
		}
	};

	const fireNextQueued = (ctx: ExtensionContext) => {
		if (!ctx.isIdle() || activeFireId) return;
		const next = store
			.values()
			.filter((loop) => loop.overdue && loop.status !== "paused")
			.sort((a, b) => (a.nextRunAt ?? a.lastRunAt ?? 0) - (b.nextRunAt ?? b.lastRunAt ?? 0))[0];
		if (next) fireLoop(store.get(next.id) ?? next, ctx);
	};

	const createLoop = (options: {
		prompt: string;
		usesDefaultPrompt: boolean;
		mode: LoopRecord["mode"];
		intervalMs?: number;
		fireImmediately?: boolean;
	}): { loop?: LoopRecord; error?: string } => {
		if (store.size >= MAX_LOOPS) return { error: `This session already has ${MAX_LOOPS} loops.` };
		if (!options.usesDefaultPrompt && !options.prompt.trim()) {
			return { error: "A loop prompt is required." };
		}
		let id = randomBytes(4).toString("hex");
		while (store.has(id)) id = randomBytes(4).toString("hex");
		const now = Date.now();
		const loop: LoopRecord = {
			id,
			prompt: truncateUtf8(options.prompt.trim()),
			usesDefaultPrompt: options.usesDefaultPrompt,
			mode: options.mode,
			intervalMs: options.intervalMs,
			createdAt: now,
			expiresAt: now + LOOP_TTL_MS,
			nextRunAt:
				options.fireImmediately === false
					? now + (options.mode === "fixed" ? (options.intervalMs ?? 60_000) : ADAPTIVE_FALLBACK_MS)
					: now,
			runCount: 0,
			status: "waiting",
			overdue: false,
			awaitingDecision: false,
			missedDecisions: 0,
			reason: options.mode === "adaptive" ? "Pi chooses the next delay after each iteration" : undefined,
		};
		store.save(loop);
		if (loop.nextRunAt !== undefined && loop.nextRunAt <= now && ctxRef) fireLoop(loop, ctxRef);
		return { loop };
	};

	const pauseLoop = (loop: LoopRecord) => {
		loop.status = "paused";
		loop.overdue = false;
		loop.awaitingDecision = false;
		store.save(loop);
	};

	const resumeLoop = (loop: LoopRecord) => {
		const now = Date.now();
		loop.status = "waiting";
		loop.overdue = false;
		if (!loop.nextRunAt || loop.nextRunAt < now) loop.nextRunAt = now;
		store.save(loop);
		if (loop.nextRunAt <= now && ctxRef) fireLoop(loop, ctxRef);
	};

	const runNow = (loop: LoopRecord, ctx: ExtensionContext): string | undefined => {
		if (loop.status === "paused") return "Resume the loop before running it.";
		loop.nextRunAt = Date.now();
		loop.overdue = false;
		store.save(loop);
		fireLoop(loop, ctx);
		return undefined;
	};

	const reconstruct = (ctx: ExtensionContext) => {
		store.reset();
		activeFireId = undefined;
		forgetWidget();

		const replayed = new Map<string, LoopRecord>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			const data = entry.data as LoopStateEntry | undefined;
			if (!data || data.version !== 1) continue;
			if (data.op === "remove" && data.id) replayed.delete(data.id);
			if (data.op === "upsert" && isLoopRecord(data.loop)) replayed.set(data.loop.id, { ...data.loop });
		}

		const now = Date.now();
		for (const loop of replayed.values()) {
			store.restore(loop);
			if (loop.expiresAt <= now) {
				store.arm(loop); // removes the expired loop via onExpired
				continue;
			}
			let changed = false;
			if (loop.status === "running" || loop.status === "queued" || loop.status === "error") {
				loop.status = "waiting";
				loop.overdue = false;
				changed = true;
			}
			if (loop.mode === "fixed") {
				if (!loop.intervalMs) loop.intervalMs = 60_000;
				if (!loop.nextRunAt || loop.nextRunAt < now) loop.nextRunAt = now;
			} else if (loop.status !== "paused" && !loop.nextRunAt) {
				loop.awaitingDecision = false;
				loop.nextRunAt = now + ADAPTIVE_FALLBACK_MS;
				loop.reason = "restored with a 20m fallback delay";
				changed = true;
			}
			if (changed) store.save(loop);
			else store.arm(loop);
		}
		refreshWidget();
	};

	const showPanel = async (ctx: ExtensionCommandContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(conciseLoopList(store.values()), "info");
			return;
		}
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) =>
				new LoopPanel(theme, {
					getLoops: () => store.values(),
					runNow: (id) => {
						const loop = store.get(id);
						if (!loop) return;
						const error = runNow(loop, ctx);
						if (error) ctx.ui.notify(error, "warning");
					},
					togglePause: (id) => {
						const loop = store.get(id);
						if (!loop) return;
						loop.status === "paused" ? resumeLoop(loop) : pauseLoop(loop);
					},
					stop: (id) => {
						removeLoop(id);
					},
					close: () => done(),
					requestRender: () => tui.requestRender(),
				}),
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "76%",
					minWidth: 54,
					maxHeight: "85%",
					margin: 1,
				},
			},
		);
	};

	const toolResult = (details: LoopToolDetails) => ({
		content: [{ type: "text" as const, text: details.message }],
		details,
	});

	pi.registerTool({
		name: "loop_control",
		label: "Loop",
		description:
			"Create and manage session-scoped recurring agent loops. This is the preferred tool when the user explicitly asks for a Loop or recurring in-session agent work. Use create for user-requested recurring work; omit interval for adaptive pacing. During an adaptive loop iteration, call snooze exactly once with a 1m-1h delay or stop when complete. Fixed loops reschedule themselves. Loops run only while this Pi session is open, never overlap agent turns, and expire after 7 days.",
		promptSnippet: "Create, pace, list, update, pause, or stop session-scoped recurring loops",
		promptGuidelines: [
			"When the user explicitly asks for a Loop or recurring in-session agent work, use loop_control rather than schedule_prompt.",
			"During an adaptive Loop iteration, call loop_control snooze with a 1m-1h delay and reason, or stop the Loop when complete.",
		],
		parameters: LoopControlParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const fail = (action: string, message: string) =>
				toolResult({ ok: false, action, message });
			switch (params.action) {
				case "list": {
					const current = store.values();
					return toolResult({
						ok: true,
						action: "list",
						message: conciseLoopList(current),
						loops: current,
					});
				}
				case "create": {
					if (activeFireId) {
						return fail("create", "Do not create a nested loop from a loop iteration; update the current loop instead.");
					}
					if (!params.prompt?.trim()) return fail("create", "prompt is required");
					let interval: ParsedDuration | undefined;
					if (params.interval) {
						interval = parseIntervalArg(params.interval);
						if (!interval) return fail("create", `Invalid interval: ${params.interval}`);
					}
					const created = createLoop({
						prompt: params.prompt,
						usesDefaultPrompt: false,
						mode: interval ? "fixed" : "adaptive",
						intervalMs: interval?.ms,
						fireImmediately: params.fireImmediately ?? true,
					});
					if (!created.loop) return fail("create", created.error ?? "Could not create loop");
					const adjusted = interval?.adjusted ? " · interval adjusted to the 1m–7d range" : "";
					return toolResult({
						ok: true,
						action: "create",
						id: created.loop.id,
						message: `Created Loop #${created.loop.id} · ${loopSchedule(created.loop)} · ${params.fireImmediately === false ? `first run ${formatRelativeTime(created.loop.nextRunAt!)}` : "first run queued now"}${adjusted} · expires in 7d.`,
					});
				}
				case "stop": {
					const resolved = store.resolve(params.id ?? activeFireId);
					if (!resolved.loop) return fail("stop", resolved.error ?? "Loop not found");
					removeLoop(resolved.loop.id);
					return toolResult({ ok: true, action: "stop", id: resolved.loop.id, message: `Stopped Loop #${resolved.loop.id}.` });
				}
				case "pause":
				case "resume": {
					const resolved = store.resolve(params.id);
					if (!resolved.loop) return fail(params.action, resolved.error ?? "Loop not found");
					params.action === "pause" ? pauseLoop(resolved.loop) : resumeLoop(resolved.loop);
					return toolResult({
						ok: true,
						action: params.action,
						id: resolved.loop.id,
						message: `${params.action === "pause" ? "Paused" : "Resumed"} Loop #${resolved.loop.id}.`,
					});
				}
				case "run_now": {
					const resolved = store.resolve(params.id);
					if (!resolved.loop) return fail("run_now", resolved.error ?? "Loop not found");
					const error = runNow(resolved.loop, ctx);
					if (error) return fail("run_now", error);
					return toolResult({ ok: true, action: "run_now", id: resolved.loop.id, message: `Queued Loop #${resolved.loop.id} now.` });
				}
				case "snooze": {
					const resolved = store.resolve(params.id ?? activeFireId);
					if (!resolved.loop) return fail("snooze", resolved.error ?? "Loop not found");
					if (resolved.loop.mode !== "adaptive") return fail("snooze", "Only adaptive loops can snooze; fixed loops reschedule automatically.");
					if (!params.delay) return fail("snooze", "delay is required (1m to 1h)");
					const parsed = parseDuration(params.delay);
					if (parsed === undefined) return fail("snooze", `Invalid delay: ${params.delay}`);
					const normalized = normalizeAdaptiveDelay(parsed);
					resolved.loop.nextRunAt = Date.now() + normalized.ms;
					resolved.loop.awaitingDecision = false;
					resolved.loop.missedDecisions = 0;
					resolved.loop.overdue = false;
					resolved.loop.reason = cleanReason(params.reason) ?? "adaptive delay chosen by Pi";
					if (activeFireId !== resolved.loop.id) resolved.loop.status = "waiting";
					store.save(resolved.loop);
					return toolResult({
						ok: true,
						action: "snooze",
						id: resolved.loop.id,
						message: `Loop #${resolved.loop.id} will continue ${formatRelativeTime(resolved.loop.nextRunAt)}${normalized.adjusted ? ` (adjusted from ${params.delay})` : ""}.`,
					});
				}
				case "update": {
					const resolved = store.resolve(params.id);
					if (!resolved.loop) return fail("update", resolved.error ?? "Loop not found");
					const loop = resolved.loop;
					if (params.prompt !== undefined) {
						if (!params.prompt.trim()) return fail("update", "prompt cannot be empty");
						loop.prompt = truncateUtf8(params.prompt.trim());
						loop.usesDefaultPrompt = false;
					}
					if (params.adaptive) {
						loop.mode = "adaptive";
						loop.intervalMs = undefined;
						loop.nextRunAt = Date.now() + ADAPTIVE_FALLBACK_MS;
						loop.reason = "updated to adaptive pacing";
					} else if (params.interval) {
						const interval = parseIntervalArg(params.interval);
						if (!interval) return fail("update", `Invalid interval: ${params.interval}`);
						loop.mode = "fixed";
						loop.intervalMs = interval.ms;
						loop.nextRunAt = Date.now() + interval.ms;
						loop.reason = undefined;
					}
					loop.awaitingDecision = false;
					loop.missedDecisions = 0;
					store.save(loop);
					return toolResult({ ok: true, action: "update", id: loop.id, message: `Updated Loop #${loop.id} · ${loopSchedule(loop)}.` });
				}
			}
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("↻ Loop"));
			text += theme.fg("muted", `  ${args.action}`);
			if (args.id) text += theme.fg("dim", `  #${args.id}`);
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as LoopToolDetails | undefined;
			if (!details) return new Text("", 0, 0);
			const icon = details.ok ? theme.fg("success", "✓") : theme.fg("error", "!");
			return new Text(`${icon} ${theme.fg(details.ok ? "dim" : "error", details.message)}`, 0, 0);
		},
	});

	pi.registerMessageRenderer<LoopFireDetails>(FIRE_MESSAGE, (message, { expanded, outputPad }, theme) => {
		const details = message.details;
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		if (!details) return box;
		let text =
			theme.fg("customMessageLabel", theme.bold("↻ Loop")) +
			theme.fg("dim", `  ${details.schedule} · run ${details.runCount}`);
		text += `\n${theme.fg("customMessageText", truncateToWidth(details.prompt || "Default maintenance prompt", 100))}`;
		if (expanded) {
			text += `\n${theme.fg("muted", `#${details.id} · expires ${formatRelativeTime(details.expiresAt)}`)}`;
		}
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	pi.registerEntryRenderer<LoopNotice>(NOTICE_ENTRY, (entry, _options, theme) => {
		if (!entry.data) return undefined;
		const icon = entry.data.kind === "expired" ? "◌" : "✓";
		return new Text(
			` ${theme.fg("muted", icon)} ${theme.fg("dim", `Loop #${entry.data.id} ${entry.data.kind}: ${entry.data.prompt} · ${entry.data.reason}`)}`,
			0,
			0,
		);
	});

	pi.registerCommand("loop", {
		description: "Run a prompt repeatedly: /loop [interval] <prompt>",
		handler: async (args, ctx) => {
			const text = args.trim();
			const management = text.match(/^(list|manage|help|stop|cancel|pause|resume|run)(?:\s+(.+))?$/i);
			if (management) {
				const action = management[1]!.toLowerCase();
				const id = management[2]?.trim();
				if (action === "list" || action === "manage") {
					await showPanel(ctx);
					return;
				}
				if (action === "help") {
					ctx.ui.notify("/loop [interval] <prompt> · /loops manage · fixed minimum 1m · adaptive when interval is omitted", "info");
					return;
				}
				const resolved = store.resolve(id);
				if (!resolved.loop) {
					ctx.ui.notify(resolved.error ?? "Loop not found", "error");
					return;
				}
				if (action === "stop" || action === "cancel") removeLoop(resolved.loop.id);
				if (action === "pause") pauseLoop(resolved.loop);
				if (action === "resume") resumeLoop(resolved.loop);
				if (action === "run") {
					const error = runNow(resolved.loop, ctx);
					if (error) {
						ctx.ui.notify(error, "warning");
						return;
					}
				}
				const labels: Record<string, string> = {
					stop: "Stopped",
					cancel: "Stopped",
					pause: "Paused",
					resume: "Resumed",
					run: "Queued",
				};
				ctx.ui.notify(`${labels[action]} Loop #${resolved.loop.id}`, "info");
				return;
			}

			const parsed = parseLoopCommand(text);
			const created = createLoop({
				prompt: parsed.prompt,
				usesDefaultPrompt: parsed.usesDefaultPrompt,
				mode: parsed.mode,
				intervalMs: parsed.intervalMs,
				fireImmediately: true,
			});
			if (!created.loop) {
				ctx.ui.notify(created.error ?? "Could not create loop", "error");
				return;
			}
			const promptNote = created.loop.usesDefaultPrompt
				? " · default maintenance prompt (customize via .pi/loop.md)"
				: "";
			const adjusted = parsed.adjusted ? " · interval adjusted to the 1m–7d range" : "";
			ctx.ui.notify(
				`Loop #${created.loop.id} · ${loopSchedule(created.loop)} · starting now${promptNote} · expires in 7d${adjusted}`,
				"info",
			);
		},
	});

	pi.registerCommand("loops", {
		description: "View and manage loops in this session",
		handler: async (_args, ctx) => showPanel(ctx),
	});

	pi.on("before_agent_start", (event) => {
		const loop = activeFireId ? store.get(activeFireId) : undefined;
		if (!loop) return;
		return { systemPrompt: event.systemPrompt + toolContract(loop) };
	});

	pi.on("agent_settled", (_event, ctx) => {
		const id = activeFireId;
		activeFireId = undefined;
		if (id) {
			const loop = store.get(id);
			if (loop) {
				if (loop.mode === "adaptive" && loop.awaitingDecision) {
					loop.missedDecisions += 1;
					loop.awaitingDecision = false;
					if (loop.missedDecisions >= 2) {
						removeLoop(loop.id, {
							notice: "stopped",
							reason: "The adaptive loop ended after two iterations did not choose a next delay.",
						});
					} else {
						loop.nextRunAt = Date.now() + ADAPTIVE_FALLBACK_MS;
						loop.status = "waiting";
						loop.reason = "fallback delay because no next interval was chosen";
						store.save(loop);
					}
				} else if (store.has(loop.id) && loop.status !== "paused") {
					loop.status = loop.overdue ? "queued" : "waiting";
					store.save(loop);
				}
			}
		}
		refreshWidget();
		queueMicrotask(() => fireNextQueued(ctx));
	});

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		reconstruct(ctx);
		if (widgetTicker) clearInterval(widgetTicker);
		widgetTicker = setInterval(refreshWidget, 10_000);
		widgetTicker.unref?.();
	});

	pi.on("session_tree", (_event, ctx) => {
		ctxRef = ctx;
		reconstruct(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		store.reset();
		if (widgetTicker) clearInterval(widgetTicker);
		widgetTicker = undefined;
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_ID, undefined);
		forgetWidget();
		ctxRef = undefined;
		activeFireId = undefined;
	});
}
