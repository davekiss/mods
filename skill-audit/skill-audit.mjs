#!/usr/bin/env node
// skill-audit: which installed skills and plugins your agent actually used, from your own transcripts,
// what the unused ones cost in context every session (est.), and a reversible switch to turn them off.
//   node skill-audit.mjs [--days 30] [--json] [--dir ~/.claude]
//   node skill-audit.mjs off [--keep name,name]    turn off everything unused (plugins via enabledPlugins, user skills moved aside)
//   node skill-audit.mjs undo                       put back what the last `off` changed
import { existsSync, readdirSync, readFileSync, renameSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : dflt
}
const DIR = flag('dir', process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'))
const DAYS = Number(flag('days', 30))
const KEEP = new Set(String(flag('keep', '')).split(',').filter(Boolean))
const UNDO = join(DIR, 'skill-audit-undo.json')
const SETTINGS = join(DIR, 'settings.json')

const readJson = (p, dflt) => {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return dflt }
}
const dirs = (p) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [])
const files = (p, ext) => (existsSync(p) ? readdirSync(p).filter((f) => f.endsWith(ext)) : [])

// What Claude Code keeps in context every session for a skill or command: its name and description.
export function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  const out = {}
  if (!m) return out
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/)
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '')
  }
  return out
}
export const estTokens = (s) => Math.ceil(s.length / 4)

function skillsIn(root) {
  return dirs(root).flatMap((name) => {
    const p = join(root, name, 'SKILL.md')
    if (!existsSync(p)) return []
    const fm = frontmatter(readFileSync(p, 'utf8'))
    return [{ name: fm.name || name, dir: join(root, name), tokens: estTokens(`${fm.name || name}: ${fm.description ?? ''}`) }]
  })
}
function commandsIn(root) {
  return files(root, '.md').map((f) => {
    const fm = frontmatter(readFileSync(join(root, f), 'utf8'))
    return { name: basename(f, '.md'), tokens: estTokens(`/${basename(f, '.md')}: ${fm.description ?? ''}`) }
  })
}

export function installed(dir = DIR) {
  const settings = readJson(join(dir, 'settings.json'), {})
  const enabled = settings.enabledPlugins ?? {}
  const items = skillsIn(join(dir, 'skills')).map((s) => ({ kind: 'skill', id: s.name, name: s.name, dir: s.dir, tokens: s.tokens, on: true }))
  for (const c of commandsIn(join(dir, 'commands'))) items.push({ kind: 'command', id: `/${c.name}`, name: c.name, tokens: c.tokens, on: true })
  const plugins = readJson(join(dir, 'plugins', 'installed_plugins.json'), { plugins: {} }).plugins ?? {}
  for (const [key, installs] of Object.entries(plugins)) {
    const at = [].concat(installs)[0]?.installPath
    if (!at) continue
    const name = key.split('@')[0]
    const skills = skillsIn(join(at, 'skills'))
    const commands = commandsIn(join(at, 'commands'))
    const manifest = readJson(join(at, '.claude-plugin', 'plugin.json'), {})
    const mcp = Object.keys(readJson(join(at, '.mcp.json'), {}).mcpServers ?? manifest.mcpServers ?? {})
    items.push({
      kind: 'plugin', id: key, name, on: enabled[key] !== false,
      skills: skills.map((s) => s.name), commands: commands.map((c) => c.name), mcp,
      tokens: [...skills, ...commands].reduce((n, s) => n + s.tokens, 0) + estTokens(manifest.description ?? ''),
    })
  }
  return items
}

// Every use in the last `days`: Skill tool calls, plugin MCP tool calls and /commands typed.
export function usage(dir = DIR, days = DAYS, now = Date.now()) {
  const since = now - days * 86_400_000
  const uses = new Map() // id-ish key -> { n, last }
  const hit = (key, at) => {
    const u = uses.get(key) ?? { n: 0, last: 0 }
    uses.set(key, { n: u.n + 1, last: Math.max(u.last, at) })
  }
  let sessions = 0
  const root = join(dir, 'projects')
  for (const project of dirs(root)) {
    for (const f of files(join(root, project), '.jsonl')) {
      const p = join(root, project, f)
      if (statSync(p).mtimeMs < since) continue
      let counted = false
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        if (!line) continue
        let e
        try { e = JSON.parse(line) } catch { continue }
        const at = Date.parse(e.timestamp ?? '') || 0
        if (at < since) continue
        if (!counted) { sessions++; counted = true }
        const content = e.message?.content
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type !== 'tool_use') continue
            if (c.name === 'Skill' && c.input?.skill) hit(`skill:${c.input.skill}`, at)
            const m = c.name?.match(/^mcp__plugin_([^_]+(?:-[^_]+)*)_/)
            if (m) hit(`plugin:${m[1]}`, at)
          }
        }
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c.text ?? '').join('') : ''
        for (const m of text.matchAll(/<command-name>\/?([^<]+)<\/command-name>/g)) hit(`command:${m[1].trim()}`, at)
      }
    }
  }
  return { uses, sessions }
}

export function audit(dir = DIR, days = DAYS, now = Date.now()) {
  const { uses, sessions } = usage(dir, days, now)
  const get = (k) => uses.get(k)
  const merge = (...us) => us.filter(Boolean).reduce((a, u) => ({ n: a.n + u.n, last: Math.max(a.last, u.last) }), { n: 0, last: 0 })
  const items = installed(dir).filter((it) => it.name !== "skill-audit").map((it) => {
    let u
    if (it.kind === 'skill') u = merge(get(`skill:${it.name}`))
    else if (it.kind === 'command') u = merge(get(`command:${it.name}`))
    else u = merge(get(`plugin:${it.name}`), get(`command:${it.name}`), ...it.skills.map((s) => get(`skill:${it.name}:${s}`)), ...it.skills.map((s) => get(`skill:${s}`)), ...it.commands.map((c) => get(`command:${it.name}:${c}`)))
    return { ...it, uses: u.n, lastUsed: u.last || null }
  })
  items.sort((a, b) => b.uses - a.uses || b.tokens - a.tokens)
  const unused = items.filter((i) => i.on && i.uses === 0 && !KEEP.has(i.name) && i.kind !== 'command')
  return { days, sessions, items, unused: unused.map((i) => i.id), unusedTokens: unused.reduce((n, i) => n + i.tokens, 0), totalTokens: items.filter((i) => i.on).reduce((n, i) => n + i.tokens, 0) }
}

export function turnOff(dir = DIR, r = audit(dir)) {
  const settings = readJson(join(dir, 'settings.json'), {})
  const undo = { at: new Date().toISOString(), plugins: {}, skills: [] }
  for (const it of r.items.filter((i) => r.unused.includes(i.id))) {
    if (it.kind === 'plugin') {
      undo.plugins[it.id] = settings.enabledPlugins?.[it.id] ?? null
      settings.enabledPlugins = { ...settings.enabledPlugins, [it.id]: false }
    } else if (it.kind === 'skill') {
      const to = join(dir, 'skills-disabled', basename(it.dir))
      mkdirSync(join(dir, 'skills-disabled'), { recursive: true })
      renameSync(it.dir, to)
      undo.skills.push({ from: to, to: it.dir })
    }
  }
  writeFileSync(join(dir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`)
  writeFileSync(join(dir, 'skill-audit-undo.json'), `${JSON.stringify(undo, null, 2)}\n`)
  return { off: r.unused, savedTokens: r.unusedTokens }
}

export function undoOff(dir = DIR) {
  const undo = readJson(join(dir, 'skill-audit-undo.json'), null)
  if (!undo) return { restored: [] }
  const settings = readJson(join(dir, 'settings.json'), {})
  for (const [id, was] of Object.entries(undo.plugins)) {
    if (was === null) delete settings.enabledPlugins[id]
    else settings.enabledPlugins[id] = was
  }
  writeFileSync(join(dir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`)
  for (const s of undo.skills) if (existsSync(s.from)) renameSync(s.from, s.to)
  writeFileSync(join(dir, 'skill-audit-undo.json'), 'null\n')
  return { restored: [...Object.keys(undo.plugins), ...undo.skills.map((s) => basename(s.to))] }
}

const ago = (t, now = Date.now()) => {
  if (!t) return 'never'
  const d = Math.floor((now - t) / 86_400_000)
  return d === 0 ? 'today' : `${d}d ago`
}
export function render(r) {
  const lines = [`skill-audit · last ${r.days} days · ${r.sessions} sessions`, '']
  for (const i of r.items) {
    const mark = !i.on ? '○' : i.uses ? '●' : '✕'
    lines.push(`${mark} ${i.name.padEnd(20).slice(0, 20)} ${String(i.uses).padStart(3)} uses  ${ago(i.lastUsed).padEnd(8)} ~${i.tokens} tok`)
  }
  lines.push('', `${r.unused.length} unused, ~${r.unusedTokens} of ~${r.totalTokens} tokens loaded every session (est.)`)
  return lines.join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = argv[0]
  if (cmd === 'off') console.log(JSON.stringify(turnOff()))
  else if (cmd === 'undo') console.log(JSON.stringify(undoOff()))
  else {
    const r = audit()
    console.log(argv.includes('--json') ? JSON.stringify(r) : render(r))
  }
}
