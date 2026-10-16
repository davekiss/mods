import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Audit } from '../types'

const PANE = 'skill-audit'
const RED = '#E4312B'

const report = atom({ plugin: 'skill-audit', key: 'report' } as const, null as Audit | null)
const isLoading = atom({ plugin: 'skill-audit', key: 'isLoading' } as const, false)
const error = atom({ plugin: 'skill-audit', key: 'error' } as const, null as string | null)
const done = atom({ plugin: 'skill-audit', key: 'done' } as const, null as string | null)

export const ago = (t: number | null, now: number) => {
  if (!t) return 'never'
  const d = Math.floor((now - t) / 86_400_000)
  return d === 0 ? 'today' : `${d}d ago`
}

async function engine($: EngineInterface, args: string[]) {
  const ran = await $.process.run(['node', `${$.plugin.root}/skill-audit.mjs`, ...args], { timeoutMs: 120_000 })
  if (ran.exitCode !== 0) throw new Error((ran.stderr || ran.stdout).trim().slice(0, 300))
  return JSON.parse(ran.stdout)
}

async function scan($: EngineInterface, days: number, keep: string) {
  await update($, isLoading, () => true)
  await update($, error, () => null)
  try {
    const r = (await engine($, ['--json', '--days', String(days), ...(keep ? ['--keep', keep] : [])])) as Audit
    await update($, report, () => r)
  } catch (err) {
    await update($, error, () => `skill-audit couldn't read your transcripts: ${String((err as Error).message ?? err)}`)
  }
  await update($, isLoading, () => false)
}

async function off($: EngineInterface, days: number, keep: string) {
  const r = (await engine($, ['off', '--days', String(days), ...(keep ? ['--keep', keep] : [])])) as { off: string[]; savedTokens: number }
  await update($, done, () => `turned off ${r.off.length} · ~${r.savedTokens} tokens a session back from your next session`)
  $.ui.toast(`skill-audit: ${r.off.length} off, for new sessions. Undo with u.`)
  await scan($, days, keep)
}

async function undo($: EngineInterface, days: number, keep: string) {
  const r = (await engine($, ['undo'])) as { restored: string[] }
  await update($, done, () => `restored ${r.restored.length}`)
  await scan($, days, keep)
}

export const register: Register = (on, options) => {
  const keep = String(options.keep ?? '').trim()

  on('session.start', async ($, e, next) => {
    await $.command
      .register({ name: 'skill-audit', description: 'Which skills and plugins your agent used in the last 30 days; turn the rest off (/skill-audit --days 60)' })
      .catch(() => $.ui.toast('skill-audit: /skill-audit is taken by another command'))
    return next(e)
  })

  on('command.run', { command: 'skill-audit' }, async ($, e) => {
    const days = Number(e.args.match(/--days\s+(\d+)/)?.[1] ?? 30)
    await update($, done, () => null)
    await $.ui.open({ id: PANE, title: 'Skill audit', focus: true })
    await scan($, days, keep)
    const r = await read($, report)
    return { text: r ? `${r.unused.length} of ${r.items.length} unused in ${r.days} days, ~${r.unusedTokens} tokens a session (est.)` : ((await read($, error)) ?? 'skill-audit: no report') }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = await read($, report)
    const width = Math.max(30, e.props.bodyColumns)
    const rule = <Text dimColor>{'─'.repeat(Math.max(1, width - 1))}</Text>
    const header = (
      <Box>
        <Text bold>SKILL AUDIT  </Text>
        {r && <Text dimColor>last {r.days} days · {r.sessions} sessions</Text>}
      </Box>
    )
    if (await read($, isLoading)) return <Box flexDirection="column">{header}{rule}<Text dimColor>Reading your transcripts…</Text></Box>
    const err = await read($, error)
    if (err || !r) return <Box flexDirection="column">{header}{rule}<Text>{err ?? 'Run /skill-audit to scan your transcripts.'}</Text></Box>
    const now = await $.clock.now()
    const note = await read($, done)
    const used = r.items.filter(i => i.on && i.uses > 0)
    const idle = r.items.filter(i => r.unused.includes(i.id))
    const disabled = r.items.filter(i => !i.on)

    return (
      <Box flexDirection="column">
        {header}
        {rule}
        <Box marginTop={1} gap={2}>
          <Text color={RED} bold>{r.unused.length} of {r.items.length} unused</Text>
          <Text>~{r.unusedTokens.toLocaleString()} of ~{r.totalTokens.toLocaleString()} tokens every session (est.)</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {used.map((i, n) => (
            <Box key={`used:${n}`}>
              <Text color="green">● </Text>
              <Text bold>{i.name.slice(0, 18).padEnd(19)}</Text>
              <Text>{`${i.uses} use${i.uses === 1 ? '' : 's'}`.padEnd(8)}</Text>
              <Text dimColor>{ago(i.lastUsed, now)}</Text>
            </Box>
          ))}
        </Box>
        {idle.length > 0 && <Box marginTop={1}><Text color={RED} wrap="wrap">✕ never used: {idle.map(i => i.name).join(', ')}</Text></Box>}
        {disabled.length > 0 && <Box marginTop={1}><Text dimColor wrap="wrap">○ off: {disabled.map(i => i.name).join(', ')}</Text></Box>}
        <Box marginBottom={1} />
        {rule}
        <Box marginTop={1} gap={3}>
          {r.unused.length > 0 && <Button key="off" hotkey="o" autoFocus label={`turn off ${r.unused.length} unused`} onPress={() => off($, r.days, keep)} />}
          <Button key="undo" hotkey="u" plain label="undo" onPress={() => undo($, r.days, keep)} />
          <Button key="rescan" hotkey="r" plain dimColor label="rescan" onPress={() => scan($, r.days, keep)} />
        </Box>
        {note && <Box marginTop={1}><Text color="green">✓ {note}</Text></Box>}
        <Box marginTop={1}><Text dimColor wrap="wrap">Counted from your own transcripts. Plugins go off in settings.json, skills move to ~/.claude/skills-disabled; both take effect next session.</Text></Box>
      </Box>
    )
  })
}
