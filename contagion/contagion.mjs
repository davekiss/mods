#!/usr/bin/env node
// contagion: for every escape hatch an agent commit added (as any, @ts-ignore, eslint-disable, a swallowed
// catch, a "workaround" comment), find the existing line it most likely copied, and rank the patient zeros.
//   node contagion.mjs [--days 180] [--json] [--cwd .] [--fixture file.json]
//   node contagion.mjs fix [--top 5]     add a line to CLAUDE.md naming the top patient zeros
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const argv = process.argv.slice(2)
const flag = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d)
const CWD = flag('cwd', process.cwd())
const DAYS = Number(flag('days', 180))
const AGENT = /^co-authored-by:.*\b(claude|anthropic|codex|cursor|copilot|devin|opencode|aider)\b/im

export const KINDS = {
  'as any': { re: /\bas any\b/, grep: '\\bas any\\b' },
  '@ts-ignore': { re: /@ts-(ignore|expect-error|nocheck)/, grep: '@ts-(ignore|expect-error|nocheck)' },
  'eslint-disable': { re: /eslint-disable/, grep: 'eslint-disable' },
  'swallowed catch': { re: /catch\s*(\([^)]*\))?\s*\{\s*\}|\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*\{\s*\}\s*\)/, grep: 'catch *(\\([^)]*\\))? *\\{ *\\}|\\.catch\\( *\\( *[a-zA-Z_]* *\\) *=> *\\{ *\\} *\\)' },
  workaround: { re: /\/\/.*\b(hack|workaround|temporary fix)\b/i, grep: '//.*(hack|workaround|temporary fix)' },
}
export const kindOf = (line) => Object.keys(KINDS).find((k) => KINDS[k].re.test(line)) ?? null

const SRC = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mts', '*.cts']
const git = (args, opts = {}) => execFileSync('git', ['-C', CWD, ...args], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts })

// Token overlap of two lines, ignoring whitespace and string contents.
export const tokens = (s) => new Set(s.replace(/(['"`]).*?\1/g, 's').match(/[A-Za-z_$][\w$]*|[^\s\w]/g) ?? [])
export function similarity(a, b) {
  const x = tokens(a), y = tokens(b)
  let both = 0
  for (const t of x) if (y.has(t)) both++
  return both / Math.max(1, x.size + y.size - both)
}

// The likeliest source of an added line among the lines that already existed: same kind, most similar,
// nearer files first. Below `min` it's "no source", never forced.
export function bestSource(added, candidates, min = 0.45) {
  let best = null
  for (const c of candidates) {
    if (c.file === added.file && c.line === added.line) continue
    const near = c.file === added.file ? 0.15 : dirname(c.file) === dirname(added.file) ? 0.08 : 0
    const score = similarity(added.text, c.text) + near
    if (!best || score > best.score) best = { ...c, score }
  }
  return best && best.score >= min ? { ...best, score: Math.min(1, Number(best.score.toFixed(2))) } : null
}

function agentCommits() {
  const out = git(['log', `--since=${DAYS} days ago`, '--no-merges', '--format=%H%x00%an%x00%aI%x00%B%x01'])
  return out.split('\x01').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [sha, author, at, body] = r.split('\x00')
    return { sha, author, at, body }
  }).filter((c) => AGENT.test(c.body))
}

function addedLines(sha) {
  const out = git(['show', '--unified=0', '--format=', '--no-color', sha, '--', ...SRC])
  const lines = []
  let file = null, n = 0
  for (const l of out.split('\n')) {
    if (l.startsWith('+++ ')) file = l.slice(6)
    else if (l.startsWith('@@')) n = Number(l.match(/\+(\d+)/)?.[1] ?? 0)
    else if (l.startsWith('+') && file) {
      const text = l.slice(1).trim()
      const kind = kindOf(text)
      if (kind) lines.push({ sha, file, line: n, text, kind })
      n++
    }
  }
  return lines
}

function existing(parent, kind) {
  let out = ''
  try { out = git(['grep', '-n', '-I', '-E', KINDS[kind].grep, parent, '--', ...SRC]) } catch { return [] }
  return out.split('\n').filter(Boolean).map((l) => {
    const m = l.match(/^[^:]+:([^:]+):(\d+):(.*)$/)
    return m && { file: m[1], line: Number(m[2]), text: m[3].trim() }
  }).filter((c) => c && KINDS[kind].re.test(c.text))
}

export function scan() {
  const commits = agentCommits()
  const added = []
  const cache = new Map()
  for (const c of commits) {
    let parent
    try { parent = git(['rev-parse', `${c.sha}^`]).trim() } catch { continue } // the shallow boundary has no parent
    for (const a of addedLines(c.sha)) {
      const key = `${parent}:${a.kind}`
      if (!cache.has(key)) cache.set(key, existing(parent, a.kind))
      added.push({ ...a, at: c.at, source: bestSource(a, cache.get(key)) })
    }
  }
  return summarize({ repo: repoName(), days: DAYS, agentCommits: commits.length, added })
}

export function summarize(r) {
  const zeros = new Map()
  for (const a of r.added) {
    if (!a.source) continue
    const k = `${a.source.file}:${a.source.line}`
    const z = zeros.get(k) ?? { file: a.source.file, line: a.source.line, text: a.source.text, kind: a.kind, copies: [] }
    z.copies.push({ file: a.file, line: a.line, sha: a.sha.slice(0, 9), score: a.source.score })
    zeros.set(k, z)
  }
  const ranked = [...zeros.values()].sort((a, b) => b.copies.length - a.copies.length)
  const traced = r.added.filter((a) => a.source).length
  return { ...r, traced, untraced: r.added.length - traced, zeros: ranked }
}

function repoName() {
  try { return git(['remote', 'get-url', 'origin']).trim().replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '') } catch { return CWD }
}

export const fixLine = (zeros) =>
  `- Don't copy these escape hatches; they're known debt that agents keep cloning: ${zeros.map((z) => `\`${z.text.slice(0, 60)}\` (${z.file}:${z.line})`).join('; ')}. Fix the type or handle the error instead.`

export function fix(r, top = 5, path = join(CWD, 'CLAUDE.md')) {
  const zeros = r.zeros.filter((z) => z.copies.length > 1).slice(0, top)
  if (!zeros.length) return { added: false }
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const line = fixLine(zeros)
  if (!text.includes(line)) writeFileSync(path, `${text.replace(/\n*$/, '')}${text.trim() ? '\n\n' : ''}${line}\n`)
  return { added: true, path, zeros: zeros.length }
}

export function render(r) {
  const out = [`contagion · ${r.repo} · ${r.agentCommits} agent commits, ${r.days} days`, `${r.added.length} escape hatches added · ${r.traced} traced to an older line · ${r.untraced} no source`, '']
  for (const z of r.zeros.slice(0, 8)) out.push(`${String(z.copies.length).padStart(3)}×  ${z.file}:${z.line}  ${z.text.slice(0, 70)}`)
  return out.join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = argv.includes('--fixture') ? summarize(JSON.parse(readFileSync(flag('fixture'), 'utf8'))) : scan()
  if (argv[0] === 'fix') console.log(JSON.stringify(fix(r, Number(flag('top', 5)))))
  else console.log(argv.includes('--json') ? JSON.stringify(r) : render(r))
}
