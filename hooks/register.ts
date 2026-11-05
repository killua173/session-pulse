import type { Register } from 'claude-code'

// session-pulse: helpers for long, unattended Claude Code sessions.
//
// 1. Heartbeat on the status line: when Claude schedules a wake-up (ScheduleWakeup or CronCreate), the
//    status line shows when it will next wake.
// 2. Heartbeat rules (options in /config): wake-ups are capped at `heartbeatMinutes`; when a turn ends
//    with no wake-up set while a heartbeat is running, Claude is reminded once to set one or stop.
// 3. Idle counting: a wake-up turn that does nothing counts as idle. Only idle wake-ups back to back
//    count; any message from you, a finished background task, or real work resets the count. While a
//    background task Claude started is still running (a build, a delegated job), a wake is waiting,
//    not idle. After `idleLimit` idle wake-ups Claude is told to write its handoff notes, compact and stop.
// 4. Self-compaction: Claude gets a `compact_after_turn` tool. Compaction only runs between turns, so the
//    tool marks a request and the session is compacted right after the turn that asked has ended.

const TOOL = 'compact_after_turn'
const PLUGIN = 'session-pulse'

// Tools whose use means the wake did real work.
const WORK_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'Agent', 'Task'])
// Tools that can start a background task that later reports back.
const BACKGROUND_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor', 'Agent', 'Task'])

const hhmm = (at: Date) => `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`

function num(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
}

// Module state (a reload starts it over, which only resets the idle count).
let pending: { instructions?: string } | null = null
let heartbeatOn = false // a wake-up was scheduled in this session and not stopped
let nextWakeAt: number | null = null // ScheduleWakeup's next fire time
let cronActive = false // a CronCreate wake is set (its time is the scheduler's)
let idleCount = 0 // idle wake-ups back to back
const wakePrompts = new Set<string>()
const running = new Set<string>() // background task ids still running
let turn: { wake: boolean; worked: boolean } | null = null

export const register: Register = (on, options) => {
  const maxMinutes = num(options.heartbeatMinutes, 30, 1, 60)
  const idleLimit = num(options.idleLimit, 2, 1, 10)
  const capWakeups = options.capWakeups !== false
  const remindOnStop = options.remindOnStop !== false
  const addRules = options.rules !== false

  const withIdle = (prefix: string) => (idleCount > 0 ? `${prefix} (idle ${idleCount} of ${idleLimit})` : prefix)

  // ---- Instructions --------------------------------------------------------------------------------

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!addRules) return result
    const text = [
      'Heartbeat rules (session-pulse):',
      `- While work is pending and nobody is waiting on you, keep a wake-up set (ScheduleWakeup) of at most ${maxMinutes} minutes.`,
      '- Waiting for something you started (a build, a background job, another agent) is not idle: use the wait for other useful work, and set noop: false on wake-ups where you did real work.',
      `- Idle means a wake-up with nothing to do and nothing of yours still running. After ${idleLimit} idle wake-ups back to back, write your handoff notes, call ${TOOL}, set no more wake-ups, and stop. A message from the person resets the count.`,
      '- When nothing at all is left, stop the heartbeat (ScheduleWakeup with stop: true) instead of setting another wake-up.',
    ].join('\n')
    return { ...result, sections: [...result.sections, { id: `${PLUGIN}:rules`, text, scope: 'session' as const }] }
  })

  // ---- Heartbeat -----------------------------------------------------------------------------------

  on('tool.call', { tool: 'ScheduleWakeup' }, async ($, e, next) => {
    const input = e as unknown as { delaySeconds?: unknown; stop?: unknown; prompt?: unknown; noop?: unknown }
    let call = e
    try {
      if (capWakeups && typeof input.delaySeconds === 'number' && input.delaySeconds > maxMinutes * 60) {
        call = { ...e, delaySeconds: maxMinutes * 60 } as typeof e
      }
    } catch {
      // Never block the wake-up.
    }
    const result = await next(call)
    try {
      const delay = (call as unknown as { delaySeconds?: unknown }).delaySeconds
      if (input.stop === true) {
        heartbeatOn = false
        nextWakeAt = null
        $.ui.status('Heartbeat: off')
      } else if (typeof delay === 'number') {
        // The runtime clamps wake-ups to 1 minute .. 1 hour.
        const seconds = Math.min(3600, Math.max(60, delay))
        heartbeatOn = true
        nextWakeAt = Date.now() + seconds * 1000
        if (typeof input.prompt === 'string' && input.prompt.trim()) wakePrompts.add(input.prompt.trim())
        if (input.noop === false && turn) turn.worked = true
        const capped = delay !== input.delaySeconds ? ` (capped to ${maxMinutes} min)` : ''
        $.ui.status(withIdle(`Heartbeat: next wake ${hhmm(new Date(nextWakeAt))}${capped}`))
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
      const prompt = (e as unknown as { prompt?: unknown }).prompt
      if (typeof prompt === 'string' && prompt.trim()) wakePrompts.add(prompt.trim())
      // The result text says e.g. "Next run: Nov 4 10:11am."
      const found = JSON.stringify(result).match(/Next run: ([^.]+?)\./)
      if (found) {
        heartbeatOn = true
        cronActive = true
        $.ui.status(withIdle(`Heartbeat: next wake ${found[1]}`))
      }
    } catch {
      // Never break the cron call.
    }
    return result
  })

  on('tool.call', { tool: 'CronDelete' }, async ($, e, next) => {
    const result = await next(e)
    try {
      cronActive = false
      $.ui.status('Heartbeat: a scheduled wake was cancelled')
    } catch {
      // Never break the cron call.
    }
    return result
  })

  // Every other tool: note real work, and background tasks that will report back.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    try {
      const call = e as unknown as { tool?: unknown; agentId?: unknown; run_in_background?: unknown }
      const tool = typeof call.tool === 'string' ? call.tool : ''
      if (call.agentId !== undefined || !turn) return result
      if (WORK_TOOLS.has(tool)) turn.worked = true
      if (BACKGROUND_TOOLS.has(tool) && (call.run_in_background === true || tool === 'Monitor' || tool === 'Agent' || tool === 'Task')) {
        const text = JSON.stringify(result)
        const id = text.match(/\bID: ([A-Za-z0-9_-]+)/)?.[1] ?? text.match(/"(?:task_?id|agentId)"\s*:\s*"([A-Za-z0-9_-]+)"/)?.[1]
        if (id && /background|run_in_background|task/i.test(text)) running.add(id)
      }
    } catch {
      // Never break a tool call.
    }
    return result
  })

  // ---- Turns: who started them, and what they did --------------------------------------------------

  on('prompt.submit', async ($, e, next) => {
    try {
      const input = e as unknown as { text?: unknown; origin?: { kind?: unknown }; command?: unknown }
      const text = typeof input.text === 'string' ? input.text.trim() : ''
      const kind = input.origin?.kind
      const isWake = kind === 'scheduled-trigger' || (text !== '' && [...wakePrompts].some((p) => text === p || text.startsWith(p)))
      if (kind === 'task-notification') {
        // A background task finished or failed: something happened, so the idle count starts over.
        for (const match of text.matchAll(/<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g)) {
          if (match[1] && match[2] && !/running|started/i.test(match[2])) running.delete(match[1].trim())
        }
        idleCount = 0
        turn = { wake: false, worked: true }
      } else if (isWake) {
        nextWakeAt = null
        turn = { wake: true, worked: false }
        if (heartbeatOn) {
          const k = idleCount + 1
          const note = running.size > 0
            ? `session-pulse: ${running.size} background task(s) you started are still running, so this wake is waiting, not idle.`
            : k >= idleLimit
              ? `session-pulse: this is idle timer ${k} of ${idleLimit} if there is nothing to do. If so: write your handoff notes, call ${TOOL}, set no more wake-ups, and end the turn.`
              : `session-pulse: if there is nothing to do this wake, it counts as idle timer ${k} of ${idleLimit}.`
          return next({ ...e, context: [...((e as unknown as { context?: string[] }).context ?? []), note] } as typeof e)
        }
      } else if (input.command === undefined) {
        // The person (or another session) wrote: back to work, the count starts over.
        idleCount = 0
        turn = { wake: false, worked: true }
      }
    } catch {
      // Never block the prompt.
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    try {
      if ((e as unknown as { agentId?: unknown }).agentId === undefined && turn?.wake) {
        const idle = !turn.worked && running.size === 0
        idleCount = idle ? idleCount + 1 : 0
        if (idle && idleCount >= idleLimit) {
          heartbeatOn = false
          $.ui.status(`Heartbeat: stopped after ${idleLimit} idle wake-ups`)
        } else if (idle) {
          $.ui.status(`Heartbeat: idle ${idleCount} of ${idleLimit}`)
        }
      }
      turn = null
    } catch {
      // Never break the turn.
    }
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

  // A turn ends while the heartbeat is running but no wake-up is set: remind Claude once.
  on('classic.Stop', async ($, e, next) => {
    try {
      const input = e as unknown as { stop_hook_active?: unknown }
      const due = nextWakeAt === null || nextWakeAt <= Date.now()
      if (remindOnStop && heartbeatOn && !cronActive && due && input.stop_hook_active !== true && pending === null) {
        return {
          block:
            `session-pulse: the heartbeat is on but no wake-up is set. If work is still pending, set one of at most ${maxMinutes} minutes (ScheduleWakeup). ` +
            'If nothing is left, stop the heartbeat (ScheduleWakeup with stop: true). Then end the turn.',
        }
      }
    } catch {
      // Never hold a turn open by mistake.
    }
    return next(e)
  })

  // ---- Self-compaction -----------------------------------------------------------------------------

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

  on('tool.call', { tool: `mcp__${PLUGIN}__${TOOL}` }, async ($, e) => {
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
}
