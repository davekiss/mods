import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Report } from '../types'

const PANE = 'contagion'
const RED = '#E4312B'

const report = atom({ plugin: 'contagion', key: 'report' } as const, null as Report | null)
const isLoading = atom({ plugin: 'contagion', key: 'isLoading' } as const, false)
const error = atom({ plugin: 'contagion', key: 'error' } as const, null as string | null)
const fixed = atom({ plugin: 'contagion', key: 'fixed' } as const, false)

async function engine($: EngineInterface, args: string[]) {
  const ran = await $.process.run(['node', `${$.plugin.root}/contagion.mjs`, ...args], { timeoutMs: 600_000 })
  if (ran.exitCode !== 0) throw new Error((ran.stderr || ran.stdout).trim().slice(0, 300))
  return JSON.parse(ran.stdout)
}

async function scan($: EngineInterface, days: number) {
  await update($, isLoading, () => true)
  await update($, error, () => null)
  try {
    await update($, report, () => null)
    const r = (await engine($, ['--json', '--days', String(days)])) as Report
    await update($, report, () => r)
  } catch (err) {
    await update($, error, () => `contagion couldn't read the git history: ${String((err as Error).message ?? err)}`)
  }
  await update($, isLoading, () => false)
}

async function addToClaudeMd($: EngineInterface, days: number) {
  const r = (await engine($, ['fix', '--days', String(days)])) as { added: boolean; zeros?: number }
  await update($, fixed, () => r.added)
  $.ui.toast(r.added ? `contagion: CLAUDE.md now warns agents off ${r.zeros} patient zeros` : 'contagion: nothing copied more than once')
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command
      .register({ name: 'contagion', description: 'Which existing line your agents copied each as any / @ts-ignore / swallowed catch from (/contagion --days 90)' })
      .catch(() => $.ui.toast('contagion: /contagion is taken by another command'))
    return next(e)
  })

  on('command.run', { command: 'contagion' }, async ($, e) => {
    const days = Number(e.args.match(/--days\s+(\d+)/)?.[1] ?? 180)
    await update($, fixed, () => false)
    await $.ui.open({ id: PANE, title: 'Contagion', focus: true })
    await scan($, days)
    const r = await read($, report)
    const z = r?.zeros[0]
    return { text: r ? `${r.traced} of ${r.added.length} agent-added escape hatches trace to an older line${z ? `; the top one seeded ${z.copies.length}` : ''}` : ((await read($, error)) ?? 'contagion: no report') }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = await read($, report)
    const width = Math.max(30, e.props.bodyColumns)
    const rule = <Text dimColor>{'─'.repeat(Math.max(1, width - 1))}</Text>
    const header = <Text bold>CONTAGION  <Text dimColor>{r ? `${r.agentCommits} agent commits · ${r.days} days` : ''}</Text></Text>
    if (await read($, isLoading)) return <Box flexDirection="column">{header}{rule}<Text dimColor>Tracing agent commits through git history…</Text></Box>
    const err = await read($, error)
    if (err || !r) return <Box flexDirection="column">{header}{rule}<Text>{err ?? 'Run /contagion in a git repo.'}</Text></Box>
    const top = r.zeros.slice(0, 3)
    return (
      <Box flexDirection="column">
        {header}
        {rule}
        <Text wrap="wrap"><Text bold>{r.added.length}</Text> escape hatches added by agents · <Text color={RED} bold>{r.traced} copied</Text> from an older line · {r.untraced} no source</Text>
        {top.map((z, i) => (
          <Box key={`z:${i}`} flexDirection="column" marginTop={1}>
            <Text><Text color={RED} bold>{`${z.copies.length}× `}</Text><Text dimColor>{`${z.kind} · ${z.file.split('/').slice(-2).join('/')}:${z.line}`}</Text></Text>
            <Text wrap="truncate-end">{`  ${z.text}`}</Text>
          </Box>
        ))}
        <Box marginTop={1} gap={2}>
          {(await read($, fixed))
            ? <Text color="green">✓ CLAUDE.md now names them</Text>
            : <Button key="fix" hotkey="a" autoFocus label="warn agents in CLAUDE.md" onPress={() => addToClaudeMd($, r.days)} />}
          <Button key="rescan" hotkey="r" plain dimColor label="rescan" onPress={() => scan($, r.days)} />
        </Box>
      </Box>
    )
  })
}
