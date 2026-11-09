import { expect, test } from 'claude-code/testing'

// The test's own hooks stand for the engine beneath the plugin.
type Seen = { statuses: (string | undefined)[]; contexts: string[][]; delays: number[]; timers?: number[] }
type Limit = { kind: string; percentUsed: number; resetsAt?: string }

function engine(on: Parameters<Parameters<typeof test>[1]>[1], seen: Seen, rateLimits: Limit[] = []) {
  // The plugin's own wake-ups: record the wait and never fire, so a test sees what was set.
  on('clock.after', (_$, e) => {
    ;(seen.timers ??= []).push((e as unknown as { ms: number }).ms)
    return new Promise(() => {})
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits } }))
  on('ui.status', (_$, e) => {
    seen.statuses.push((e as unknown as { text?: string }).text)
    return { value: undefined }
  })
  on('tool.register', () => ({ value: { name: 'compact_after_turn' } }))
  on('prompt.submit', (_$, e) => {
    seen.contexts.push([...((e as unknown as { context?: string[] }).context ?? [])])
    return { text: e.text }
  })
  on('tool.call', (_$, e) => {
    const call = e as unknown as { tool: string; delaySeconds?: number; run_in_background?: boolean }
    if (call.tool === 'ScheduleWakeup' && typeof call.delaySeconds === 'number') seen.delays.push(call.delaySeconds)
    if (call.tool === 'Bash' && call.run_in_background) return { result: { text: 'Command running in background with ID: job1.' } }
    return { result: { text: 'ok' } }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
}

const PROMPT = 'Heartbeat check'
const wake = (seconds = 600) => ({ tool: 'ScheduleWakeup', delaySeconds: seconds, prompt: PROMPT, reason: 'test' })
const fire = { text: PROMPT, wait: false, origin: { kind: 'unclassified' } } as const
const typed = { text: 'hello', wait: false, origin: { kind: 'composer' } } as const
const done = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const

const lastStatus = (seen: Seen) => seen.statuses.filter((s) => s !== undefined).at(-1) ?? ''
const lastContext = (seen: Seen) => (seen.contexts.at(-1) ?? []).join('\n')

test('a wake-up longer than the limit is shortened', async ($, on) => {
  const seen: Seen = { statuses: [], contexts: [], delays: [] }
  engine(on, seen)
  await $.tool.call(wake(7200) as never)
  expect(seen.delays.at(-1)).toBe(1800)
  expect(lastStatus(seen)).toMatch(/capped to 30 min/)
})

test('two idle wake-ups back to back stop the heartbeat; the second says handoff and compact', async ($, on) => {
  const seen: Seen = { statuses: [], contexts: [], delays: [] }
  engine(on, seen)
  await $.tool.call(wake() as never)
  await $.prompt.submit(fire as never)
  expect(lastContext(seen)).toMatch(/idle timer 1 of 2/)
  await $.turn.complete(done as never)
  // Nothing was set again, so the automatic wake-up is set; the line keeps the idle count.
  expect(lastStatus(seen)).toMatch(/^Heartbeat: next wake \d\d:\d\d \(auto\) \(idle 1 of 2\)$/)

  await $.tool.call(wake() as never)
  await $.prompt.submit(fire as never)
  expect(lastContext(seen)).toMatch(/idle timer 2 of 2.*handoff.*compact_after_turn/s)
  await $.turn.complete(done as never)
  expect(lastStatus(seen)).toBe('Heartbeat: stopped after 2 idle wake-ups')
})

test('a message from the person resets the count', async ($, on) => {
  const seen: Seen = { statuses: [], contexts: [], delays: [] }
  engine(on, seen)
  await $.tool.call(wake() as never)
  await $.prompt.submit(fire as never)
  await $.turn.complete(done as never)
  await $.prompt.submit(typed as never)
  await $.turn.complete(done as never)
  await $.tool.call(wake() as never)
  await $.prompt.submit(fire as never)
  expect(lastContext(seen)).toMatch(/idle timer 1 of 2/)
})

test('a wake with real work is not idle', async ($, on) => {
  const seen: Seen = { statuses: [], contexts: [], delays: [] }
  engine(on, seen)
  await $.tool.call(wake() as never)
  await $.prompt.submit(fire as never)
  await $.tool.call({ tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' } as never)
  await $.turn.complete(done as never)
  await $.tool.call(wake() as never)
  await $.prompt.submit(fire as never)
  expect(lastContext(seen)).toMatch(/idle timer 1 of 2/)
})

test('waiting for a background task is not idle, and its finish resets the count', async ($, on) => {
  const seen: Seen = { statuses: [], contexts: [], delays: [] }
  engine(on, seen)
  await $.tool.call(wake() as never)
  await $.prompt.submit(fire as never)
  await $.tool.call({ tool: 'Bash', command: 'build', run_in_background: true } as never)
  await $.turn.complete(done as never)

  await $.tool.call(wake() as never)
  await $.prompt.submit(fire as never)
  expect(lastContext(seen)).toMatch(/still running, so this wake is waiting, not idle/)
  await $.turn.complete(done as never)

  await $.prompt.submit({ text: '<task-notification><task-id>job1</task-id><status>completed</status></task-notification>', wait: false, origin: { kind: 'task-notification' } } as never)
  await $.turn.complete(done as never)
  await $.tool.call(wake() as never)
  await $.prompt.submit(fire as never)
  expect(lastContext(seen)).toMatch(/idle timer 1 of 2/)
})

test('with automatic wake-ups off, a turn that ends with the heartbeat on and no wake-up set is reminded once', { options: { autoWake: false } }, async ($, on) => {
  const seen: Seen = { statuses: [], contexts: [], delays: [] }
  engine(on, seen)
  on('classic.Stop', () => ({}))
  // No heartbeat yet: no reminder.
  expect((await $.classic.Stop({ stop_hook_active: false } as never)).block).toBeUndefined()
  await $.tool.call(wake() as never)
  // A wake-up is set: no reminder.
  expect((await $.classic.Stop({ stop_hook_active: false } as never)).block).toBeUndefined()
  // The wake fired and none was set again: reminded, but not twice in a row.
  await $.prompt.submit(fire as never)
  expect((await $.classic.Stop({ stop_hook_active: false } as never)).block).toMatch(/no wake-up is set/)
  expect((await $.classic.Stop({ stop_hook_active: true } as never)).block).toBeUndefined()
})

test('a turn that ends with the heartbeat on and nothing set gets an automatic wake-up of the longest length', async ($, on) => {
  const seen: Seen = { statuses: [], contexts: [], delays: [] }
  engine(on, seen)
  on('classic.Stop', () => ({}))
  // No heartbeat yet: nothing is set for a plain chat turn.
  await $.prompt.submit(typed as never)
  await $.turn.complete(done as never)
  expect(seen.timers ?? []).toEqual([])
  await $.tool.call(wake() as never)
  await $.prompt.submit(fire as never)
  await $.tool.call({ tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' } as never)
  await $.turn.complete(done as never)
  expect(seen.timers?.at(-1)).toBe(30 * 60_000)
  expect(lastStatus(seen)).toMatch(/\(auto\)$/)
  // With automatic wake-ups on there is no reminder: the plugin already set one.
  expect((await $.classic.Stop({ stop_hook_active: false } as never)).block).toBeUndefined()
})

test('the heartbeat can start on the first message', { options: { autoStart: true } }, async ($, on) => {
  const seen: Seen = { statuses: [], contexts: [], delays: [] }
  engine(on, seen)
  await $.prompt.submit(typed as never)
  await $.turn.complete(done as never)
  expect(seen.timers?.at(-1)).toBe(30 * 60_000)
})

test('a spent window with the reset far away: save, compact, and the plugin wakes after the reset', async ($, on) => {
  const resetsAt = new Date(Date.now() + 3 * 3_600_000).toISOString()
  const seen: Seen = { statuses: [], contexts: [], delays: [] }
  engine(on, seen, [{ kind: 'five_hour', percentUsed: 96, resetsAt }, { kind: 'seven_day', percentUsed: 40 }])
  on('classic.Stop', () => ({}))
  const first = (await $.classic.Stop({ stop_hook_active: false } as never)).block ?? ''
  expect(first).toMatch(/5-hour usage window is at 96%/)
  expect(first).toMatch(/handoff notes true, call compact_after_turn/)
  const waited = seen.timers?.at(-1) ?? 0
  expect(Math.abs(waited - (3 * 3_600_000 + 2 * 60_000))).toBeLessThan(5_000)
  expect(lastStatus(seen)).toMatch(/\(after the reset\) · 5h 96% · week 40%$/)
  // Once per window: the next stop is not held again.
  expect((await $.classic.Stop({ stop_hook_active: false } as never)).block).toBeUndefined()
})

test('a spent window with the reset near: save and wait, no compaction', async ($, on) => {
  const resetsAt = new Date(Date.now() + 20 * 60_000).toISOString()
  const seen: Seen = { statuses: [], contexts: [], delays: [] }
  engine(on, seen, [{ kind: 'seven_day', percentUsed: 100, resetsAt }])
  on('classic.Stop', () => ({}))
  const block = (await $.classic.Stop({ stop_hook_active: false } as never)).block ?? ''
  expect(block).toMatch(/weekly usage window is at 100%/)
  expect(block).toMatch(/Finish this step/)
  expect(block).not.toMatch(/compact_after_turn/)
})

test('a window under the limit holds nothing', async ($, on) => {
  const resetsAt = new Date(Date.now() + 3 * 3_600_000).toISOString()
  const seen: Seen = { statuses: [], contexts: [], delays: [] }
  engine(on, seen, [{ kind: 'five_hour', percentUsed: 80, resetsAt }])
  on('classic.Stop', () => ({}))
  expect((await $.classic.Stop({ stop_hook_active: false } as never)).block).toBeUndefined()
})

test('the usage figures follow each measurement on the status line', async ($, on) => {
  const seen: Seen = { statuses: [], contexts: [], delays: [] }
  engine(on, seen)
  on('session.measure', () => ({ changed: ['rateLimits'] }))
  await $.tool.call(wake() as never)
  await $.session.measure({ context: {}, rateLimits: [{ kind: 'five_hour', percentUsed: 72 }], changed: ['rateLimits'] } as never)
  expect(lastStatus(seen)).toMatch(/^Heartbeat: next wake \d\d:\d\d · 5h 72%$/)
})

test('the options change the limits', { options: { heartbeatMinutes: 10, idleLimit: 3 } }, async ($, on) => {
  const seen: Seen = { statuses: [], contexts: [], delays: [] }
  engine(on, seen)
  await $.tool.call(wake(1200) as never)
  expect(seen.delays.at(-1)).toBe(600)
  await $.prompt.submit(fire as never)
  expect(lastContext(seen)).toMatch(/idle timer 1 of 3/)
})
