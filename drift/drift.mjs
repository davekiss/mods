#!/usr/bin/env node
// drift: snapshot the global files an agent session can quietly change, then diff them after every
// tool call, so a change outside the project is named on the turn that made it, with the command and an undo.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const H = process.env.DRIFT_HOME || os.homedir()
const DIR = process.env.DRIFT_DIR || path.join(H, '.claude', 'drift')
const FILES = [
  '.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile', '.config/fish/config.fish',
  '.gitconfig', '.config/git/config', '.npmrc', '.yarnrc.yml', '.bunfig.toml', '.pip/pip.conf', '.config/pip/pip.conf',
  '.ssh/config', '.ssh/authorized_keys', '.claude/settings.json', '.codex/config.toml', '.aws/config',
]
const DIRS = ['Library/LaunchAgents', '.config/systemd/user', '.config/autostart']
const MAX = 256 * 1024
const tilde = (k) => k.startsWith(H + '/') ? '~/' + k.slice(H.length + 1) : k

const read = (p) => { try { const s = fs.statSync(p); return s.isFile() && s.size <= MAX ? fs.readFileSync(p, 'utf8') : s.isFile() ? `(${s.size} bytes, too big to diff)` : null } catch { return null } }
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }) } catch { return '' } }

function npmRoot(state) {
  if (state.npmRoot === undefined) state.npmRoot = run('npm', ['root', '-g']).trim() || null
  return state.npmRoot
}

// every watched thing as { key: text | null }
function snapshot(state) {
  const snap = {}
  for (const f of FILES) snap[path.join(H, f)] = read(path.join(H, f))
  for (const d of DIRS) {
    const dir = path.join(H, d)
    let names = []
    try { names = fs.readdirSync(dir) } catch {}
    for (const n of names) snap[path.join(dir, n)] = read(path.join(dir, n))
  }
  snap.crontab = run('crontab', ['-l']) || null
  const root = npmRoot(state)
  if (root) {
    const pk = []
    try {
      for (const n of fs.readdirSync(root)) {
        if (n.startsWith('@')) for (const m of fs.readdirSync(path.join(root, n))) pk.push(`${n}/${m}`)
        else if (!n.startsWith('.')) pk.push(n)
      }
    } catch {}
    snap['npm -g'] = pk.sort().join('\n') + '\n'
  }
  return snap
}

// a token in a diff line would reach the model and the screen: keep the name, hide the value
const SECRET = /(token|secret|password|passwd|_auth|apikey|api_key|aws_access|aws_secret|bearer|private)/i
const mask = (l) => SECRET.test(l) ? l.replace(/([=:]\s*)("?)[^\s"]{4,}/, '$1$2(hidden by drift)') : l

// lines added and removed, as a multiset (order changes are not drift)
function lineDiff(a, b) {
  const count = (s) => { const m = new Map(); for (const l of (s ?? '').split('\n')) if (l.trim()) m.set(l, (m.get(l) || 0) + 1); return m }
  const A = count(a), B = count(b), out = []
  for (const [l, n] of A) for (let i = 0; i < n - (B.get(l) || 0); i++) out.push('- ' + mask(l))
  for (const [l, n] of B) for (let i = 0; i < n - (A.get(l) || 0); i++) out.push('+ ' + mask(l))
  return out
}

function diff(before, after) {
  const changes = []
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[k] ?? null, b = after[k] ?? null
    if (a === b) continue
    const label = k === 'npm -g' ? 'global npm packages' : k === 'crontab' ? 'crontab' : tilde(k)
    const lines = lineDiff(a, b)
    changes.push({ key: k, label, kind: a === null ? 'created' : b === null ? 'deleted' : 'changed', lines: lines.length ? lines : ['(whitespace or line order only)'], before: a, after: b })
  }
  return changes
}

const stateFile = (sid) => path.join(DIR, `${sid}.json`)
const load = (sid) => { try { return JSON.parse(fs.readFileSync(stateFile(sid), 'utf8')) } catch { return null } }
const save = (sid, st) => { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile(sid), JSON.stringify(st), { mode: 0o600 }) }
function latest() {
  try {
    const f = fs.readdirSync(DIR).filter((n) => n.endsWith('.json')).map((n) => [n, fs.statSync(path.join(DIR, n)).mtimeMs]).sort((a, b) => b[1] - a[1])[0]
    return f ? f[0].slice(0, -5) : null
  } catch { return null }
}

function describe(cause, changes) {
  const n = changes.length
  const head = `drift: ${cause} changed ${n === 1 ? 'a global file' : `${n} global files`}`
  const body = changes.map((c) => `${c.label}${c.kind === 'changed' ? '' : ` (${c.kind})`}\n${c.lines.slice(0, 8).map((l) => '  ' + l).join('\n')}${c.lines.length > 8 ? `\n  … ${c.lines.length - 8} more lines` : ''}`).join('\n')
  return `${head}\n${body}\nUndo: /drift:undo`
}

async function hook() {
  let input = {}
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}') } catch {}
  const sid = input.session_id || 'nosession'
  const ev = input.hook_event_name
  let st = load(sid)
  if (ev === 'SessionStart' || !st) {
    st = st || { events: [] }
    st.snap = snapshot(st)
    st.cwd = input.cwd
    return save(sid, st)
  }
  const now = snapshot(st)
  const changes = diff(st.snap, now)
  st.snap = now
  if (!changes.length) return save(sid, st)
  const cmd = input.tool_input?.command
  const cause = ev === 'PostToolUse'
    ? (cmd ? `\`${cmd.length > 80 ? cmd.slice(0, 77) + '…' : cmd}\`` : `the ${input.tool_name} tool`)
    : 'something outside a tool call (a background process or another app)'
  for (const c of changes) st.events.push({ at: new Date().toISOString(), cause, tool: input.tool_name ?? null, ...c })
  save(sid, st)
  const msg = describe(cause, changes)
  const tell = `${msg}\n\n(drift is a hook watching files outside the project.) Tell the user plainly what changed outside the project and whether it looks expected for what they asked. If it doesn't, say so first and offer to undo it with /drift:undo.`
  if (ev === 'PostToolUse') {
    process.stdout.write(JSON.stringify({ systemMessage: msg, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: tell } }))
  } else if (ev === 'Stop' && !input.stop_hook_active) {
    process.stdout.write(JSON.stringify({ systemMessage: msg, decision: 'block', reason: tell }))
  } else {
    process.stdout.write(JSON.stringify({ systemMessage: msg }))
  }
}

function log(sid, json) {
  const st = load(sid)
  const ev = st?.events ?? []
  if (json) return console.log(JSON.stringify(ev.map(({ before, after, ...e }) => e), null, 2))
  if (!ev.length) return console.log('drift: nothing outside the project has changed this session')
  ev.forEach((e, i) => console.log(`${i + 1}. ${e.at.slice(11, 19)}  ${e.label}${e.undone ? ' (undone)' : ''}  by ${e.cause}\n${e.lines.slice(0, 8).map((l) => '     ' + l).join('\n')}`))
  console.log('\nUndo all: /drift:undo   one: /drift:undo <n>')
}

function undo(sid, which) {
  const st = load(sid)
  if (!st) return console.log('drift: no session to undo')
  const picks = st.events.map((e, i) => [e, i + 1]).filter(([e, i]) => !e.undone && (which === 'all' || !which || Number(which) === i))
  // the first change to each key holds the state before the session touched it
  const firsts = new Map()
  for (const [e] of picks) if (!firsts.has(e.key)) firsts.set(e.key, e)
  for (const [key, e] of firsts) {
    if (key === 'npm -g') {
      const added = e.lines.filter((l) => l.startsWith('+ ')).map((l) => l.slice(2))
      console.log(added.length ? `global npm packages: run \`npm rm -g ${added.join(' ')}\`` : 'global npm packages: nothing to remove')
    } else if (key === 'crontab') {
      execFileSync('crontab', e.before ? ['-'] : ['-r'], { input: e.before ?? '' })
      console.log('crontab: restored')
    } else if (e.before === null) {
      fs.rmSync(key, { force: true }); console.log(`${e.label}: removed (it didn't exist before)`)
    } else {
      fs.writeFileSync(key, e.before); console.log(`${e.label}: restored`)
    }
  }
  for (const [e] of picks) e.undone = true
  st.snap = snapshot(st)
  save(sid, st)
}

// fixture mode: a throwaway home, one change of each kind, the events drift reports
function selftest() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-home-'))
  const env = { ...process.env, DRIFT_HOME: home, DRIFT_DIR: path.join(home, '.claude', 'drift') }
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
  fs.writeFileSync(path.join(home, '.zshrc'), 'export EDITOR=vim\n')
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = You\n')
  const call = (payload) => execFileSync(process.execPath, [process.argv[1], 'hook'], { input: JSON.stringify(payload), env, encoding: 'utf8' })
  call({ session_id: 't', hook_event_name: 'SessionStart' })
  fs.appendFileSync(path.join(home, '.zshrc'), 'export PATH="$HOME/.cache/x/bin:$PATH"\n')
  fs.writeFileSync(path.join(home, '.npmrc'), 'registry=https://example.invalid/\n')
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = You\n[core]\n\thooksPath = /tmp/h\n')
  fs.appendFileSync(path.join(home, '.ssh', 'config'), 'Host *\n  ProxyCommand nc example.invalid 22\n')
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true })
  fs.writeFileSync(path.join(home, 'Library', 'LaunchAgents', 'com.x.plist'), '<plist/>\n')
  const out = call({ session_id: 't', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm install' } })
  const quiet = call({ session_id: 't', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })
  console.log(JSON.stringify({ home, flagged: JSON.parse(out).systemMessage, quietWhenNothingChanged: quiet === '' }, null, 2))
}

const [cmd = 'log', arg] = process.argv.slice(2)
const json = process.argv.includes('--json')
const sid = process.env.DRIFT_SESSION || latest()
if (cmd === 'hook') await hook()
else if (cmd === 'undo') undo(sid, arg)
else if (cmd === 'selftest') selftest()
else log(sid, json)
