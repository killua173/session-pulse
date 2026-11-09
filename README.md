# session-pulse

A Claude Code mod for long, unattended sessions: Claude keeps working on a heartbeat of wake-ups, you always see when it will next check in, and it tidies up (handoff notes, compaction) instead of idling forever.

## What it does

- **Next wake-up and usage on the status line.** When a wake-up is set, the status line shows `Heartbeat: next wake HH:MM`, the idle count when there is one, and the usage windows: `Heartbeat: next wake 15:40 · 5h 72% · week 40%`.
- **Automatic wake-ups.** While the heartbeat is on, a session never falls asleep with work pending: when a turn ends and nothing will wake it, session-pulse sets a wake-up itself (30 minutes by default). Wake-ups also keep the session inside its one-hour prompt cache, so a long job is not re-read from scratch. Claude can still set its own time; idle counting stops the heartbeat when nothing is left.
- **Usage-limit pause.** When the 5-hour or weekly window reaches 95%, Claude is told once to save its notes and end the turn. If the reset is more than an hour away it also compacts; if it is close it just waits. Either way session-pulse wakes the session 2 minutes after the reset, and the work carries on.
- **Heartbeat rules.** Claude is told how the wake-ups and limits work, and wake-ups longer than 30 minutes are shortened. With automatic wake-ups off, a turn that ends with the heartbeat on but no wake-up set gets one reminder instead.
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
| `autoWake` | on | Set a wake-up of `heartbeatMinutes` when a turn ends with the heartbeat on and none set. |
| `autoStart` | off | Turn the heartbeat on at your first message instead of Claude's first wake-up. Each wake reads the session again, so this costs usage in chat-only sessions. |
| `remindOnStop` | on | Only with `autoWake` off: remind Claude once when the heartbeat is on but no wake-up is set. |
| `usageLimitPercent` | 95 | A usage window at or past this pauses the session until it resets (50 to 100). |
| `resetNearMinutes` | 60 | A reset closer than this: save and wait. Further: save, compact, wait (0 to 600). |
| `resumeMinutes` | 2 | Minutes after the reset when the session is woken (0 to 60). |
| `rules` | on | Add the short heartbeat rules to Claude's instructions. |

## Suggestions

- **Tell Claude where its handoff goes.** In your `CLAUDE.md`, for example: "Before compacting, update `HANDOFF.md` with what is done, what is open and how to restart."
- **Long waits.** For a usage-limit reset session-pulse does this for you. For other waits over an hour, a single wake-up at that time beats many short idle ones.
- **Quieter sessions.** Set `autoWake` and `remindOnStop` off if you only want the status line, the usage pause and the compact tool.
- **Mark real work.** Work that edits no files (running tests, reviewing) counts as idle unless Claude sets `noop: false` on its next wake-up; the rules tell it to.

## Limits

- The idle count lives in the session: reloading the mod or restarting the session starts it at 0.
- session-pulse's own wake-ups (automatic and after a reset) are timers inside the running app: closing Claude Code, or reloading the mod, drops them. Claude's own `ScheduleWakeup` has the same limit.
- Usage figures come from the rate-limit windows Claude Code reports, which exist on a subscription (Pro, Max). Without them the status line shows no usage and the usage pause stays off.
- Background tasks are tracked when Claude starts them with `run_in_background` (or `Monitor`, `Agent`) and their finish notice arrives. A job started some other way (a detached process) is not seen, so tell Claude to keep a watcher on it.

## License

MIT

## Tests

`claude plugin test .` runs `tests/pulse.test.ts`: the wake-up cap, back-to-back idle counting, resets (your message, real work, a finished background task), waiting on a background task, automatic wake-ups, starting on the first message, the usage pause (reset far or near, under the limit), usage on the status line, the reminder, and the options.
