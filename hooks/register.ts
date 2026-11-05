import type { Register } from 'claude-code'

// session-pulse: two small helpers for long, unattended Claude Code sessions.
//
// 1. Heartbeat on the status line. Whenever Claude schedules a wake-up (ScheduleWakeup or CronCreate),
//    the status line shows when it will next wake, so you never have to ask.
// 2. Self-compaction. Claude gets a `compact_after_turn` tool. Compaction only runs between turns, so the
//    tool marks a request and the session is compacted right after the turn that asked has ended.

const TOOL = 'compact_after_turn'

const hhmm = (at: Date) => `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`

let pending: { instructions?: string } | null = null

export const register: Register = (on) => {
  // ---- Heartbeat ---------------------------------------------------------------------------------

  on('tool.call', { tool: 'ScheduleWakeup' }, async ($, e, next) => {
    const result = await next(e)
    try {
      const input = e as unknown as { delaySeconds?: unknown; stop?: unknown }
      if (input.stop === true) {
        $.ui.status('Heartbeat: off')
      } else if (typeof input.delaySeconds === 'number') {
        // The runtime clamps wake-ups to 1 minute .. 1 hour.
        const seconds = Math.min(3600, Math.max(60, input.delaySeconds))
        $.ui.status(`Heartbeat: next wake ${hhmm(new Date(Date.now() + seconds * 1000))}`)
      }
    } catch {
      // Showing the time must never break the wake-up itself.
    }
    return result
  })

  on('tool.call', { tool: 'CronCreate' }, async ($, e, next) => {
    // Cron has no year, so a one-shot pinned to a time that already passed would fire next year.
    try {
      const input = e as unknown as { cron?: unknown; recurring?: unknown }
      const fields = typeof input.cron === 'string' ? input.cron.trim().split(/\s+/) : []
      if (input.recurring === false && fields.length === 5 && fields.slice(0, 4).every((f) => /^\d+$/.test(f))) {
        const [minute = 0, hour = 0, day = 1, month = 1] = fields.map(Number)
        const now = new Date()
        const at = new Date(now.getFullYear(), month - 1, day, hour, minute)
        if (at.getTime() <= now.getTime()) {
          return { deny: `Pinned time ${hhmm(at)} on ${day}/${month} has already passed (now ${hhmm(now)}); it would fire next year. Use a recurring cron or a future time.` }
        }
      }
    } catch {
      // A guard failure must not block the call.
    }
    const result = await next(e)
    try {
      // The result text says e.g. "Next run: Nov 4 10:11am."
      const found = JSON.stringify(result).match(/Next run: ([^.]+?)\./)
      if (found) $.ui.status(`Heartbeat: next wake ${found[1]}`)
    } catch {
      // Never break the cron call.
    }
    return result
  })

  on('tool.call', { tool: 'CronDelete' }, async ($, e, next) => {
    const result = await next(e)
    try {
      $.ui.status('Heartbeat: a scheduled wake was cancelled')
    } catch {
      // Never break the cron call.
    }
    return result
  })

  // ---- Self-compaction ---------------------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL,
      description:
        'Compacts this session after the current turn ends (the same as the person typing /compact). ' +
        'Use only when the person asked for it or a standing rule says to; write any handoff notes first. ' +
        'Optional `instructions`: what the summary must keep.',
      inputSchema: {
        type: 'object',
        properties: { instructions: { type: 'string', description: 'What the summary should keep or stress.' } },
      },
      isDeferred: false,
    })
    return next(e)
  })

  on('tool.call', { tool: `mcp__session-pulse__${TOOL}` }, async ($, e) => {
    try {
      const input = (e as unknown as { input?: { instructions?: unknown } }).input
      const instructions = typeof input?.instructions === 'string' && input.instructions.trim() ? input.instructions : undefined
      pending = { instructions }
      $.ui.status('Will compact when this turn ends')
      return { result: 'The session will be compacted when this turn ends. End the turn now.' }
    } catch (error) {
      return { deny: `Could not schedule compaction: ${error instanceof Error ? error.message : String(error)}` }
    }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (pending) {
      const request = pending
      pending = null
      // Wait for the turn to settle: compaction is refused while a turn runs.
      $.clock.after(1500, async () => {
        const args = request.instructions ?? ''
        const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
        try {
          const outcome = await $.session.compact(request.instructions ? { instructions: request.instructions } : {})
          $.ui.status(undefined)
          if (outcome && 'skip' in outcome && outcome.skip) $.ui.toast(`Compaction skipped: ${String(outcome.skip)}`)
        } catch (direct) {
          // Some hosts (the desktop app) run the engine headless, where compaction only runs as /compact.
          try {
            await $.command.run({ command: 'compact', args })
            $.ui.status(undefined)
          } catch (command) {
            try {
              await $.prompt.submit({ text: args ? `/compact ${args}` : '/compact' })
              $.ui.status(undefined)
            } catch (prompt) {
              $.ui.status(undefined)
              $.ui.toast(`Could not compact: ${message(direct)} / ${message(command)} / ${message(prompt)}`)
            }
          }
        }
      })
    }
    return done
  })
}
