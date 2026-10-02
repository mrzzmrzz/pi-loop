# pi-loop

A native-feeling, session-scoped **Loop** extension for [Pi](https://pi.dev) — run a standing prompt repeatedly while your session is open, on a fixed cadence or with model-chosen adaptive pacing. Inspired by the loop features of Claude Code and Grok, rebuilt on Pi's own primitives.

```
/loop 5m check whether the deploy finished
/loop fix the failing tests until they all pass
/loop 每10分钟 检查 CI 状态
/loop
```

## Why

Pi's philosophy is a minimal core with everything else as extensions. Loops are exactly the kind of feature that belongs outside the core: pi-loop adds them without touching Pi internals, and removes cleanly.

- **Fixed loops** re-fire on a wall-clock interval (`5m`, `every 2 hours`, `每5分钟`), skipping missed slots without drifting.
- **Adaptive loops** (no interval given) let the model pace itself: after each iteration it must either `snooze` for 1m–1h with a reason, or `stop` when the task is done. Two iterations without a decision end the loop.
- **Bare `/loop`** starts an adaptive maintenance loop with a built-in prompt (finish pending work, tend the branch/PR, one bounded cleanup pass). Customize it by creating `.pi/loop.md` in your project or `~/.pi/agent/loop.md`.

Loops never overlap agent turns — a due loop waits for the session to go idle, then fires as a follow-up message. Every loop expires after 7 days.

## Install

```bash
pi install git:github.com/mrzzmrzz/pi-loop
```

Or try it for a single run without installing:

```bash
pi -e git:github.com/mrzzmrzz/pi-loop
```

Requires Pi ≥ 1.0.

## Usage

### Slash commands

| Command | Effect |
| --- | --- |
| `/loop <prompt>` | Adaptive loop: the model picks each next delay |
| `/loop 5m <prompt>` | Fixed loop every 5 minutes (interval before or after the prompt) |
| `/loop every hour` | Fixed loop with the default maintenance prompt |
| `/loop` | Adaptive maintenance loop with the default prompt |
| `/loops` (or `/loop list`) | Open the management panel |
| `/loop stop\|pause\|resume\|run <id>` | Manage a loop by ID or unique ID prefix |

Intervals accept English and Chinese forms: `5m`, `1.5h`, `every 2 days`, `每5分钟`, `检查部署 每1小时`. Fixed intervals clamp to 1m–7d. A bare word duration like `an hour` stays a prompt — only digit-led or `every`-prefixed forms schedule, so free text is never misread as an interval.

### Management panel

`/loops` opens an overlay listing every loop with its schedule, status, run count, and expiry:

- `↑↓` move · `r` run now · `p` pause/resume · `x` stop (press twice) · `Esc` close

A one-line footer widget shows loop count and the next due time while any loop exists.

### The `loop_control` tool

The agent manages loops through a single `loop_control` tool: `create`, `list`, `update`, `snooze`, `stop`, `pause`, `resume`, `run_now`. During an adaptive iteration the loop's contract is injected into the system prompt, so the model knows it must snooze or stop before finishing. The tool's `interval` field is explicitly typed, so word forms like `"an hour"` are accepted there.

## Design notes

- **Session-entry event sourcing.** Loop state is persisted as append-only custom entries (`upsert` / `remove` tombstones) in the session log and replayed on `session_start` / `session_tree` — so loops survive restarts and follow Pi's session branching naturally.
- **One scheduler, one save path.** [`extensions/scheduler.ts`](extensions/scheduler.ts) owns the loop table and every timer invariant: TTL expiry (armed even while paused), stale-timer generations, the 32-bit `setTimeout` clamp, and the rule that overdue loops wait for the next idle turn instead of a timer. All mutations flow through `store.save()` = persist + re-arm + re-render.
- **Quiet TUI.** Theme tokens only, no hardcoded colors; the footer widget is installed once and re-renders via `requestRender()` rather than being rebuilt.
- **No global state, no files.** Everything lives in the session. Stopping a loop, closing the session, or the 7-day TTL all clean up completely.

## Development

```bash
npm install
npm run check   # typecheck + tests
```

## License

[MIT](LICENSE)
