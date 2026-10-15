import assert from 'node:assert/strict'
import { test } from 'node:test'

import { light, render } from '../ci-light.mjs'

const NOW = Date.parse('2026-10-15T12:00:00Z')
const run = (sha, name, conclusion, at, status = 'completed') => ({ head_sha: sha, name, path: `.github/workflows/${name}.yml`, conclusion, status, updated_at: at })

// Newest first. "bench" has failed on every push; "ci" broke on c2 and is still red on c4.
const RUNS = [
  run('c4', 'ci', 'failure', '2026-10-15T10:00:00Z'), run('c4', 'bench', 'failure', '2026-10-15T10:00:00Z'),
  run('c3', 'ci', 'cancelled', '2026-10-14T10:00:00Z'), run('c3', 'bench', 'failure', '2026-10-14T10:00:00Z'),
  run('c2', 'ci', 'failure', '2026-10-13T10:00:00Z'), run('c2', 'bench', 'failure', '2026-10-13T10:00:00Z'),
  run('c1', 'ci', 'success', '2026-10-12T10:00:00Z'), run('c1', 'bench', 'failure', '2026-10-12T10:00:00Z'),
  run('c0', 'ci', 'success', '2026-10-01T10:00:00Z'), run('c0', 'bench', 'success', '2026-10-01T10:00:00Z'),
]

test('every workflow: red since the first failure after the last all-green push', () => {
  const l = light('main', RUNS, { now: NOW })
  assert.equal(l.state, 'red')
  assert.equal(l.since, '3d 2h')
  assert.equal(l.pushes, 3)
  assert.equal(render(l, false), 'main ● red 3d 2h · 3 pushes')
})

test('a workflow filter ignores the always-failing one', () => {
  const l = light('main', RUNS, { workflow: 'ci', now: NOW })
  assert.equal(l.state, 'red')
  assert.equal(l.since, '2d 2h')
  assert.equal(l.pushes, 2) // c3 (cancelled, neutral) and c4 landed on top of c2
  assert.equal(render(l, false), 'main ● red 2d 2h · 2 pushes')
})

test('the filter matches names or files, case-insensitively', () => {
  assert.equal(light('main', RUNS, { workflow: 'CI.yml', now: NOW }).since, '2d 2h')
  assert.equal(light('main', RUNS, { workflow: 'nope', now: NOW }).state, 'none')
  assert.equal(render(light('main', RUNS, { workflow: 'nope', now: NOW }), false), 'main ○ no CI named nope')
})

test('cancelled-only pushes neither end a streak nor turn it green', () => {
  const l = light('main', [run('x2', 'ci', 'cancelled', '2026-10-15T00:00:00Z'), run('x1', 'ci', 'success', '2026-10-14T00:00:00Z')], { now: NOW })
  assert.equal(l.state, 'green')
})

test('a red streak past the window gets a +', () => {
  const l = light('main', [run('y2', 'ci', 'failure', '2026-10-15T00:00:00Z'), run('y1', 'ci', 'failure', '2026-10-10T00:00:00Z')], { now: NOW })
  assert.equal(render(l, false), 'main ● red 5d 12h+ · 1+ pushes')
})
