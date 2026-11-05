# session-pulse

A small Claude Code mod for long, unattended sessions.

- **Heartbeat on the status line.** When Claude schedules a wake-up (`ScheduleWakeup` or `CronCreate`), the status line shows `Heartbeat: next wake HH:MM`, so you always know when it will check in next. Cancelling a wake-up says so.
- **Safer one-shot timers.** A one-shot cron pinned to a time that has already passed is refused (cron has no year, so it would otherwise fire a year later).
- **Self-compaction.** Claude gets a `compact_after_turn` tool. When its work is done (or your own rules say so), it can compact its own session instead of you typing `/compact`. The compaction runs right after the turn ends, with optional instructions for what the summary should keep.

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

## Using it

Nothing to configure. The heartbeat line appears by itself. To let Claude compact on its own, tell it when, for example in your `CLAUDE.md`:

> When a task is finished and the handoff notes are written, call `compact_after_turn`.

## License

MIT
