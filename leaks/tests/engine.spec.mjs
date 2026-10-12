import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ENGINE = join(import.meta.dirname, '..', 'leaks.mjs')
const MIN = 60_000

// A subagent transcript: one Opus 5.5 call per step, `gapMin` apart. Each step after the first
// re-writes the whole context to the 5-minute cache when the gap outlived it, as Claude Code does.
function transcripts(gapMin, steps = 6, context = 400_000) {
  const dir = mkdtempSync(join(tmpdir(), 'leaks-'))
  const sub = join(dir, 'proj', 'sess', 'subagents')
  mkdirSync(sub, { recursive: true })
  const start = Date.now() - steps * gapMin * MIN - MIN
  const lines = Array.from({ length: steps }, (_, i) => {
    const expired = i > 0 && gapMin > 5
    const usage = { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: i === 0 || expired ? 0 : context, cache_creation: { ephemeral_5m_input_tokens: i === 0 || expired ? context : 2_000, ephemeral_1h_input_tokens: 0 } }
    return JSON.stringify({ type: 'assistant', isSidechain: true, agentId: 'a1', sessionId: 'sess', timestamp: new Date(start + i * gapMin * MIN).toISOString(), requestId: `r${i}`, message: { id: `m${i}`, model: 'claude-opus-5-5', usage, content: [{ type: 'tool_use', id: `t${i}`, name: 'Edit', input: {} }] } })
  })
  writeFileSync(join(sub, 'agent-a1.jsonl'), lines.join('\n'))
  return dir
}

const run = (dir) => JSON.parse(execFileSync('node', [ENGINE, '--json', '--dir', dir], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } }))

test('subagents idling 10 minutes between steps: a 1-hour cache is the fix', () => {
  const r = run(transcripts(10))
  const leak = r.leaks.find((l) => l.kind === 'subagent-cache')
  assert.equal(r.subagentCache.rebuilds, 5)
  assert.equal(leak?.apply, 'setting subagentPromptCacheTtl=1h')
  assert.ok(r.subagentCache.with1h < r.subagentCache.actual)
})

test('subagents that never idle: a 1-hour cache only costs more, so no leak', () => {
  const r = run(transcripts(1))
  assert.equal(r.subagentCache.rebuilds, 0)
  assert.ok(r.subagentCache.with1h > r.subagentCache.actual)
  assert.equal(r.leaks.some((l) => l.kind === 'subagent-cache'), false)
})
