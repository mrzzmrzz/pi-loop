import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Focusable } from "@earendil-works/pi-tui";
import { formatDuration, formatInterval, formatRelativeTime } from "./duration.js";
import type { LoopRecord } from "./types.js";

export interface LoopPanelActions {
	getLoops: () => LoopRecord[];
	runNow: (id: string) => void;
	togglePause: (id: string) => void;
	stop: (id: string) => void;
	close: () => void;
	requestRender: () => void;
}

function oneLine(text: string): string {
	return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function promptLabel(loop: LoopRecord): string {
	return loop.usesDefaultPrompt ? "Default maintenance prompt" : oneLine(loop.prompt);
}

function padAnsi(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function statusMark(loop: LoopRecord, theme: Theme): string {
	switch (loop.status) {
		case "running":
			return theme.fg("accent", "↻");
		case "queued":
			return theme.fg("warning", "◌");
		case "paused":
			return theme.fg("muted", "Ⅱ");
		case "error":
			return theme.fg("error", "!");
		default:
			return theme.fg("accent", "◎");
	}
}

function statusText(loop: LoopRecord): string {
	if (loop.status === "running") return "running now";
	if (loop.status === "queued") return "queued for the next idle turn";
	if (loop.status === "paused") return "paused";
	if (loop.status === "error") return loop.lastError ? `error: ${loop.lastError}` : "error";
	if (loop.nextRunAt) return `next ${formatRelativeTime(loop.nextRunAt)}`;
	return "waiting";
}

export function loopSchedule(loop: LoopRecord): string {
	return loop.mode === "adaptive" ? "Adaptive" : formatInterval(loop.intervalMs ?? 60_000);
}

export function renderLoopWidget(loops: LoopRecord[], width: number, theme: Theme): string[] {
	if (loops.length === 0) return [];
	const running = loops.filter((loop) => loop.status === "running").length;
	const queued = loops.filter((loop) => loop.status === "queued").length;
	const next = loops
		.filter((loop) => loop.status !== "paused" && loop.nextRunAt !== undefined)
		.sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0];

	const count = `${loops.length} loop${loops.length === 1 ? "" : "s"}`;
	const parts = [count];
	if (running) parts.push(`${running} running`);
	else if (queued) parts.push(`${queued} queued`);
	else if (next?.nextRunAt) parts.push(`next ${formatRelativeTime(next.nextRunAt)}`);

	const line =
		" " +
		theme.fg("accent", running ? "↻" : "◎") +
		" " +
		theme.fg("dim", parts.join(" · ")) +
		theme.fg("muted", "  /loops");
	return [truncateToWidth(line, width)];
}

export class LoopPanel implements Focusable {
	focused = false;
	private selected = 0;
	private confirmStop?: string;
	private refreshTimer: NodeJS.Timeout;

	constructor(
		private theme: Theme,
		private actions: LoopPanelActions,
	) {
		this.refreshTimer = setInterval(() => this.actions.requestRender(), 5_000);
		this.refreshTimer.unref?.();
	}

	private loops(): LoopRecord[] {
		const loops = this.actions.getLoops().sort((a, b) => a.createdAt - b.createdAt);
		this.selected = Math.min(this.selected, Math.max(0, loops.length - 1));
		return loops;
	}

	private selectedLoop(): LoopRecord | undefined {
		return this.loops()[this.selected];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
			if (this.confirmStop) {
				this.confirmStop = undefined;
				this.actions.requestRender();
				return;
			}
			this.actions.close();
			return;
		}

		const loops = this.loops();
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.confirmStop = undefined;
			this.actions.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = Math.min(Math.max(0, loops.length - 1), this.selected + 1);
			this.confirmStop = undefined;
			this.actions.requestRender();
			return;
		}

		const loop = this.selectedLoop();
		if (!loop) return;
		if (matchesKey(data, "r")) {
			this.confirmStop = undefined;
			this.actions.runNow(loop.id);
			this.actions.requestRender();
			return;
		}
		if (matchesKey(data, "p")) {
			this.confirmStop = undefined;
			this.actions.togglePause(loop.id);
			this.actions.requestRender();
			return;
		}
		if (matchesKey(data, "x")) {
			if (this.confirmStop === loop.id) {
				this.actions.stop(loop.id);
				this.confirmStop = undefined;
			} else {
				this.confirmStop = loop.id;
			}
			this.actions.requestRender();
		}
	}

	render(width: number): string[] {
		const theme = this.theme;
		const innerWidth = Math.max(18, width - 2);
		const lines: string[] = [];
		const row = (content = "") =>
			theme.fg("borderMuted", "│") +
			padAnsi(truncateToWidth(content, innerWidth), innerWidth) +
			theme.fg("borderMuted", "│");
		const rule = (left: string, right: string) =>
			theme.fg("borderMuted", `${left}${"─".repeat(innerWidth)}${right}`);

		const loops = this.loops();
		lines.push(rule("╭", "╮"));
		lines.push(
			row(
				`  ${theme.fg("accent", theme.bold("Loops"))} ${theme.fg("muted", String(loops.length))}${theme.fg("dim", "  ·  session-scoped")}`,
			),
		);
		lines.push(row());

		if (loops.length === 0) {
			lines.push(row(`  ${theme.fg("dim", "No active loops in this session.")}`));
			lines.push(row(`  ${theme.fg("muted", "Try /loop 5m check the deploy")}`));
		} else {
			for (let index = 0; index < loops.length; index++) {
				const loop = loops[index]!;
				const selected = index === this.selected;
				const cursor = selected ? theme.fg("accent", "›") : " ";
				const schedule = selected
					? theme.fg("text", theme.bold(loopSchedule(loop)))
					: theme.fg("text", loopSchedule(loop));
				lines.push(row(` ${cursor} ${statusMark(loop, theme)}  ${schedule}  ${theme.fg("dim", statusText(loop))}`));
				lines.push(
					row(
						`      ${selected ? theme.fg("text", promptLabel(loop)) : theme.fg("dim", promptLabel(loop))}`,
					),
				);
				const meta = [
					`#${loop.id}`,
					`${loop.runCount} run${loop.runCount === 1 ? "" : "s"}`,
					`expires ${formatRelativeTime(loop.expiresAt)}`,
				];
				if (loop.reason) meta.push(loop.reason);
				lines.push(row(`      ${theme.fg("muted", meta.join(" · "))}`));
				if (index !== loops.length - 1) lines.push(row());
			}
		}

		lines.push(row());
		if (this.confirmStop) {
			const loop = loops.find((item) => item.id === this.confirmStop);
			lines.push(
				row(
					`  ${theme.fg("warning", `Stop ${loop ? loopSchedule(loop) : `#${this.confirmStop}`}?`)} ${theme.fg("dim", "press x again · Esc cancel")}`,
				),
			);
		} else {
			lines.push(
				row(
					`  ${theme.fg("dim", "↑↓ move   r run   p pause/resume   x stop   Esc close")}`,
				),
			);
		}
		lines.push(rule("╰", "╯"));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.refreshTimer);
	}
}

export function conciseLoopList(loops: LoopRecord[]): string {
	if (loops.length === 0) return "No active loops in this session.";
	return loops
		.sort((a, b) => a.createdAt - b.createdAt)
		.map((loop) => {
			const next = loop.nextRunAt ? `next ${formatRelativeTime(loop.nextRunAt)}` : loop.status;
			return `#${loop.id} · ${loopSchedule(loop)} · ${next} · ${promptLabel(loop)}`;
		})
		.join("\n");
}

export function loopExpiryLabel(loop: LoopRecord): string {
	return formatDuration(loop.expiresAt - Date.now());
}
