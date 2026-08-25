import type { LoopRecord } from "./types.js";

// Node caps setTimeout at 2^31-1 ms; longer waits re-arm from the timer.
const MAX_TIMEOUT_MS = 2_147_000_000;

export interface LoopStoreEvents {
	/** A runnable loop's nextRunAt arrived. The receiver decides how to fire it. */
	onDue(loop: LoopRecord): void;
	/** A loop passed its TTL and has already been removed from the store. */
	onExpired(loop: LoopRecord): void;
	persist(loop: LoopRecord): void;
	persistRemoval(id: string): void;
	/** Visible state changed; refresh widgets or panels. */
	onChange(): void;
}

/**
 * Owns the in-memory loop table and its timers. All timer invariants live
 * here: TTL expiry (kept armed even while paused), stale-timer generations,
 * and the rule that overdue loops wait for the next idle turn, not a timer.
 */
export class LoopStore {
	private loops = new Map<string, LoopRecord>();
	private timers = new Map<string, NodeJS.Timeout>();
	private generation = 0;

	constructor(private events: LoopStoreEvents) {}

	get size(): number {
		return this.loops.size;
	}

	get(id: string): LoopRecord | undefined {
		return this.loops.get(id);
	}

	has(id: string): boolean {
		return this.loops.has(id);
	}

	values(): LoopRecord[] {
		return [...this.loops.values()].map((loop) => ({ ...loop }));
	}

	resolve(id: string | undefined): { loop?: LoopRecord; error?: string } {
		if (!id) return { error: "A loop ID is required." };
		const exact = this.loops.get(id);
		if (exact) return { loop: exact };
		const matches = [...this.loops.values()].filter((loop) => loop.id.startsWith(id));
		if (matches.length === 1) return { loop: matches[0] };
		if (matches.length > 1) return { error: `Loop prefix #${id} is ambiguous.` };
		return { error: `Loop #${id} was not found in this session.` };
	}

	/** Add or update a loop: persist, re-arm, notify. */
	save(loop: LoopRecord): void {
		this.loops.set(loop.id, loop);
		this.events.persist(loop);
		this.arm(loop);
		this.events.onChange();
	}

	remove(id: string): LoopRecord | undefined {
		const loop = this.loops.get(id);
		if (!loop) return undefined;
		this.clearTimer(id);
		this.loops.delete(id);
		this.events.persistRemoval(id);
		this.events.onChange();
		return loop;
	}

	/** Load a replayed loop without appending a redundant session entry. */
	restore(loop: LoopRecord): void {
		this.loops.set(loop.id, loop);
	}

	/** Drop all loops and timers; invalidates in-flight timer callbacks. */
	reset(): void {
		this.generation += 1;
		for (const id of this.timers.keys()) this.clearTimer(id);
		this.loops.clear();
	}

	clearTimer(id: string): void {
		const timer = this.timers.get(id);
		if (timer) clearTimeout(timer);
		this.timers.delete(id);
	}

	arm(loop: LoopRecord): void {
		this.clearTimer(loop.id);
		if (!this.loops.has(loop.id)) return;
		const now = Date.now();
		if (loop.expiresAt <= now) {
			this.expire(loop);
			return;
		}
		// Overdue loops are woken by the next idle turn, not by a timer.
		if (loop.overdue) return;
		// Paused loops keep only their TTL deadline armed.
		const next = loop.status === "paused" ? loop.expiresAt : (loop.nextRunAt ?? loop.expiresAt);
		const target = Math.min(loop.expiresAt, next);
		const wait = Math.max(0, Math.min(MAX_TIMEOUT_MS, target - now));
		const generation = this.generation;
		const timer = setTimeout(() => {
			if (generation !== this.generation) return;
			this.onTimer(loop.id);
		}, wait);
		timer.unref?.();
		this.timers.set(loop.id, timer);
	}

	private expire(loop: LoopRecord): void {
		this.remove(loop.id);
		this.events.onExpired(loop);
	}

	private onTimer(id: string): void {
		const loop = this.loops.get(id);
		if (!loop) return;
		const now = Date.now();
		if (loop.expiresAt <= now) {
			this.expire(loop);
			return;
		}
		if (loop.status === "paused" || loop.nextRunAt === undefined || loop.nextRunAt > now) {
			this.arm(loop);
			return;
		}
		this.events.onDue(loop);
	}
}
