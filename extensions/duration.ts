export const MIN_INTERVAL_MS = 60_000;
export const MAX_FIXED_INTERVAL_MS = 7 * 24 * 60 * 60_000;
export const MIN_ADAPTIVE_DELAY_MS = 60_000;
export const MAX_ADAPTIVE_DELAY_MS = 60 * 60_000;

const NUMBER = String.raw`\d+(?:\.\d+)?`;
const EN_UNIT = String.raw`(?:seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|d)`;
const ZH_UNIT = String.raw`(?:秒|分钟|分鐘|小时|小時|天)`;
const NUMERIC_DURATION = String.raw`${NUMBER}\s*(?:${EN_UNIT}|${ZH_UNIT})`;
const WORD_DURATION = String.raw`(?:(?:${NUMBER}|an?|one)\s*)?${EN_UNIT}`;
const SEP = String.raw`(?:\s*[,，:：-]\s*|\s+)`;

// Ordered forms that read a fixed interval plus an optional prompt out of
// /loop text. Bare leading durations stay digit-led on purpose: "5m check X"
// schedules, but a plain "an hour" remains a prompt rather than an interval.
const FIXED_FORMS: RegExp[] = [
	new RegExp(`^every\\s+(?<dur>${WORD_DURATION})(?:${SEP}(?<prompt>.+))?$`, "i"),
	new RegExp(`^每\\s*(?<dur>${NUMERIC_DURATION})\\s*[,，:：-]?\\s*(?<prompt>.+)?$`, "i"),
	new RegExp(`^(?<dur>${NUMERIC_DURATION})(?:${SEP}(?<prompt>.+))?$`, "i"),
	new RegExp(`^(?<prompt>.+?)(?:\\s+|[,，]\\s*)every\\s+(?<dur>${WORD_DURATION})$`, "i"),
	new RegExp(`^(?<prompt>.+?)\\s*每\\s*(?<dur>${NUMERIC_DURATION})$`, "i"),
];

export interface ParsedDuration {
	ms: number;
	originalMs: number;
	adjusted: boolean;
}

export interface ParsedLoopCommand {
	mode: "fixed" | "adaptive";
	prompt: string;
	usesDefaultPrompt: boolean;
	intervalMs?: number;
	adjusted?: boolean;
}

function unitMultiplier(unit: string): number | undefined {
	switch (unit.toLowerCase()) {
		case "s":
		case "sec":
		case "secs":
		case "second":
		case "seconds":
		case "秒":
			return 1_000;
		case "m":
		case "min":
		case "mins":
		case "minute":
		case "minutes":
		case "分钟":
		case "分鐘":
			return 60_000;
		case "h":
		case "hr":
		case "hrs":
		case "hour":
		case "hours":
		case "小时":
		case "小時":
			return 60 * 60_000;
		case "d":
		case "day":
		case "days":
		case "天":
			return 24 * 60 * 60_000;
		default:
			return undefined;
	}
}

export function parseDuration(raw: string): number | undefined {
	const match = raw
		.trim()
		.toLowerCase()
		.match(/^(?:(\d+(?:\.\d+)?)|an?|one)?\s*(seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|d|秒|分钟|分鐘|小时|小時|天)$/i);
	if (!match) return undefined;

	const value = match[1] === undefined ? 1 : Number(match[1]);
	const unit = match[2];
	const multiplier = unit ? unitMultiplier(unit) : undefined;
	if (!multiplier || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.round(value * multiplier);
}

export function normalizeFixedInterval(ms: number): ParsedDuration {
	const normalized = Math.min(MAX_FIXED_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, ms));
	return { ms: normalized, originalMs: ms, adjusted: normalized !== ms };
}

export function normalizeAdaptiveDelay(ms: number): ParsedDuration {
	const normalized = Math.min(MAX_ADAPTIVE_DELAY_MS, Math.max(MIN_ADAPTIVE_DELAY_MS, ms));
	return { ms: normalized, originalMs: ms, adjusted: normalized !== ms };
}

// Explicitly typed interval arguments (the loop_control tool) carry no prompt
// ambiguity, so word forms like "an hour" are accepted here even though bare
// /loop text keeps them as prompts.
export function parseIntervalArg(raw: string): ParsedDuration | undefined {
	const ms = parseDuration(raw);
	return ms === undefined ? undefined : normalizeFixedInterval(ms);
}

function fixed(prompt: string, rawDuration: string): ParsedLoopCommand | undefined {
	const parsed = parseDuration(rawDuration);
	if (parsed === undefined) return undefined;
	const normalized = normalizeFixedInterval(parsed);
	const cleanPrompt = prompt.trim().replace(/^[,，:：-]+\s*/, "");
	return {
		mode: "fixed",
		prompt: cleanPrompt,
		usesDefaultPrompt: cleanPrompt.length === 0,
		intervalMs: normalized.ms,
		adjusted: normalized.adjusted,
	};
}

export function parseLoopCommand(input: string): ParsedLoopCommand {
	const text = input.trim();
	if (!text) {
		return { mode: "adaptive", prompt: "", usesDefaultPrompt: true };
	}

	for (const form of FIXED_FORMS) {
		const groups = text.match(form)?.groups;
		if (!groups?.dur) continue;
		const command = fixed(groups.prompt ?? "", groups.dur);
		if (command) return command;
	}

	return { mode: "adaptive", prompt: text, usesDefaultPrompt: false };
}

export function nextFixedRun(dueAt: number, intervalMs: number, now = Date.now()): number {
	if (dueAt > now) return dueAt;
	const elapsed = Math.max(0, now - dueAt);
	return dueAt + (Math.floor(elapsed / intervalMs) + 1) * intervalMs;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

export function formatInterval(ms: number): string {
	const seconds = Math.round(ms / 1_000);
	if (seconds < 60) return `Every ${seconds}s`;
	const minutes = seconds / 60;
	if (Number.isInteger(minutes) && minutes < 60) return `Every ${minutes}m`;
	const hours = minutes / 60;
	if (Number.isInteger(hours) && hours < 48) return `Every ${hours}h`;
	const days = hours / 24;
	if (Number.isInteger(days)) return `Every ${days}d`;
	return `Every ${formatDuration(ms)}`;
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
	const diff = timestamp - now;
	if (Math.abs(diff) < 1_000) return "now";
	return diff > 0 ? `in ${formatDuration(diff)}` : `${formatDuration(-diff)} ago`;
}
