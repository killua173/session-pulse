import { expect, test } from 'claude-code/testing'

// The test's own hooks stand for the engine beneath the plugin.
type Seen = { statuses: (string | undefined)[]; contexts: string[][]; delays: number[] }

function engine(on: Parameters<Parameters<typeof test>[1]>[1], seen: Seen) {
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
  expect(lastStatus(seen)).toBe('Heartbeat: idle 1 of 2')

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

test('a turn that ends with the heartbeat on and no wake-up set is reminded once', async ($, on) => {
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

test('the options change the limits', { options: { heartbeatMinutes: 10, idleLimit: 3 } }, async ($, on) => {
  const seen: Seen = { statuses: [], contexts: [], delays: [] }
  engine(on, seen)
  await $.tool.call(wake(1200) as never)
  expect(seen.delays.at(-1)).toBe(600)
  await $.prompt.submit(fire as never)
  expect(lastContext(seen)).toMatch(/idle timer 1 of 3/)
})
