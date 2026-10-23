#!/usr/bin/env node
// ci-light: your repo's default-branch CI as a light, e.g. "main ● red 1d 12h · 11 pushes".
// As a Claude Code statusline command it reads the statusline JSON on stdin; with --json it prints the
// result for the plugin. It finds the GitHub origin of the directory and asks GitHub Actions (gh if signed
// in, else the public API, with GITHUB_TOKEN if set). Results are cached so it stays fast and polite.
//   --json            print { repo, branch, state, since, pushes, more, running, workflows, text, line }
//   --cwd <dir>       the repo directory (default: the statusline's, else the current one)
//   --workflow <a,b>  only count these workflows, by name or file (or CI_LIGHT_WORKFLOW)
//   --fixture <file>  read { default_branch, workflow_runs } from a file instead of GitHub
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const RED_STATES = new Set(['failure', 'timed_out', 'startup_failure', 'action_required'])
const C = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', x: '\x1b[0m' }

export const since = (t, now = Date.now()) => {
  let s = Math.max(0, Math.floor((now - new Date(t).getTime()) / 1000))
  const d = Math.floor(s / 86400); s %= 86400
  const h = Math.floor(s / 3600); s %= 3600
  const min = Math.floor(s / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${String(min).padStart(2, '0')}m` : `${min}m`
}

// "ci, Tests" or "ci.yml" → does this run belong to one of them?
export const workflowFilter = (spec) => {
  const want = String(spec || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (!want.length) return () => true
  return (r) => want.some((w) => (r.name || '').toLowerCase() === w || path.basename(r.path || '').toLowerCase() === w)
}

// The light, from a default branch's push runs (newest first, as GitHub lists them).
export function light(branch, allRuns, { workflow = '', now = Date.now() } = {}) {
  const runs = allRuns.filter(workflowFilter(workflow))
  const base = { branch, workflows: workflow || null, since: null, pushes: 0, more: false, running: false }
  if (!runs.length) return { ...base, state: 'none' }
  // One push = one head SHA; it's red if any of its workflow runs failed, green when all finished clean.
  const shas = []
  for (const r of runs) {
    let s = shas.find((x) => x.sha === r.head_sha)
    if (!s) shas.push((s = { sha: r.head_sha, runs: [] }))
    s.runs.push(r)
  }
  // A push whose runs were all cancelled or skipped says nothing about main's health: it neither ends a red streak nor counts as red.
  for (const s of shas) {
    if (s.runs.some((r) => RED_STATES.has(r.conclusion))) s.state = 'red'
    else if (s.runs.some((r) => r.status !== 'completed')) s.state = 'running'
    else if (s.runs.some((r) => r.conclusion === 'success')) s.state = 'green'
    else s.state = 'unknown'
  }
  const running = shas[0].state === 'running'
  const latest = shas.find((s) => s.state === 'red' || s.state === 'green')
  if (!latest) return { ...base, running, state: running ? 'running' : 'unknown' }
  if (latest.state === 'green') return { ...base, running, state: 'green' }
  // Red: walk back to the first red push after the last green one.
  let first = shas.indexOf(latest), complete = false
  for (let i = first + 1; i < shas.length; i++) {
    if (shas[i].state === 'green') { complete = true; break }
    if (shas[i].state === 'red') first = i
  }
  const redAt = shas[first].runs.filter((r) => RED_STATES.has(r.conclusion)).map((r) => r.updated_at).sort()[0]
  return { ...base, running, state: 'red', since: since(redAt, now), pushes: first, more: !complete }
}

// The words, with colors when `color` is set.
export function render(l, color = true) {
  const c = color ? C : { red: '', green: '', yellow: '', dim: '', x: '' }
  const spin = l.running ? ` ${c.yellow}◐${c.x}` : ''
  if (l.state === 'error') return `${c.dim}ci ? (${l.error})${c.x}`
  if (l.state === 'none') return `${c.dim}${l.branch} ○ no CI${l.workflows ? ` named ${l.workflows}` : ''}${c.x}`
  if (l.state === 'unknown') return `${c.dim}${l.branch} ○ no result${c.x}`
  if (l.state === 'running') return `${l.branch} ${c.yellow}◐ running${c.x}`
  if (l.state === 'green') return `${l.branch} ${c.green}● green${c.x}${spin}`
  const more = l.more ? '+' : ''
  const tail = l.pushes ? ` · ${l.pushes}${more} push${l.pushes === 1 && !more ? '' : 'es'}` : ''
  return `${l.branch} ${c.red}● red ${l.since}${more}${c.x}${tail}${spin}`
}

async function main() {
  const argv = process.argv.slice(2)
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  const json = argv.includes('--json')
  const workflow = arg('--workflow') ?? process.env.CI_LIGHT_WORKFLOW ?? ''
  const TTL = +(process.env.CI_LIGHT_TTL || 120) * 1000
  let input = {}
  if (!json && !process.stdin.isTTY) { try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}') } catch {} }
  const cwd = arg('--cwd') || input.workspace?.current_dir || input.cwd || process.cwd()
  const sh = (cmd, args) => {
    try { return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() } catch { return '' }
  }
  const emit = (l) => {
    const line = render(l, true)
    process.stdout.write(json ? JSON.stringify({ ...l, text: render(l, false), line }) + '\n' : line)
  }

  const fixture = arg('--fixture')
  if (fixture) {
    const f = JSON.parse(fs.readFileSync(fixture, 'utf8'))
    return emit({ repo: f.repo ?? null, ...light(f.default_branch || 'main', f.workflow_runs ?? [], { workflow, now: f.now ? Date.parse(f.now) : Date.now() }) })
  }

  const m = sh('git', ['remote', 'get-url', 'origin']).match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
  if (!m) { if (json) process.stdout.write('null\n'); return } // not a GitHub repo: show nothing
  const repo = `${m[1]}/${m[2]}`

  const cacheDir = path.join(os.homedir(), '.cache', 'ci-light')
  const cacheFile = path.join(cacheDir, `${repo.replace('/', '__')}${workflow ? '__' + workflow.replace(/[^\w.,-]/g, '_') : ''}.json`)
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    if (c.v === 2 && Date.now() - c.at < c.ttl) return emit(c.light)
  } catch {}
  const save = (l, ttl = TTL) => {
    try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify({ v: 2, at: Date.now(), ttl, light: l })) } catch {}
    emit(l)
  }

  const useGh = !!sh('gh', ['auth', 'token'])
  const api = async (p) => {
    if (useGh) return JSON.parse(sh('gh', ['api', p]) || 'null')
    const headers = { 'User-Agent': 'ci-light', Accept: 'application/vnd.github+json' }
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
    const r = await fetch(`https://api.github.com/${p}`, { headers, signal: AbortSignal.timeout(5000) })
    if (!r.ok) throw new Error(`GitHub ${r.status}`)
    return r.json()
  }
  try {
    const info = await api(`repos/${repo}`)
    const branch = info?.default_branch || 'main'
    const data = await api(`repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&event=push&per_page=100`)
    const l = { repo, ...light(branch, data?.workflow_runs ?? [], { workflow }) }
    save(l, l.state === 'none' ? TTL * 5 : TTL)
  } catch (e) {
    save({ repo, branch: null, state: 'error', error: String(e.message).slice(0, 24) }, 30000)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main()
