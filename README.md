# session-pulse

A Claude Code mod for long, unattended sessions: Claude keeps working on a heartbeat of wake-ups, you always see when it will next check in, and it tidies up (handoff notes, compaction) instead of idling forever.

## What it does

- **Next wake-up on the status line.** When Claude schedules a wake-up (`ScheduleWakeup` or `CronCreate`), the status line shows `Heartbeat: next wake HH:MM`, plus the idle count when there is one.
- **Heartbeat rules.** Claude is told to keep a wake-up of at most 30 minutes set while work is pending, and wake-ups longer than that are shortened. If a turn ends with the heartbeat on but no wake-up set, Claude is reminded once to set one or stop the heartbeat.
- **Back-to-back idle counting.** A wake-up with nothing to do counts as idle. Only idle wake-ups in a row count: a message from you, a finished background task, or real work (edits, agents, a wake-up marked `noop: false`) resets the count. **Waiting is not idle:** while a background task Claude started is still running (a build, a delegated job), a wake-up does not count. After 2 idle wake-ups in a row, Claude writes its handoff notes, compacts and stops.
- **Self-compaction.** Claude gets a `compact_after_turn` tool, so it can compact its own session (with optional instructions for the summary) instead of you typing `/compact`.
- **Safer one-shot timers.** A one-shot cron pinned to a time that already passed is refused (cron has no year, so it would fire a year later).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-pulse --marketplace killua173/session-pulse
```

Answer `y` to add the marketplace, then pick a scope (user scope is the default).

From a shell:

```
claude plugin install session-pulse --marketplace killua173/session-pulse
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `killua173/session-pulse`, then **Add plugin**.

## Options

Change them in `/config` (each is a row there) or in `settings.json` under `pluginConfigs["session-pulse"].options`.

| Option | Default | What it does |
| --- | --- | --- |
| `heartbeatMinutes` | 30 | Longest wake-up, in minutes (1 to 60). |
| `idleLimit` | 2 | Idle wake-ups in a row before Claude writes its handoff, compacts and stops (1 to 10). |
| `capWakeups` | on | Shorten wake-ups longer than `heartbeatMinutes`. |
| `remindOnStop` | on | Remind Claude once when the heartbeat is on but no wake-up is set. |
| `rules` | on | Add the short heartbeat rules to Claude's instructions. |

## Suggestions

- **Tell Claude where its handoff goes.** In your `CLAUDE.md`, for example: "Before compacting, update `HANDOFF.md` with what is done, what is open and how to restart."
- **Long waits.** If you are waiting on something that takes over an hour (a usage-limit reset), a single wake-up at that time beats many short idle ones: let the idle limit stop the heartbeat, and set one wake-up for the reset.
- **Quieter sessions.** Set `remindOnStop` off if you only want the status line and the compact tool.
- **Mark real work.** Work that edits no files (running tests, reviewing) counts as idle unless Claude sets `noop: false` on its next wake-up; the rules tell it to.

## Limits

- The idle count lives in the session: reloading the mod or restarting the session starts it at 0.
- Background tasks are tracked when Claude starts them with `run_in_background` (or `Monitor`, `Agent`) and their finish notice arrives. A job started some other way (a detached process) is not seen, so tell Claude to keep a watcher on it.

## License

MIT
