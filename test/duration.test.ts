import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_FIXED_INTERVAL_MS,
	MIN_INTERVAL_MS,
	formatInterval,
	nextFixedRun,
	parseDuration,
	parseIntervalArg,
	parseLoopCommand,
} from "../extensions/duration.ts";

test("bare loop uses the adaptive default prompt", () => {
	assert.deepEqual(parseLoopCommand(""), {
		mode: "adaptive",
		prompt: "",
		usesDefaultPrompt: true,
	});
});

test("prompt-only loop uses adaptive pacing", () => {
	assert.deepEqual(parseLoopCommand("check whether CI passed"), {
		mode: "adaptive",
		prompt: "check whether CI passed",
		usesDefaultPrompt: false,
	});
});

test("fixed intervals work before or after the prompt", () => {
	assert.deepEqual(parseLoopCommand("5m check deploy status"), {
		mode: "fixed",
		prompt: "check deploy status",
		usesDefaultPrompt: false,
		intervalMs: 5 * 60_000,
		adjusted: false,
	});
	assert.equal(parseLoopCommand("check deploy status every hour").intervalMs, 60 * 60_000);
	assert.equal(parseLoopCommand("every 2 days summarize new commits").intervalMs, 2 * 24 * 60 * 60_000);
});

test("interval-only loop uses the default maintenance prompt", () => {
	const parsed = parseLoopCommand("15m");
	assert.equal(parsed.mode, "fixed");
	assert.equal(parsed.usesDefaultPrompt, true);
	assert.equal(parsed.intervalMs, 15 * 60_000);
});

test("Chinese interval forms are supported", () => {
	assert.equal(parseLoopCommand("每5分钟检查部署").intervalMs, 5 * 60_000);
	assert.equal(parseLoopCommand("检查部署 每1小时").intervalMs, 60 * 60_000);
	assert.equal(parseLoopCommand("每5分钟检查部署").prompt, "检查部署");
});

test("fixed intervals are bounded to one minute and seven days", () => {
	const short = parseLoopCommand("30s check");
	assert.equal(short.intervalMs, MIN_INTERVAL_MS);
	assert.equal(short.adjusted, true);

	const long = parseLoopCommand("10d check");
	assert.equal(long.intervalMs, MAX_FIXED_INTERVAL_MS);
	assert.equal(long.adjusted, true);
});

test("duration parser accepts natural singular units", () => {
	assert.equal(parseDuration("hour"), 60 * 60_000);
	assert.equal(parseDuration("an hour"), 60 * 60_000);
	assert.equal(parseDuration("2.5h"), 2.5 * 60 * 60_000);
	assert.equal(parseDuration("nonsense"), undefined);
});

test("bare word durations stay prompts, but typed interval args accept them", () => {
	// "/loop an hour" is ambiguous text, so it remains an adaptive prompt.
	assert.deepEqual(parseLoopCommand("an hour"), {
		mode: "adaptive",
		prompt: "an hour",
		usesDefaultPrompt: false,
	});
	// The loop_control interval field carries no ambiguity, so word forms parse.
	assert.deepEqual(parseIntervalArg("an hour"), {
		ms: 60 * 60_000,
		originalMs: 60 * 60_000,
		adjusted: false,
	});
	assert.equal(parseIntervalArg("30s")?.ms, MIN_INTERVAL_MS);
	assert.equal(parseIntervalArg("30s")?.adjusted, true);
	assert.equal(parseIntervalArg("nonsense"), undefined);
});

test("fixed cadence skips missed slots without drifting", () => {
	assert.equal(nextFixedRun(1_000, 1_000, 1_000), 2_000);
	assert.equal(nextFixedRun(1_000, 1_000, 3_400), 4_000);
	assert.equal(nextFixedRun(5_000, 1_000, 3_400), 5_000);
});

test("interval labels remain compact", () => {
	assert.equal(formatInterval(5 * 60_000), "Every 5m");
	assert.equal(formatInterval(2 * 60 * 60_000), "Every 2h");
});
