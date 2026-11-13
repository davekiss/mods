import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { audit, turnOff, undoOff, frontmatter } from '../skill-audit.mjs'

const NOW = Date.parse('2026-10-16T12:00:00Z')
function fixture() {
  const d = mkdtempSync(join(tmpdir(), 'sa-'))
  for (const s of ['used-skill', 'idle-skill']) {
    mkdirSync(join(d, 'skills', s), { recursive: true })
    writeFileSync(join(d, 'skills', s, 'SKILL.md'), `---\nname: ${s}\ndescription: ${'x'.repeat(396)}\n---\nbody`)
  }
  const at = join(d, 'plugins', 'cache', 'p')
  mkdirSync(join(at, 'skills', 'inner'), { recursive: true })
  mkdirSync(join(at, '.claude-plugin'), { recursive: true })
  writeFileSync(join(at, 'skills', 'inner', 'SKILL.md'), '---\nname: inner\ndescription: d\n---\n')
  writeFileSync(join(at, '.claude-plugin', 'plugin.json'), '{"name":"idleplug"}')
  writeFileSync(join(d, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'idleplug@m': [{ installPath: at }] } }))
  writeFileSync(join(d, 'settings.json'), JSON.stringify({ enabledPlugins: { 'idleplug@m': true } }))
  mkdirSync(join(d, 'projects', 'x'), { recursive: true })
  const lines = [
    { timestamp: '2026-10-15T10:00:00Z', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'used-skill' } }] } },
    { timestamp: '2026-08-01T10:00:00Z', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'idle-skill' } }] } },
  ]
  writeFileSync(join(d, 'projects', 'x', 's.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'))
  return d
}

test('frontmatter reads name and description', () => {
  assert.deepEqual(frontmatter('---\nname: a\ndescription: "b c"\n---\n'), { name: 'a', description: 'b c' })
})

test('a use older than the window does not count', () => {
  const r = audit(fixture(), 30, NOW)
  const by = Object.fromEntries(r.items.map((i) => [i.name, i.uses]))
  assert.equal(by['used-skill'], 1)
  assert.equal(by['idle-skill'], 0)
  assert.deepEqual(r.unused.sort(), ['idle-skill', 'idleplug@m'])
  assert.equal(r.sessions, 1)
})

test('off turns unused things off and undo puts them back', () => {
  const d = fixture()
  const out = turnOff(d, audit(d, 30, NOW))
  assert.equal(out.off.length, 2)
  assert.equal(JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8')).enabledPlugins['idleplug@m'], false)
  assert.ok(existsSync(join(d, 'skills-disabled', 'idle-skill')))
  assert.ok(!existsSync(join(d, 'skills', 'idle-skill')))
  undoOff(d)
  assert.equal(JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8')).enabledPlugins['idleplug@m'], true)
  assert.ok(existsSync(join(d, 'skills', 'idle-skill', 'SKILL.md')))
})
