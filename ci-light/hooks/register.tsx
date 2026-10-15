import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Light } from '../types'

const RED = '#E4312B'
const REFRESH_MS = 120_000 // ci-light.mjs caches each repo for as long

const light = atom({ plugin: 'ci-light', key: 'light' } as const, null as Light | null)
const hidden = atom({ plugin: 'ci-light', key: 'hidden' } as const, null as string | null)
const told = atom({ plugin: 'ci-light', key: 'told' } as const, null as string | null)

// One red streak, so "hide" and "told the model" last until main changes.
export const streakKey = (l: Light) => `${l.repo}:${l.state}:${l.since?.split(' ')[0] ?? ''}`

// What the model reads with the next prompt while main is red; null when there's nothing to say.
export function agentNote(l: Light | null): string | null {
  if (l?.state !== 'red') return null
  const on = l.pushes ? `, and ${l.pushes}${l.more ? '+' : ''} push${l.pushes === 1 && !l.more ? '' : 'es'} landed on top` : ''
  const which = l.workflows ? ` (workflows: ${l.workflows})` : ''
  return `ci-light: ${l.repo}'s default branch ${l.branch} has been failing CI${which} for ${l.since}${l.more ? '+' : ''}${on}. Before building on it or saying a change works, check whether your change touches the failure (gh run list --branch ${l.branch}).`
}

async function refresh($: EngineInterface, workflow: string) {
  const argv = ['node', `${$.plugin.root}/ci-light.mjs`, '--json']
  if (workflow) argv.push('--workflow', workflow)
  const ran = await $.process.run(argv, { timeoutMs: 15_000 })
  if (ran.exitCode !== 0) return
  try {
    const l = JSON.parse(ran.stdout) as Light | null
    await update($, light, () => l)
  } catch {}
}

export const register: Register = (on, options) => {
  const workflow = String(options.workflow ?? '').trim()

  on('session.start', async ($, e, next) => {
    await refresh($, workflow)
    $.clock.every(REFRESH_MS, () => refresh($, workflow))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    await refresh($, workflow)
    return out
  })

  // The agent sees it too: once per red streak, the next prompt carries a note.
  on('prompt.submit', async ($, e, next) => {
    const l = await read($, light)
    const note = agentNote(l)
    if (note === null || l === null || (await read($, told)) === streakKey(l)) return next(e)
    await update($, told, () => streakKey(l))
    return next({ ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => next(e)) // a failed note never blocks the prompt

  // Red main: one row above the prompt you can't miss.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking) return next(e)
    const l = await read($, light)
    if (l?.state !== 'red' || (await read($, hidden)) === streakKey(l)) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const more = l.more ? '+' : ''
    return (
      <Box gap={2}>
        <Text color={RED} bold>● {l.branch} is red</Text>
        <Text>for {l.since}{more}</Text>
        {l.pushes > 0 && <Text>· {l.pushes}{more} push{l.pushes === 1 && !more ? '' : 'es'} on top</Text>}
        {l.workflows && <Text dimColor>{l.workflows}</Text>}
        <Button key="ci-light-hide" plain dimColor label="hide" onPress={() => update($, hidden, () => streakKey(l))} />
      </Box>
    )
  })

  // Otherwise a quiet word under the prompt: green, running, or red once hidden.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const l = await read($, light)
    if (!l || l.state === 'error') return next(e)
    return next({ ...e, props: { ...e.props, tail: `ci ${l.text}` } })
  })
}
