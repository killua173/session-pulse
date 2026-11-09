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
// 5. Automatic wake-up (`autoWake`): when a turn ends with the heartbeat on and no wake-up set, the plugin
//    sets one itself (`heartbeatMinutes`), so a session with work never falls asleep and never sits idle
//    long enough for its prompt cache to expire. Idle counting still stops it.
// 6. Usage limits: the status line shows the 5-hour and weekly windows. When a window reaches
//    `usageLimitPercent`, Claude is told once to save its notes and stop: with the reset far away it also
//    compacts; either way the plugin wakes the session `resumeMinutes` after the reset.

const TOOL = 'compact_after_turn'
const PLUGIN = 'session-pulse'
const AUTO_PROMPT = 'Heartbeat (session-pulse): automatic wake-up. Carry on with any pending work; if nothing is left, say so briefly and end the turn.'
const RESUME_PROMPT = 'Heartbeat (session-pulse): the usage window has reset. Read your handoff notes and carry on with the pending work.'
const WINDOWS: Record<string, string> = { five_hour: '5h', seven_day: 'week' }

type Limit = { kind: string; percentUsed: number; resetsAt?: string }

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
const wakePrompts = new Set<string>([AUTO_PROMPT, RESUME_PROMPT])
const running = new Set<string>() // background task ids still running
let turn: { wake: boolean; worked: boolean } | null = null
let ownTimer: { cancel: () => void } | null = null // the plugin's own wake-up (automatic or after a reset)
let pausedUntil = 0 // a usage window is spent: no automatic wake-ups before this time
let limits: Limit[] = [] // the last usage reading
const handledResets = new Set<string>() // usage windows already acted on (kind + reset time)
let lastStatus: string | undefined
let idleLimit = 2

function withIdle(prefix: string): string {
  return idleCount > 0 ? `${prefix} (idle ${idleCount} of ${idleLimit})` : prefix
}

function usageText(): string {
  return limits
    .filter((w) => WINDOWS[w.kind])
    .map((w) => `${WINDOWS[w.kind]} ${Math.round(w.percentUsed)}%`)
    .join(' · ')
}

// Every status goes through here so the usage figures ride along; `undefined` clears the line.
function show($: { ui: { status: (text: string | undefined) => unknown } }, text: string | undefined): void {
  lastStatus = text
  const usage = usageText()
  $.ui.status(text === undefined ? undefined : usage ? `${text} · ${usage}` : text)
}

function cancelOwn(): void {
  ownTimer?.cancel()
  ownTimer = null
}

// The plugin's own wake-up: a timer that submits a heartbeat prompt (it lives while the app is open).
function armOwn(
  $: {
    ui: { status: (text: string | undefined) => unknown }
    clock: { after: (ms: number, fn: () => void) => { cancel: () => void } }
    prompt: { submit: (input: { text: string }) => Promise<unknown> }
  },
  at: number,
  text: string,
  label: string,
): void {
  cancelOwn()
  nextWakeAt = at
  const timer = $.clock.after(Math.max(0, at - Date.now()), () => {
    if (ownTimer !== timer) return
    ownTimer = null
    nextWakeAt = null
    void $.prompt.submit({ text }).catch(() => undefined)
  })
  ownTimer = timer
  show($, withIdle(`Heartbeat: next wake ${hhmm(new Date(at))} (${label})`))
}

async function readLimits($: { session: { usage: () => Promise<{ rateLimits?: Limit[] }> } }): Promise<Limit[]> {
  try {
    const usage = await $.session.usage()
    if (Array.isArray(usage?.rateLimits)) limits = usage.rateLimits
  } catch {
    // No reading (off a subscription, or the host keeps none): the usage rule stays quiet.
  }
  return limits
}

export const register: Register = (on, options) => {
  const maxMinutes = num(options.heartbeatMinutes, 30, 1, 60)
  const capWakeups = options.capWakeups !== false
  const autoWake = options.autoWake !== false
  const autoStart = options.autoStart === true
  // With automatic wake-ups on, the plugin sets the wake-up itself, so there is nothing to remind.
  const remindOnStop = options.remindOnStop !== false && !autoWake
  const addRules = options.rules !== false
  const usageLimit = num(options.usageLimitPercent, 95, 50, 100)
  const nearMinutes = num(options.resetNearMinutes, 60, 0, 600)
  const resumeMinutes = num(options.resumeMinutes, 2, 0, 60)

  idleLimit = num(options.idleLimit, 2, 1, 10)

  // ---- Instructions --------------------------------------------------------------------------------

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!addRules) return result
    const text = [
      'Heartbeat rules (session-pulse):',
      autoWake
        ? `- While work is pending, a wake-up stays set: set your own (ScheduleWakeup, at most ${maxMinutes} minutes) when you want a different time; otherwise session-pulse sets one of ${maxMinutes} minutes when your turn ends.`
        : `- While work is pending and nobody is waiting on you, keep a wake-up set (ScheduleWakeup) of at most ${maxMinutes} minutes.`,
      `- Usage: when a usage window reaches ${usageLimit}%, session-pulse tells you once to save your notes and stop; it wakes the session again after the reset.`,
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
        cancelOwn()
        heartbeatOn = false
        nextWakeAt = null
        show($, 'Heartbeat: off')
      } else if (typeof delay === 'number') {
        // Claude's own wake-up replaces the plugin's.
        cancelOwn()
        // The runtime clamps wake-ups to 1 minute .. 1 hour.
        const seconds = Math.min(3600, Math.max(60, delay))
        heartbeatOn = true
        nextWakeAt = Date.now() + seconds * 1000
        if (typeof input.prompt === 'string' && input.prompt.trim()) wakePrompts.add(input.prompt.trim())
        if (input.noop === false && turn) turn.worked = true
        const capped = delay !== input.delaySeconds ? ` (capped to ${maxMinutes} min)` : ''
        show($, withIdle(`Heartbeat: next wake ${hhmm(new Date(nextWakeAt))}${capped}`))
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
        cancelOwn()
        heartbeatOn = true
        cronActive = true
        show($, withIdle(`Heartbeat: next wake ${found[1]}`))
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
      show($, 'Heartbeat: a scheduled wake was cancelled')
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
        // The person (or another session) wrote: back to work, the count starts over. The plugin's own
        // wake-up is set again when this turn ends.
        idleCount = 0
        turn = { wake: false, worked: true }
        if (ownTimer && Date.now() >= pausedUntil) {
          cancelOwn()
          nextWakeAt = null
        }
        if (autoStart) heartbeatOn = true
      }
    } catch {
      // Never block the prompt.
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    try {
      const main = (e as unknown as { agentId?: unknown }).agentId === undefined
      if (main && turn?.wake) {
        const idle = !turn.worked && running.size === 0
        idleCount = idle ? idleCount + 1 : 0
        if (idle && idleCount >= idleLimit) {
          heartbeatOn = false
          cancelOwn()
          show($, `Heartbeat: stopped after ${idleLimit} idle wake-ups`)
        } else if (idle) {
          show($, `Heartbeat: idle ${idleCount} of ${idleLimit}`)
        }
      }
      if (main) turn = null
      // Automatic wake-up: the heartbeat is on and nothing will wake the session.
      const now = Date.now()
      const unset = !cronActive && !ownTimer && (nextWakeAt === null || nextWakeAt <= now)
      if (main && autoWake && heartbeatOn && unset && pending === null && now >= pausedUntil) {
        armOwn($, now + maxMinutes * 60_000, AUTO_PROMPT, 'auto')
      }
    } catch {
      // Never break the turn.
    }
    if (pending) {
      const request = pending
      pending = null
      // Wait for the turn to settle: compaction is refused while a turn runs.
      $.clock.after(1500, async () => {
        const args = request.instructions ?? ''
        // After compacting, the line shows the wake-up still set (the plugin's own survives compaction).
        const restore = () => show($, ownTimer && nextWakeAt ? `Heartbeat: next wake ${hhmm(new Date(nextWakeAt))}` : undefined)
        const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
        try {
          const outcome = await $.session.compact(request.instructions ? { instructions: request.instructions } : {})
          restore()
          if (outcome && 'skip' in outcome && outcome.skip) $.ui.toast(`Compaction skipped: ${String(outcome.skip)}`)
        } catch (direct) {
          // Some hosts (the desktop app) run the engine headless, where compaction only runs as /compact.
          try {
            await $.command.run({ command: 'compact', args })
            restore()
          } catch (command) {
            try {
              await $.prompt.submit({ text: args ? `/compact ${args}` : '/compact' })
              restore()
            } catch (prompt) {
              restore()
              $.ui.toast(`Could not compact: ${message(direct)} / ${message(command)} / ${message(prompt)}`)
            }
          }
        }
      })
    }
    return done
  })

  // A turn ends: first the usage windows, then (with automatic wake-ups off) a missing wake-up.
  on('classic.Stop', async ($, e, next) => {
    try {
      const input = e as unknown as { stop_hook_active?: unknown }
      if (input.stop_hook_active !== true) {
        const now = Date.now()
        // The spent window that resets last decides (a spent week outlasts a spent 5 hours).
        const spent = (await readLimits($))
          .filter((w) => WINDOWS[w.kind] && w.percentUsed >= usageLimit && w.resetsAt && Date.parse(w.resetsAt) > now)
          .sort((a, b) => Date.parse(b.resetsAt ?? '') - Date.parse(a.resetsAt ?? ''))[0]
        const key = spent ? `${spent.kind}@${spent.resetsAt}` : ''
        if (spent && !handledResets.has(key)) {
          handledResets.add(key)
          const reset = Date.parse(spent.resetsAt ?? '')
          const resume = reset + resumeMinutes * 60_000
          const left = reset - now
          const inText = left >= 3_600_000 ? `${Math.floor(left / 3_600_000)} h ${Math.round((left % 3_600_000) / 60_000)} min` : `${Math.max(1, Math.round(left / 60_000))} min`
          const name = WINDOWS[spent.kind] === '5h' ? '5-hour' : 'weekly'
          pausedUntil = resume
          heartbeatOn = true
          armOwn($, resume, RESUME_PROMPT, 'after the reset')
          const far = left > nearMinutes * 60_000
          return {
            block:
              `session-pulse: the ${name} usage window is at ${Math.round(spent.percentUsed)}% and resets at ${hhmm(new Date(reset))} (in ${inText}). ` +
              (far
                ? `Make your handoff notes true, call ${TOOL}, and end the turn. `
                : 'Finish this step, save anything not yet written down, and end the turn. ') +
              `session-pulse wakes this session at ${hhmm(new Date(resume))}; set no other wake-up.`,
          }
        }
      }
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

  // Usage moved: refresh the figures on the status line.
  on('session.measure', async ($, e, next) => {
    try {
      const input = e as unknown as { rateLimits?: Limit[]; changed?: string[] }
      if (Array.isArray(input.rateLimits) && input.changed?.includes('rateLimits')) {
        limits = input.rateLimits
        if (lastStatus !== undefined || usageText()) show($, lastStatus ?? 'Heartbeat: none set')
      }
    } catch {
      // Never break a measurement.
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
