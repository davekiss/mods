import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bestSource, kindOf, similarity, summarize, fixLine } from '../contagion.mjs'

test('kinds', () => {
  assert.equal(kindOf('const x = y as any'), 'as any')
  assert.equal(kindOf('// @ts-expect-error broken types'), '@ts-ignore')
  assert.equal(kindOf('} catch {}'), 'swallowed catch')
  assert.equal(kindOf('p.catch(() => {})'), 'swallowed catch')
  assert.equal(kindOf('// HACK: workaround for prisma'), 'workaround')
  assert.equal(kindOf('const anyway = 1'), null)
})

test('the near twin wins, a weak match is no source', () => {
  const added = { file: 'a/b.ts', line: 9, text: '(workspace as any).featureFlags' }
  const cands = [
    { file: 'x/y.ts', line: 1, text: 'const z = foo as any' },
    { file: 'a/c.ts', line: 4, text: '(workspace as any).featureFlags ?? []' },
  ]
  assert.equal(bestSource(added, cands).file, 'a/c.ts')
  assert.equal(bestSource({ ...added, text: 'totally different as any thing here now' }, [cands[0]]), null)
  assert.ok(similarity('a as any', 'a as any') === 1)
})

test('patient zeros rank by copies and make one CLAUDE.md line', () => {
  const src = { file: 's.ts', line: 3, text: 'x as any', score: 0.9 }
  const r = summarize({ repo: 'r', days: 30, agentCommits: 2, added: [
    { sha: 'a'.repeat(40), file: 'p.ts', line: 1, text: 'x as any', kind: 'as any', at: '', source: src },
    { sha: 'b'.repeat(40), file: 'q.ts', line: 1, text: 'x as any', kind: 'as any', at: '', source: src },
    { sha: 'c'.repeat(40), file: 'q.ts', line: 2, text: 'y as any', kind: 'as any', at: '', source: null },
  ] })
  assert.equal(r.zeros[0].copies.length, 2)
  assert.equal(r.untraced, 1)
  assert.match(fixLine(r.zeros), /s\.ts:3/)
})
