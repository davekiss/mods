import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Bench } from '../types'

const PANE = 'review-bench'
const RED = '#E4312B'

const bench = atom({ plugin: 'review-bench', key: 'bench' } as const, null as Bench | null)
const status = atom({ plugin: 'review-bench', key: 'status' } as const, null as string | null)
const error = atom({ plugin: 'review-bench', key: 'error' } as const, null as string | null)

async function engine($: EngineInterface, args: string[]) {
  const ran = await $.process.run(['node', `${$.plugin.root}/review-bench.mjs`, ...args, '--json'], { timeoutMs: 600_000 })
  if (ran.exitCode !== 0) throw new Error((ran.stderr || ran.stdout).trim().slice(0, 300))
  return JSON.parse(ran.stdout)
}

async function run($: EngineInterface, n: number, rounds: number, model: string) {
  await update($, error, () => null)
  await update($, bench, () => null)
  try {
    await update($, status, () => `planting ${n} bugs in a throwaway worktree…`)
    { const b = (await engine($, ['plant', '--n', String(n)])) as Bench; await update($, bench, () => b) }
    for (let k = 1; k <= rounds; k++) {
      await update($, status, () => `review round ${k} of ${rounds}…`)
      { const b = (await engine($, ['round', String(k), ...(model ? ['--model', model] : [])])) as Bench; await update($, bench, () => b) }
    }
    await update($, status, () => null)
  } catch (err) {
    await update($, status, () => null)
    await update($, error, () => `review-bench: ${String((err as Error).message ?? err)}`)
  }
}

export const register: Register = (on, options) => {
  const model = String(options.model ?? '').trim()

  on('session.start', async ($, e, next) => {
    await $.command
      .register({ name: 'review-bench', description: 'Plant known bugs in a throwaway worktree, run review rounds, see which round stops finding them (/review-bench --n 5 --rounds 3)' })
      .catch(() => $.ui.toast('review-bench: /review-bench is taken by another command'))
    return next(e)
  })

  on('command.run', { command: 'review-bench' }, async ($, e) => {
    const n = Number(e.args.match(/--n\s+(\d+)/)?.[1] ?? 5)
    const rounds = Number(e.args.match(/--rounds\s+(\d+)/)?.[1] ?? 3)
    await $.ui.open({ id: PANE, title: 'Review bench', focus: true })
    await run($, n, rounds, model)
    const b = await read($, bench)
    return { text: b?.verdict ?? (await read($, error)) ?? 'review-bench: no result' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const b = await read($, bench)
    const st = await read($, status)
    const err = await read($, error)
    const width = Math.max(30, e.props.bodyColumns)
    const rule = <Text dimColor>{'─'.repeat(Math.max(1, width - 1))}</Text>
    const caught = new Set(b?.rounds.flatMap((r) => r.newCaught) ?? [])
    return (
      <Box flexDirection="column">
        <Text bold>REVIEW BENCH  <Text dimColor>{b ? `${b.plants.length} planted bugs · ${b.rounds.length} rounds` : ''}</Text></Text>
        {rule}
        {b && b.plants.map((p) => (
          <Text key={`p:${p.id}`} wrap="truncate-end">
            <Text color={caught.has(p.id) ? 'green' : RED}>{caught.has(p.id) ? '✓ ' : '· '}</Text>
            <Text>{p.kind.padEnd(17)}</Text>
            <Text dimColor>{`${p.file.split('/').slice(-1)[0]}:${p.line}`}</Text>
          </Text>
        ))}
        {b && b.rounds.length > 0 && <Box marginTop={1} flexDirection="column">
          {b.rounds.map((r) => (
            <Text key={`r:${r.round}`}>
              <Text bold>{`round ${r.round}  `}</Text>
              <Text color={r.newCaught.length ? 'green' : RED} bold>{`+${r.newCaught.length} planted`}</Text>
              <Text>{`  +${r.newOther} other`}</Text>
              <Text dimColor>{`  ${r.costUsd != null ? `$${r.costUsd.toFixed(2)}` : ''}`}</Text>
            </Text>
          ))}
        </Box>}
        {st && <Box marginTop={1}><Text dimColor>{st}</Text></Box>}
        {err && <Box marginTop={1}><Text color={RED}>{err}</Text></Box>}
        {b?.verdict && !st && <Box marginTop={1}><Text color="yellow" bold wrap="wrap">{b.verdict}</Text></Box>}
        {!st && <Box marginTop={1}><Button key="clean" hotkey="c" plain dimColor label="remove worktree" onPress={async () => { await engine($, ['clean']); $.ui.toast('review-bench: worktree removed') }} /></Box>}
      </Box>
    )
  })
}
