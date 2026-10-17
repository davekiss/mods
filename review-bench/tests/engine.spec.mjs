import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KINDS, matches, parseFindings, score, verdict } from '../review-bench.mjs'

test('each kind makes a one-token bug', () => {
  assert.equal(KINDS['off-by-one'].edit('const skip = (page - 1) * limit;'), 'const skip = page * limit;')
  assert.equal(KINDS['missing await'].edit('  const user = await getUser(id);'), '  const user = getUser(id);')
  assert.equal(KINDS['wrong auth check'].edit('if (req.params.userId !== user.id) {'), 'if (req.params.userId === user.id) {')
  assert.equal(KINDS['swapped args'].edit('Object.assign(req, value);'), 'Object.assign(value, req);')
  assert.equal(KINDS['unhandled null'].edit('if (!user) {'), null)
})

test('findings parse from the end of a reply and match within 3 lines', () => {
  const f = parseFindings('Some prose.\n[{"file": "./src/a.js", "line": 14, "issue": "x"}]')
  assert.deepEqual(f, [{ file: 'src/a.js', line: 14, issue: 'x' }])
  assert.ok(matches(f[0], { file: 'src/a.js', line: 17 }))
  assert.ok(!matches(f[0], { file: 'src/a.js', line: 18 }))
})

test('rounds score new planted catches vs other new findings, and name the stop', () => {
  const s = { plants: [{ id: 1, file: 'a.js', line: 10 }, { id: 2, file: 'b.js', line: 5 }], rounds: [
    { k: 1, findings: [{ file: 'a.js', line: 10, issue: '' }, { file: 'c.js', line: 1, issue: '' }] },
    { k: 2, findings: [{ file: 'b.js', line: 6, issue: '' }] },
    { k: 3, findings: [{ file: 'd.js', line: 2, issue: '' }, { file: 'e.js', line: 9, issue: '' }] },
  ] }
  const sc = score(s)
  assert.deepEqual(sc.map((r) => [r.newCaught.length, r.newOther]), [[1, 1], [1, 0], [0, 2]])
  assert.match(verdict(s), /stop after round 2/)
})
