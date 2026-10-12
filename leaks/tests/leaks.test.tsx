import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { warning, withLine, withSetting } from '../hooks/register'

const HOME = '/Users/me'
const MIN = 60_000
const T0 = 1_000 * MIN

const REPORT = {
  total: 2036, pastCompact: 1018, compactAt: 400_000, autoCompactWindow: null, calls: 19_768,
  leaks: [
    { kind: 'context', save: 492, title: '8 sessions ran past 400k context (up to 969k)', detail: '4,881 turns each re-read the whole conversation.', fix: 'compact at 400k', apply: 'setting autoCompactWindow=400000' },
    { kind: 'cache', save: 273, title: 'Cache rebuilt 119 times after a break', detail: 'Coming back after the cache expired.', fix: 'back from a break, /clear' },
    { kind: 'output', save: 7.69, title: '12 huge tool outputs carried in context', detail: 'Each later turn paid to re-read them.', fix: 'grep instead', apply: 'CLAUDE.md "Read logs with grep."' },
  ],
}

// The engine beneath the plugin: a session at `tokens` of context, a settings
// file and CLAUDE.md on disk, and leaks.mjs answering with REPORT.
function world(on: On, { tokens = 120_000 } = {}) {
  const files: Record<string, string> = {
    [`${HOME}/.claude/settings.json`]: JSON.stringify({ model: 'opus', env: { A: '1' } }),
    [`${HOME}/.claude/CLAUDE.md`]: '# Me\n',
  }
  const compacts: unknown[] = []
  const ran: string[][] = []
  mock.env(on, { HOME })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 1_000_000, percent: tokens / 10_000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 64 }] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.compact', (_$, e) => {
    compacts.push(e)
    return { skip: 'the test records the call' }
  })
  on('fs.exists', (_$, e) => ({ value: e.path in files }))
  on('fs.read', (_$, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_$, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: JSON.stringify(REPORT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_$, e) => e as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('command.register', () => ({ value: undefined as never }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  return { files, compacts, ran }
}

const strip = ($: Engine) =>
  $.ui.mount({
    plugin: 'leaks',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 10 }, view: {} } as never,
  })

const pane = ($: Engine) =>
  $.ui.mount({
    plugin: 'leaks',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'leaks',
    props: { title: 'Leaks', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
  })

test('the strip warns before the cache expires, then says what the next message will re-write', () => {
  const live = { tokens: 520_000, window: 1_000_000, week: 64, lastTurnAt: T0 }
  expect(warning(live, T0 + 30 * MIN, 400_000, 'claude-opus-5-5')?.text).toBe('context 520k · every turn re-reads all of it')
  expect(warning(live, T0 + 53 * MIN, 400_000, 'claude-opus-5-5')?.text).toBe('cache expires in 7m · then the next message re-writes 520k tokens (~$4.16)')
  expect(warning(live, T0 + 75 * MIN, 400_000, 'claude-opus-5-5')?.text).toBe('cache expired 15m ago · your next message re-writes 520k tokens (~$4.16)')
  // A small context is cheap to re-write, and one under the threshold is fine.
  expect(warning({ ...live, tokens: 60_000 }, T0 + 75 * MIN, 400_000)).toBeNull()
  expect(warning({ ...live, tokens: 300_000 }, T0 + 10 * MIN, 400_000)).toBeNull()
})

test('a setting fix keeps every other key, and a CLAUDE.md line is added once', () => {
  expect(JSON.parse(withSetting('{"model":"opus","env":{"A":"1"}}', 'autoCompactWindow', 400000))).toEqual({ model: 'opus', env: { A: '1' }, autoCompactWindow: 400000 })
  expect(JSON.parse(withSetting('', 'autoCompactWindow', 400000))).toEqual({ autoCompactWindow: 400000 })
  const once = withLine('# Me\n', 'Read logs with grep.')
  expect(once).toBe('# Me\n\nRead logs with grep.\n')
  expect(withLine(once, 'Read logs with grep.')).toBe(once)
})

test('back after an hour away, the strip offers to compact before the re-write', async ($, on) => {
  const { compacts } = world(on, { tokens: 520_000 })
  const clock = mock.clock(on, { now: T0 })
  await $.session.start({ cwd: '/work' } as never)
  await $.turn.complete({ answer: 'done' } as never)
  await clock.set(T0 + 75 * MIN)

  const ui = await strip($)
  expect((await ui.find({ text: /cache expired 15m ago/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: 'week 64% used' })) !== undefined).toBe(true)
  await ui.press({ key: 'leaks-compact' })
  expect(compacts.length).toBe(1)
  await ui.press({ key: 'leaks-hide' })
  await ui.unmount()

  const hidden = await strip($)
  expect(await hidden.find({ key: 'leaks-compact' })).toBeUndefined()
  await hidden.unmount()
})

test('/leaks ranks the report, and apply writes the fix into the user\'s own files', async ($, on) => {
  const { files, ran } = world(on)
  await $.command.run({ command: 'leaks', args: '--days 30' } as never)
  expect(ran[0]?.slice(-3)).toEqual(['--json', '--days', '30'])

  const ui = await pane($)
  expect((await ui.find({ text: /\$773 avoidable \(38%\)/ })) !== undefined).toBe(true)
  await ui.press({ key: 'apply' })
  expect(JSON.parse(files[`${HOME}/.claude/settings.json`] ?? '')).toEqual({ model: 'opus', env: { A: '1' }, autoCompactWindow: 400000 })
  expect((await ui.find({ text: '✓ applied' })) !== undefined).toBe(true)
  expect(await ui.find({ key: 'apply' })).toBeUndefined()

  await ui.press({ key: 'next' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'apply' })
  expect(files[`${HOME}/.claude/CLAUDE.md`]).toBe('# Me\n\nRead logs with grep.\n')
  await ui.unmount()
})
