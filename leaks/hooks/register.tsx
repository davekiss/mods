import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Leak, Live, Report } from '../types'

const PANE = 'leaks'
const RED = '#E4312B'
const CACHE_TTL_MS = 60 * 60_000 // Claude Code writes the 1-hour cache
const CACHE_WARN_MS = 50 * 60_000
const MIN_REWRITE = 100_000 // a smaller context is cheap to re-write

const report = atom({ plugin: 'leaks', key: 'report' } as const, null as Report | null)
const isLoading = atom({ plugin: 'leaks', key: 'isLoading' } as const, false)
const error = atom({ plugin: 'leaks', key: 'error' } as const, null as string | null)
const applied = atom({ plugin: 'leaks', key: 'applied' } as const, [] as string[])
const live = atom({ plugin: 'leaks', key: 'live' } as const, { tokens: 0, window: 0, week: null, lastTurnAt: null } as Live)
const hidden = atom({ plugin: 'leaks', key: 'hidden' } as const, null as string | null)
const selected = atom({ plugin: 'leaks', key: 'selected' } as const, 0)

// $ per million tokens written to the 1-hour cache, by model.
const CACHE_WRITE: [RegExp, number][] = [[/fable|mythos/, 20], [/opus/, 8], [/sonnet/, 4], [/haiku/, 2]]
export const rewriteCost = (model: string, tokens: number) =>
  ((CACHE_WRITE.find(([re]) => re.test(model))?.[1] ?? 8) * tokens) / 1e6

export const k = (n: number) => `${Math.round(n / 1000)}k`
export const usd = (n: number) => (n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`)

export type Warning = { key: string; text: string; action: 'compact' }

// The one leak happening right now, if any. The cache one wins: it is about to
// cost a whole re-write, where a big context costs a little on every turn.
export function warning(l: Live, now: number, warnAt: number, model = ''): Warning | null {
  const idle = l.lastTurnAt === null ? 0 : now - l.lastTurnAt
  if (l.tokens >= MIN_REWRITE && idle >= CACHE_WARN_MS) {
    const cost = usd(rewriteCost(model, l.tokens))
    return idle >= CACHE_TTL_MS
      ? { key: `expired:${l.lastTurnAt}`, text: `cache expired ${Math.round((idle - CACHE_TTL_MS) / 60_000)}m ago · your next message re-writes ${k(l.tokens)} tokens (~${cost})`, action: 'compact' }
      : { key: `expiring:${l.lastTurnAt}`, text: `cache expires in ${Math.ceil((CACHE_TTL_MS - idle) / 60_000)}m · then the next message re-writes ${k(l.tokens)} tokens (~${cost})`, action: 'compact' }
  }
  if (l.tokens >= warnAt) return { key: `context:${Math.floor(l.tokens / 100_000)}`, text: `context ${k(l.tokens)} · every turn re-reads all of it`, action: 'compact' }
  return null
}

// An "apply:" line from the report, as a change to a file.
export type Fix = { kind: 'setting'; key: string; value: number | string } | { kind: 'claude-md'; line: string } | { kind: 'manual' }
export function parseApply(apply: string | undefined): Fix {
  const setting = apply?.match(/^setting (\w+)=(\S+)$/)
  if (setting) return { kind: 'setting', key: setting[1] as string, value: /^\d+$/.test(setting[2] as string) ? Number(setting[2]) : (setting[2] as string) }
  const md = apply?.match(/^CLAUDE\.md "(.+)"$/)
  if (md) return { kind: 'claude-md', line: md[1] as string }
  return { kind: 'manual' }
}

// settings.json with one key set and every other key kept.
export const withSetting = (text: string, key: string, value: unknown) =>
  `${JSON.stringify({ ...(text.trim() ? JSON.parse(text) : {}), [key]: value }, null, 2)}\n`

export const withLine = (text: string, line: string) =>
  text.includes(line) ? text : `${text.replace(/\n*$/, '')}${text.trim() ? '\n\n' : ''}${line}\n`

async function claudeDir($: EngineInterface) {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
}

async function readOr($: EngineInterface, path: string) {
  return (await $.fs.exists(path)) ? $.fs.read(path) : ''
}

async function apply($: EngineInterface, leak: Leak) {
  const fix = parseApply(leak.apply)
  const dir = await claudeDir($)
  if (fix.kind === 'setting') {
    const path = `${dir}/settings.json`
    await $.fs.write(path, withSetting(await readOr($, path), fix.key, fix.value))
    $.ui.toast(`leaks: ${fix.key} is ${fix.value} in ~/.claude/settings.json, for new sessions`)
  } else if (fix.kind === 'claude-md') {
    const path = `${dir}/CLAUDE.md`
    await $.fs.write(path, withLine(await readOr($, path), fix.line))
    $.ui.toast('leaks: added the line to ~/.claude/CLAUDE.md')
  } else return
  await update($, applied, prev => [...prev, leak.apply as string])
}

async function scan($: EngineInterface, args: string) {
  await update($, isLoading, () => true)
  await update($, error, () => null)
  const days = Number(args.match(/--days\s+(\d+)/)?.[1] ?? 7)
  const ran = await $.process.run(['node', `${$.plugin.root}/leaks.mjs`, '--json', '--days', String(days)], { timeoutMs: 120_000 })
  try {
    if (ran.exitCode !== 0) throw new Error((ran.stderr || ran.stdout).trim().slice(0, 300))
    const r = JSON.parse(ran.stdout) as Omit<Report, 'days' | 'at'>
    await update($, report, () => ({ ...r, days, at: Date.now() }))
    await update($, selected, () => 0)
  } catch (err) {
    await update($, error, () => `leaks couldn't read your transcripts: ${String((err as Error).message ?? err)}`)
  }
  await update($, isLoading, () => false)
}

async function measure($: EngineInterface, lastTurnAt?: number) {
  const u = await $.session.usage()
  const week = u.rateLimits.find(r => r.kind === 'seven_day')?.percentUsed ?? null
  await update($, live, prev => {
    const next = { tokens: u.context.tokens ?? 0, window: u.context.window, week, lastTurnAt: lastTurnAt ?? prev.lastTurnAt }
    return next.tokens === prev.tokens && next.week === prev.week && next.lastTurnAt === prev.lastTurnAt ? prev : next
  })
}

async function compact($: EngineInterface) {
  try {
    await $.session.compact()
    await measure($)
  } catch {
    $.ui.toast('leaks: can\'t compact while a turn runs; try again when it finishes')
  }
}

export const register: Register = (on, options) => {
  const warnAt = Number(options.warn_at) > 0 ? Number(options.warn_at) : 400_000

  on('session.start', async ($, e, next) => {
    // A user's own /leaks (the old command file) refuses the name; the strip still runs. A session
    // that started with that file keeps it until restarted, so only a file still on disk is worth a toast.
    await $.command
      .register({ name: 'leaks', description: 'Where your Claude Code week went, and one-press fixes (/leaks --days 30)' })
      .catch(async () => {
        const old = `${await claudeDir($)}/commands/leaks.md`
        if (await $.fs.exists(old)) $.ui.toast(`leaks: /leaks is taken by ${old}; remove it to use the pane`)
      })
    await measure($)
    // A minute's tick moves the cache countdown; nothing else changes while idle.
    $.clock.every(60_000, () => measure($))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    await measure($, await $.clock.now())
    return out
  })

  on('command.run', { command: 'leaks' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Leaks', focus: true })
    await scan($, e.args)
    const r = await read($, report)
    return { text: r ? `${usd(r.leaks.reduce((s, l) => s + l.save, 0))} of ${usd(r.total)} avoidable in the last ${r.days} days` : ((await read($, error)) ?? 'leaks: no report') }
  })

  // The leak happening now, one row above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking) return next(e)
    const w = warning(await read($, live), await $.clock.now(), warnAt, await $.session.model())
    if (w === null || (await read($, hidden)) === w.key) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const week = (await read($, live)).week
    return (
      <Box gap={2}>
        <Text color={RED}>◆ leaks</Text>
        <Text>{w.text}</Text>
        {week !== null && <Text dimColor>week {Math.round(week)}% used</Text>}
        <Button key="leaks-compact" plain label="compact now" onPress={() => compact($)} />
        <Button key="leaks-hide" plain dimColor label="hide" onPress={() => update($, hidden, () => w.key)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = await read($, report)
    const done = await read($, applied)
    const width = Math.max(30, e.props.bodyColumns)
    const rule = <Text dimColor>{'─'.repeat(Math.max(1, width - 1))}</Text>
    const header = (
      <Box>
        <Text bold>LEAKS  </Text>
        {r && <Text dimColor>last {r.days} days · {r.calls.toLocaleString()} API calls</Text>}
      </Box>
    )
    if (await read($, isLoading)) return <Box flexDirection="column">{header}{rule}<Text dimColor>Reading your transcripts…</Text></Box>
    const err = await read($, error)
    if (err || !r) return <Box flexDirection="column">{header}{rule}<Text>{err ?? 'Run /leaks to scan your transcripts.'}</Text></Box>

    const avoidable = r.leaks.reduce((s, l) => s + l.save, 0)
    const pct = (n: number) => (r.total ? Math.round((n / r.total) * 100) : 0)
    const index = Math.min(await read($, selected), Math.max(0, r.leaks.length - 1))
    const leak = r.leaks[index]
    const top = r.leaks[0]?.save || 1
    const pick = (i: number) => update($, selected, () => Math.max(0, Math.min(r.leaks.length - 1, i)))
    const fix = parseApply(leak?.apply)
    const isDone = leak?.apply !== undefined && done.includes(leak.apply)

    return (
      <Box flexDirection="column">
        {header}
        {rule}
        <Box marginTop={1} gap={2}>
          <Text bold>{usd(r.total)}</Text>
          <Text dimColor>API-equivalent spent</Text>
          <Text color={RED} bold>{usd(avoidable)} avoidable ({pct(avoidable)}%)</Text>
        </Box>
        <Text dimColor>
          {pct(r.pastCompact)}% went to turns past {k(r.compactAt)} context
          {r.autoCompactWindow ? ` · autoCompactWindow is ${k(r.autoCompactWindow)}` : ''}
        </Text>
        <Box flexDirection="column" marginY={1}>
          {r.leaks.length === 0 && <Text>No leaks found.</Text>}
          {r.leaks.slice(0, 8).map((l, i) => (
            <Box key={`leak:${i}`}>
              <Text color={RED}>{i === index ? '▌ ' : '  '}</Text>
              <Text color={RED} bold={i === index}>{usd(l.save).padStart(6)} </Text>
              <Text color={RED}>{'█'.repeat(Math.max(1, Math.round((l.save / top) * 12))).padEnd(13)}</Text>
              <Button key={`row:${i}`} plain dimColor={i !== index} label={l.title} {...(i === index ? { autoFocus: true as const } : {})} onPress={() => pick(i)} />
            </Box>
          ))}
        </Box>
        {leak && (
          <Box flexDirection="column">
            {rule}
            <Box marginTop={1}><Text wrap="wrap">{leak.detail}</Text></Box>
            <Box marginTop={1}><Text color="green" wrap="wrap">→ {leak.fix}</Text></Box>
            <Box marginTop={1} gap={3}>
              {fix.kind !== 'manual' && (isDone
                ? <Text key="applied" color="green">✓ applied</Text>
                : <Button key="apply" hotkey="a" label={fix.kind === 'setting' ? `apply: ${fix.key} ${typeof fix.value === 'number' ? k(fix.value) : fix.value}` : 'apply: add to CLAUDE.md'} onPress={() => apply($, leak)} />)}
              <Button key="prev" hotkey="k" plain label="up" onPress={() => pick(index - 1)} />
              <Button key="next" hotkey="j" plain label="down" onPress={() => pick(index + 1)} />
              <Button key="rescan" hotkey="r" plain dimColor label="rescan" onPress={() => scan($, `--days ${r.days}`)} />
            </Box>
          </Box>
        )}
        <Box marginTop={1}><Text dimColor wrap="wrap">Estimates at API prices; on a plan they're your share of the limit. Nothing leaves your machine.</Text></Box>
      </Box>
    )
  })
}
