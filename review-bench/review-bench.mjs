#!/usr/bin/env node
// review-bench: does another review round find real bugs or just new noise, on your own repo?
// Plants N known bugs in a throwaway git worktree, runs review rounds with `claude -p`, and scores each round:
// planted bugs newly caught vs other new findings. The round after the last new catch is where to stop.
//   node review-bench.mjs plant [--n 5] [--seed 1] [--cwd .]      make the worktree and plant the bugs
//   node review-bench.mjs round <k> [--model sonnet]                run review round k and score it
//   node review-bench.mjs report [--json]                           the scores so far
//   node review-bench.mjs clean                                     remove the worktree and its branch
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative, basename } from 'node:path'
import { tmpdir } from 'node:os'

const argv = process.argv.slice(2)
const flag = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d)
const CWD = flag('cwd', process.cwd())
const git = (args, cwd = CWD) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

// One-token bugs of five real kinds. Each finds candidate lines and returns the edited line (or null to delete it).
export const KINDS = {
  'off-by-one': { find: (l) => /\(\s*\w+\s*-\s*1\s*\)\s*\*|\b\w+(\.length)?\s*<\s*\w+(\.length)?\s*;|\.slice\(\s*0\s*,/.test(l), edit: (l) => l.replace(/\(\s*(\w+)\s*-\s*1\s*\)/, '$1').replace(/(\w)\s*<\s*(\w)/, '$1 <= $2').replace(/\.slice\(\s*0\s*,/, '.slice(1,') },
  'missing await': { find: (l) => /\bawait\s+\w/.test(l) && !/return await|for await/.test(l), edit: (l) => l.replace(/\bawait\s+/, '') },
  'wrong auth check': { find: (l) => /(===|!==)/.test(l) && /(role|right|auth|permission|userId|user\.id|token|owner)/i.test(l), edit: (l) => (l.includes('!==') ? l.replace('!==', '===') : l.replace('===', '!==')) },
  'unhandled null': { find: (l) => /^\s*if \(!\w+(\.\w+)?\)\s*\{?\s*(throw|return)?/.test(l), edit: () => null },
  'swapped args': { find: (l) => { const m = /\b\w+\((\w+), (\w+)\)/.exec(l); return !!m && m[1] !== m[2] && !/\d/.test(m[1] + m[2]) }, edit: (l) => l.replace(/\b(\w+)\((\w+), (\w+)\)/, '$1($3, $2)') },
}

const rand = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
const statePath = (root) => join(root, '.review-bench.json')
const load = (root) => JSON.parse(readFileSync(statePath(root), 'utf8'))
const save = (root, s) => writeFileSync(statePath(root), JSON.stringify(s, null, 1))
const worktreeOf = (cwd) => join(tmpdir(), `review-bench-${basename(git(['rev-parse', '--show-toplevel'], cwd))}`)

export function candidates(files, read) {
  const out = []
  for (const f of files) {
    const lines = read(f).split('\n')
    lines.forEach((l, i) => {
      for (const [kind, k] of Object.entries(KINDS)) if (!/^\s*(\/\/|\*)/.test(l) && k.find(l)) out.push({ kind, file: f, line: i + 1, before: l })
    })
  }
  return out
}

// One bug per kind, in different files where possible, chosen by the seed.
export function choose(cands, n, seed) {
  const r = rand(Number(seed))
  const kinds = Object.keys(KINDS)
  const picks = [], used = new Set()
  for (let i = 0; picks.length < n && i < n * 4; i++) {
    const kind = kinds[i % kinds.length]
    const pool = cands.filter((c) => c.kind === kind && !picks.some((p) => p.file === c.file && Math.abs(p.line - c.line) < 8))
    const fresh = pool.filter((c) => !used.has(c.file))
    const from = fresh.length ? fresh : pool
    if (!from.length || picks.some((p) => p.kind === kind && picks.length < kinds.length)) continue
    const c = from[Math.floor(r() * from.length)]
    picks.push(c); used.add(c.file)
  }
  return picks
}

function plant() {
  const root = git(['rev-parse', '--show-toplevel'])
  const wt = worktreeOf(root)
  if (existsSync(wt)) clean(root)
  const branch = `review-bench/${Date.now()}`
  git(['worktree', 'add', '-q', '-b', branch, wt, 'HEAD'], root)
  const files = git(['ls-files', '--', '*.js', '*.ts', '*.mjs', '*.tsx', '*.jsx'], wt).split('\n')
    .filter((f) => f && !/(^|\/)(test|tests|__tests__|node_modules|dist|build|vendor)\/|\.(test|spec|d)\.|config/.test(f))
  const read = (f) => readFileSync(join(wt, f), 'utf8')
  const plants = choose(candidates(files, read), Number(flag('n', 5)), flag('seed', 1))
  // edit bottom-up per file so line numbers above stay right
  for (const p of [...plants].sort((a, b) => b.line - a.line)) {
    const lines = read(p.file).split('\n')
    const after = KINDS[p.kind].edit(p.before)
    if (after === null) {
      // drop the guard and its one-statement body
      const body = /\{\s*$/.test(p.before) ? (lines[p.line].trim().startsWith('}') ? 1 : /^\s*\}/.test(lines[p.line + 1] ?? '') ? 2 : 0) : 0
      lines.splice(p.line - 1, 1 + body)
      p.after = '(guard removed)'
    } else {
      lines[p.line - 1] = after
      p.after = after
    }
    writeFileSync(join(wt, p.file), lines.join('\n'))
  }
  plants.forEach((p, i) => (p.id = i + 1))
  git(['add', '-A'], wt)
  git(['-c', 'user.name=review-bench', '-c', 'user.email=review-bench@localhost', 'commit', '-q', '-m', 'review-bench: planted bugs'], wt)
  const scope = [...new Set(plants.map((p) => p.file.split('/').slice(0, -1).join('/')))]
  const reviewFiles = files.filter((f) => scope.includes(f.split('/').slice(0, -1).join('/')))
  const s = { repo: root, worktree: wt, branch, seed: Number(flag('seed', 1)), plants, reviewFiles, rounds: [] }
  save(wt, s)
  return s
}

export const PROMPT = (files, earlier) => `Review this code for bugs. Read these files: ${files.join(', ')}.
Report only real defects (wrong logic, security, crashes, data loss), not style.${earlier.length ? `
Earlier review rounds already reported the issues below. Don't repeat them; find what they missed.
${earlier.map((f) => `- ${f.file}:${f.line} ${f.issue}`).join('\n')}` : ''}
End your reply with one JSON array and nothing after it: [{"file": "path/from/repo/root", "line": 12, "issue": "one sentence"}]`

export function parseFindings(text) {
  const m = text.match(/\[\s*(\{[\s\S]*\})?\s*\]\s*$/) ?? text.match(/\[\s*\{[\s\S]*\}\s*\]/)
  if (!m) return []
  try { return JSON.parse(m[0]).filter((f) => f && f.file && Number.isFinite(Number(f.line))).map((f) => ({ file: String(f.file).replace(/^\.?\//, ''), line: Number(f.line), issue: String(f.issue ?? '') })) } catch { return [] }
}

// A finding catches a plant when it names the same file and a line within 3 of it. Everything else is "other".
export const matches = (f, p) => (f.file === p.file || f.file.endsWith(`/${p.file}`)) && Math.abs(f.line - p.line) <= 3

export function score(s) {
  const caught = new Set()
  const seen = []
  return s.rounds.map((r) => {
    const fresh = r.findings.filter((f) => !seen.some((e) => e.file === f.file && Math.abs(e.line - f.line) <= 2))
    seen.push(...fresh)
    const hits = s.plants.filter((p) => r.findings.some((f) => matches(f, p)))
    const newHits = hits.filter((p) => !caught.has(p.id))
    newHits.forEach((p) => caught.add(p.id))
    const other = fresh.filter((f) => !s.plants.some((p) => matches(f, p)))
    return { round: r.k, newCaught: newHits.map((p) => p.id), caughtSoFar: caught.size, newOther: other.length, costUsd: r.costUsd, sec: r.sec }
  })
}

export function verdict(s, sc = score(s)) {
  if (!sc.length) return null
  let last = 0
  for (const r of sc) if (r.newCaught.length) last = r.round
  if (!last) return `no round caught a planted bug`
  const after = sc.filter((r) => r.round > last)
  return after.length ? `stop after round ${last}: rounds ${last + 1}+ found 0 planted bugs and ${after.reduce((n, r) => n + r.newOther, 0)} other new findings` : `round ${last} still found planted bugs: one more round may pay`
}

function round(k) {
  const wt = worktreeOf(CWD)
  const s = load(wt)
  const earlier = s.rounds.flatMap((r) => r.findings)
  const t0 = Date.now()
  const args = ['-p', PROMPT(s.reviewFiles, earlier), '--output-format', 'json', '--allowedTools', 'Read,Grep,Glob', '--setting-sources', 'user', '--strict-mcp-config']
  const model = flag('model', process.env.REVIEW_BENCH_MODEL)
  if (model) args.push('--model', model)
  const ran = spawnSync('claude', args, { cwd: wt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 900_000 })
  let out = {}
  try { out = JSON.parse(ran.stdout) } catch { out = { result: ran.stdout, is_error: true } }
  const findings = parseFindings(out.result ?? '')
  s.rounds = s.rounds.filter((r) => r.k !== k).concat({ k, findings, costUsd: out.total_cost_usd ?? null, sec: Math.round((Date.now() - t0) / 1000), error: out.is_error ? String(out.result ?? ran.stderr).slice(0, 200) : null })
  save(wt, s)
  return s
}

export function report(s) {
  const sc = score(s)
  return { repo: s.repo, seed: s.seed, plants: s.plants.map(({ id, kind, file, line, after }) => ({ id, kind, file, line, after })), rounds: sc, findings: s.rounds, verdict: verdict(s, sc) }
}

export function render(r) {
  const out = [`review-bench · ${r.plants.length} planted bugs · ${relative(process.cwd(), r.repo) || '.'}`]
  for (const p of r.plants) out.push(`  #${p.id} ${p.kind.padEnd(16)} ${p.file}:${p.line}`)
  for (const x of r.rounds) out.push(`round ${x.round}: +${x.newCaught.length} planted (${x.caughtSoFar}/${r.plants.length})  +${x.newOther} other  ${x.costUsd != null ? `$${x.costUsd.toFixed(2)}` : ''}`)
  if (r.verdict) out.push(r.verdict)
  return out.join('\n')
}

function clean(root = git(['rev-parse', '--show-toplevel'])) {
  const wt = worktreeOf(root)
  let branch = null
  try { branch = load(wt).branch } catch {}
  try { git(['worktree', 'remove', '--force', wt], root) } catch {}
  if (branch) try { git(['branch', '-D', branch], root) } catch {}
  return { removed: wt }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = argv[0]
  const json = argv.includes('--json')
  const print = (x) => console.log(json || cmd === 'clean' ? JSON.stringify(x) : render(x))
  if (cmd === 'plant') print(report(plant()))
  else if (cmd === 'round') print(report(round(Number(argv[1]))))
  else if (cmd === 'report') print(report(load(worktreeOf(CWD))))
  else if (cmd === 'clean') print(clean())
  else console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 9).join('\n'))
}
