#!/usr/bin/env node
// leaks: reads Claude Code's session transcripts (~/.claude/projects) and ranks where your tokens leaked,
// each leak priced at API rates with the fix: sessions that ran past the compact point, cache rebuilds after
// a break, read-only subagents on a big model, and huge tool outputs re-sent on every later turn.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1] }
const DAYS = +opt('--days', 7)
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const ROOT = opt('--dir', path.join(CLAUDE_DIR, 'projects'))
const PLAIN = args.includes('--plain') || !process.stdout.isTTY && !args.includes('--color')
const WIDTH = Math.min(+opt('--width', process.stdout.columns || 60), 72)
const kTokens = (s) => /k$/i.test(s) ? +s.slice(0, -1) * 1000 : +s
const COMPACT_AT = kTokens(opt('--compact-at', '400k'))
const SUMMARY = 20000 // tokens a compaction summary leaves behind, roughly

// $ per million tokens, from platform.claude.com/docs/en/about-claude/pricing (2026-10-12).
const PRICES = [
  [/opus-5-5/, { name: 'Opus 5.5', in: 4, w5: 5, w1h: 8, read: 0.2, out: 20 }],
  [/opus-(5|4)/, { name: 'Opus', in: 5, w5: 6.25, w1h: 10, read: 0.5, out: 25 }],
  [/sonnet-5-5/, { name: 'Sonnet 5.5', in: 2, w5: 2.5, w1h: 4, read: 0.1, out: 10 }],
  [/sonnet/, { name: 'Sonnet', in: 2, w5: 2.5, w1h: 4, read: 0.2, out: 10 }],
  [/haiku/, { name: 'Haiku 4.5', in: 1, w5: 1.25, w1h: 2, read: 0.1, out: 5 }],
  [/fable|mythos/, { name: 'Fable', in: 10, w5: 12.5, w1h: 20, read: 0.25, out: 50 }],
]
const HAIKU = PRICES.find(([re]) => re.source === 'haiku')[1]
const rate = (model) => (PRICES.find(([re]) => re.test(model || '')) || [null, null])[1]
const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookRead'])
const READ_ONLY_BASH = /^\s*(ls|cat|head|tail|grep|rg|find|wc|git (log|show|diff|status|blame))\b/

function writes(u) {
  const cc = u.cache_creation || {}
  const w1h = cc.ephemeral_1h_input_tokens || 0
  const w5 = cc.ephemeral_5m_input_tokens ?? (cc.ephemeral_1h_input_tokens == null ? u.cache_creation_input_tokens || 0 : 0)
  return { w5, w1h }
}
// Everything the model was sent on one call: the whole conversation so far.
const context = (u) => { const { w5, w1h } = writes(u); return (u.input_tokens || 0) + w5 + w1h + (u.cache_read_input_tokens || 0) }

function cost(u, r) {
  if (!r) return 0
  const { w5, w1h } = writes(u)
  return ((u.input_tokens || 0) * r.in + w5 * r.w5 + w1h * r.w1h + (u.cache_read_input_tokens || 0) * r.read + (u.output_tokens || 0) * r.out) / 1e6
}

function files(dir) {
  let out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out = out.concat(files(p))
    else if (e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const settings = readJson(path.join(CLAUDE_DIR, 'settings.json')) || {}

const since = Date.now() - DAYS * 86400e3
const calls = new Map() // one per API response; Claude Code writes a line per content block with the same usage
const results = [] // big tool outputs
const toolNames = new Map()
const sessionInfo = new Map() // session -> { cwd, prompt }
for (const f of fs.existsSync(ROOT) ? files(ROOT) : []) {
  if (fs.statSync(f).mtimeMs < since) continue
  const sub = /[/\\]subagents[/\\]|agent-[^/\\]*\.jsonl$/.test(f)
  const agentType = sub ? readJson(f.replace(/\.jsonl$/, '.meta.json'))?.agentType : null
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue
    let o; try { o = JSON.parse(line) } catch { continue }
    const ts = Date.parse(o.timestamp || '')
    if (ts && ts < since) continue
    const m = o.message
    const said = !sub && o.type === 'user' && typeof m?.content === 'string' ? m.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : ''
    if (said && !said.startsWith('/') && !sessionInfo.has(o.sessionId)) sessionInfo.set(o.sessionId, { cwd: o.cwd, prompt: said })
    if (o.type === 'assistant' && m?.usage) {
      const key = `${m.id}:${o.requestId || ''}`
      const c = calls.get(key) || { key, file: f, session: o.sessionId, sidechain: sub || !!o.isSidechain, agent: o.agentId || (sub ? path.basename(f) : null), agentType, model: m.model, ts, usage: m.usage, tools: [] }
      for (const b of m.content || []) if (b.type === 'tool_use') { c.tools.push({ name: b.name, cmd: b.input?.command, file: b.input?.file_path || b.input?.path }); toolNames.set(b.id, { name: b.name, file: b.input?.file_path || b.input?.pattern || b.input?.command }) }
      calls.set(key, c)
    }
    if (o.type === 'user' && Array.isArray(m?.content)) for (const b of m.content) {
      if (b.type !== 'tool_result') continue
      const text = typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text || '').join('')
      const tokens = Math.round(text.length / 4) // rough: ~4 characters per token
      if (tokens >= 8000) results.push({ id: b.tool_use_id, session: o.sessionId, sidechain: sub || !!o.isSidechain, file: f, ts, tokens })
    }
  }
}

const all = [...calls.values()].filter((c) => c.model && c.model !== '<synthetic>').sort((a, b) => a.ts - b.ts)
for (const c of all) c.cost = cost(c.usage, rate(c.model))
const total = all.reduce((s, c) => s + c.cost, 0)
const leaks = []
const usd = (n) => n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`
const label = (session) => {
  const s = sessionInfo.get(session)
  if (!s) return 'a session'
  const p = s.prompt
  return `${s.cwd ? path.basename(s.cwd) + ': ' : ''}"${p.length > 44 ? p.slice(0, 43) + '…' : p}"`
}
const bySession = new Map()
for (const c of all.filter((c) => !c.sidechain)) bySession.set(c.session, [...(bySession.get(c.session) || []), c])

// 1. Sessions that ran far past the compact point. Every turn re-reads the whole conversation, so a turn at
// 800k costs four times a turn at 200k. Replays the session as if it had compacted at COMPACT_AT: the context
// grows by the same amount each turn, drops to SUMMARY at the compact point, and each compaction is charged.
const long = []
const pastCompact = all.filter((c) => !c.sidechain && context(c.usage) > COMPACT_AT).reduce((s, c) => s + c.cost, 0)
for (const [session, cs] of bySession) {
  let prev = 0, sim = 0, saved = 0, compactions = 0, over = 0, peak = 0
  for (const c of cs) {
    const r = rate(c.model), size = context(c.usage)
    if (!r) continue
    if (size < prev / 2) sim = Math.min(sim, size) // it compacted or cleared for real
    else sim += Math.max(0, size - prev)
    if (sim > COMPACT_AT) {
      compactions++
      saved -= (COMPACT_AT * r.read + SUMMARY * r.out + SUMMARY * r.w1h) / 1e6
      sim = SUMMARY
    }
    if (size > sim) saved += (size - sim) * r.read / 1e6
    if (size > COMPACT_AT) over++
    prev = size; peak = Math.max(peak, size)
  }
  if (saved >= 0.5) long.push({ session, saved, over, peak })
}
if (long.length) {
  long.sort((a, b) => b.saved - a.saved)
  const turns = long.reduce((s, l) => s + l.over, 0)
  leaks.push({ kind: 'context', save: long.reduce((s, l) => s + l.saved, 0), title: `${long.length} session${long.length === 1 ? '' : 's'} ran past ${COMPACT_AT / 1000}k context (up to ${Math.round(Math.max(...long.map((l) => l.peak)) / 1000)}k)`, detail: `${turns.toLocaleString()} turns each re-read the whole conversation. Biggest: ${long.slice(0, 3).map((l) => `${label(l.session)} ${usd(l.saved)}`).join(' · ')}`, fix: `compact at ${COMPACT_AT / 1000}k: /autocompact ${COMPACT_AT / 1000}k, or "autoCompactWindow": ${COMPACT_AT} in ~/.claude/settings.json`, apply: `setting autoCompactWindow=${COMPACT_AT}` })
}

const rebuilds = []
// 2. Cache rebuilt after a break longer than the cache lives (5 minutes, or an hour for the 1h cache).
for (const [session, cs] of bySession) for (let i = 1; i < cs.length; i++) {
  const gap = (cs[i].ts - cs[i - 1].ts) / 1000
  const u = cs[i].usage, r = rate(cs[i].model)
  const { w5, w1h } = writes(u)
  const ttl = w1h > w5 ? 3600 : 300
  if (gap < ttl || w5 + w1h < 5000 || !r) continue
  const extra = (w5 * (r.w5 - r.read) + w1h * (r.w1h - r.read)) / 1e6
  rebuilds.push({ session, extra, tokens: w5 + w1h, gap })
}
if (rebuilds.length) {
  rebuilds.sort((a, b) => b.extra - a.extra)
  const big = rebuilds[0], h = Math.floor(big.gap / 3600), m = Math.round((big.gap % 3600) / 60)
  leaks.push({ kind: 'cache', save: rebuilds.reduce((s, b) => s + b.extra, 0), title: `Cache rebuilt ${rebuilds.length} time${rebuilds.length === 1 ? '' : 's'} after a break`, detail: `Coming back after the cache expired re-writes the whole conversation at cache-write price. Biggest: ${(big.tokens / 1000).toFixed(0)}k tokens after ${h ? `${h}h ${m}m` : `${m}m`} away in ${label(big.session)}`, fix: 'back from a break, /clear and start fresh, or /compact first so less gets re-written' })
}

// 3. Subagents that only read, on a model bigger than Haiku, grouped by agent type.
const agents = new Map()
for (const c of all.filter((c) => c.sidechain)) { const k = c.agent || c.session + ':side'; agents.set(k, [...(agents.get(k) || []), c]) }
const readOnly = new Map()
for (const [, cs] of agents) {
  const r = rate(cs[0].model)
  if (!r || r === HAIKU) continue
  const tools = cs.flatMap((c) => c.tools)
  if (!tools.length || !tools.every((t) => READ_ONLY.has(t.name) || (t.name === 'Bash' && READ_ONLY_BASH.test(t.cmd || '')))) continue
  const type = cs[0].agentType || 'subagent'
  const g = readOnly.get(type) || { runs: 0, spent: 0, asHaiku: 0, model: r.name, tools: new Set() }
  g.runs++; g.spent += cs.reduce((s, c) => s + c.cost, 0); g.asHaiku += cs.reduce((s, c) => s + cost(c.usage, HAIKU), 0)
  for (const t of tools) g.tools.add(t.name)
  readOnly.set(type, g)
}
for (const [type, g] of readOnly) leaks.push({ kind: 'subagent', save: g.spent - g.asHaiku, title: `Read-only ${type} runs on ${g.model}`, detail: `${g.runs} run${g.runs === 1 ? '' : 's'} that only read (${[...g.tools].join(', ')})`, fix: `run it on Haiku: model: haiku in the agent's frontmatter · same tokens: $${g.spent.toFixed(2)} → $${g.asHaiku.toFixed(2)}`, apply: `agent ${type} model=haiku` })

// 3b. Subagents whose 5-minute cache expired while they waited for their next step. A 1-hour cache
// (subagentPromptCacheTtl) turns those rebuilds into reads, but every write costs more, so it's a
// leak only when the replay comes out cheaper: an orchestrator whose subagents idle between steps.
const subCache = { rebuilds: 0, actual: 0, with1h: 0 }
for (const [, cs] of agents) {
  let prev = null
  for (const c of cs) {
    const r = rate(c.model)
    if (!r) continue
    const u = c.usage, { w5, w1h } = writes(u), written = w5 + w1h
    const base = ((u.input_tokens || 0) * r.in + (u.cache_read_input_tokens || 0) * r.read + (u.output_tokens || 0) * r.out) / 1e6
    const gap = prev ? (c.ts - prev.ts) / 1000 : 0
    const held = prev && gap > 300 && gap < 3600 && w5 >= written / 2 ? Math.min(written, context(prev.usage)) : 0
    if (held >= 5000) subCache.rebuilds++
    subCache.actual += c.cost
    subCache.with1h += base + (held >= 5000 ? held * r.read + (written - held) * r.w1h : written * r.w1h) / 1e6
    prev = c
  }
}
if (subCache.actual - subCache.with1h >= 0.5 && settings.subagentPromptCacheTtl !== '1h')
  leaks.push({ kind: 'subagent-cache', save: subCache.actual - subCache.with1h, title: `Subagent cache expired ${subCache.rebuilds} times between steps`, detail: `Subagents get a 5-minute cache; idle longer and the next step re-writes their whole context. A 1-hour cache costs more per write, and still comes out ${usd(subCache.actual - subCache.with1h)} cheaper on your week ($${subCache.actual.toFixed(2)} → $${subCache.with1h.toFixed(2)}).`, fix: '"subagentPromptCacheTtl": "1h" in ~/.claude/settings.json (ignored while a subscription is in overage)', apply: 'setting subagentPromptCacheTtl=1h' })

const outputs = []
// 4. One huge tool output that every later turn pays to re-read.
for (const t of results.filter((t) => !t.sidechain)) {
  const later = (bySession.get(t.session) || []).filter((c) => c.ts > t.ts)
  if (!later.length) continue
  const carried = later.reduce((s, c) => s + t.tokens * (rate(c.model)?.read || 0) / 1e6, 0) + t.tokens * (rate(later[0].model)?.w5 || 0) / 1e6
  outputs.push({ ...t, carried, turns: later.length, what: toolNames.get(t.id) })
}
if (outputs.length) {
  outputs.sort((a, b) => b.carried - a.carried)
  const big = outputs[0]
  leaks.push({ kind: 'output', save: outputs.reduce((s, o) => s + o.carried, 0), title: `${outputs.length} huge tool output${outputs.length === 1 ? '' : 's'} carried in context`, detail: `Each later turn paid to re-read them. Biggest: ~${(big.tokens / 1000).toFixed(0)}k-token ${big.what?.name || 'tool'} output${big.what?.file ? ` (${path.basename(String(big.what.file)).slice(0, 40)})` : ''}, carried ${big.turns} turns`, fix: 'grep or read a range instead, or hand it to a subagent so only the answer comes back', apply: 'CLAUDE.md "Read logs and big files with grep, tail or a line range, not whole; hand a big read to a subagent so only the answer comes back."' })
}

leaks.sort((a, b) => b.save - a.save)
if (args.includes('--json')) {
  const per = {}
  for (const c of all) per[c.session] = (per[c.session] || 0) + c.cost
  console.log(JSON.stringify({ total, pastCompact, compactAt: COMPACT_AT, autoCompactWindow: settings.autoCompactWindow ?? null, subagentCache: subCache, calls: all.length, perSession: per, leaks }, null, 2))
  process.exit(0)
}
const C = PLAIN ? { b: '', d: '', r: '', y: '', g: '', x: '' } : { b: '\x1b[1m', d: '\x1b[2m', r: '\x1b[31m', y: '\x1b[33m', g: '\x1b[32m', x: '\x1b[0m' }
const pct = (n) => total ? Math.round(n / total * 100) : 0
const wrap = (s, ind) => { const w = WIDTH - ind, out = []; let line = ''; for (const word of s.split(' ')) { if ((line + ' ' + word).trim().length > w) { out.push(line); line = word } else line = (line + ' ' + word).trim() } out.push(line); return out.map((l) => ' '.repeat(ind) + l).join('\n') }
const sessions = new Set(all.map((c) => c.session)).size
const leaked = leaks.reduce((s, l) => s + l.save, 0)

const ANIM = !PLAIN && !args.includes('--no-anim')
const nap = (ms) => ANIM ? new Promise((r) => setTimeout(r, ms)) : null
if (ANIM) { for (let i = 1; i <= all.length; i += Math.ceil(all.length / 60)) { process.stdout.write(`\r${C.d}reading transcripts… ${i}/${all.length} API calls${C.x}`); await nap(15) } process.stdout.write('\r\x1b[K') }
console.log(`${C.b}/leaks${C.x} ${C.d}· last ${DAYS} days · ${sessions} sessions · ${all.length} API calls${C.x}`)
console.log(`${C.b}${usd(total)}${C.x} API-equivalent spent · ${C.r}${C.b}${usd(leaked)} avoidable (${pct(leaked)}%)${C.x}`)
console.log(`${C.y}${pct(pastCompact)}% went to turns past ${COMPACT_AT / 1000}k context${C.x}${settings.autoCompactWindow ? ` ${C.d}(autoCompactWindow is ${settings.autoCompactWindow})${C.x}` : ''}\n`)
if (!leaks.length) console.log(`${C.g}No leaks found.${C.x}`)
const top = leaks[0]?.save || 1
for (const [i, l] of leaks.slice(0, +opt('--top', 6)).entries()) {
  await nap(900)
  const bar = '█'.repeat(Math.max(1, Math.round(l.save / top * 16)))
  console.log(`${C.b}${i + 1}. ${C.r}${usd(l.save).padStart(6)}${C.x}  ${C.r}${bar}${C.x}`)
  console.log(wrap(`${C.b}${l.title}${C.x}`, 3))
  console.log(`${C.d}${wrap(l.detail, 3)}${C.x}`)
  console.log(`${C.g}${wrap('→ ' + l.fix, 3)}${C.x}`)
  if (PLAIN && l.apply) console.log(`   apply: ${l.apply}`)
  console.log('')
}
console.log(`${C.d}Prices: platform.claude.com/docs/en/about-claude/pricing.\nSavings are estimates and overlap a little: compacting also shrinks the rebuilds.\nThe compact saving replays each session as if it compacted at ${COMPACT_AT / 1000}k.\nTool outputs estimated at 4 characters a token.${C.x}`)
