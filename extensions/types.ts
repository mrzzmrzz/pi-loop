export type LoopMode = "fixed" | "adaptive";
export type LoopStatus = "waiting" | "queued" | "running" | "paused" | "error";

export interface LoopRecord {
	id: string;
	prompt: string;
	usesDefaultPrompt: boolean;
	mode: LoopMode;
	intervalMs?: number;
	createdAt: number;
	expiresAt: number;
	nextRunAt?: number;
	lastRunAt?: number;
	runCount: number;
	status: LoopStatus;
	overdue: boolean;
	awaitingDecision: boolean;
	missedDecisions: number;
	reason?: string;
	lastError?: string;
}

export interface LoopStateEntry {
	version: 1;
	op: "upsert" | "remove";
	loop?: LoopRecord;
	id?: string;
}

export interface LoopFireDetails {
	id: string;
	mode: LoopMode;
	schedule: string;
	prompt: string;
	runCount: number;
	expiresAt: number;
}

export interface LoopNotice {
	kind: "expired" | "stopped";
	id: string;
	prompt: string;
	reason: string;
}

export interface LoopToolDetails {
	ok: boolean;
	action: string;
	message: string;
	id?: string;
	loops?: LoopRecord[];
}
