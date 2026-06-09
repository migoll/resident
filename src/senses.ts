import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config, RepoCfg } from './config'

export interface Finding {
  sense: string
  repo: string // repo name ('' for repo-less alerts like uptime)
  kind: string
  title: string
  detail: string
  score: number
  hash: string
}

const h = (s: string) => 'f' + Bun.hash(s).toString(36)

async function run(cmd: string[], cwd?: string, timeout = 30_000): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', timeout, killSignal: 'SIGKILL' })
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    const code = await p.exited
    return { ok: code === 0, out: (out + (err ? '\n' + err : '')).trim() }
  } catch (e) {
    return { ok: false, out: String(e) }
  }
}

const DAY = 86_400_000

// ---------------------------------------------------------------- git
async function gitSense(repo: RepoCfg): Promise<Finding[]> {
  const out: Finding[] = []
  const f = (kind: string, title: string, detail: string, score: number, key = '') =>
    out.push({ sense: 'git', repo: repo.name, kind, title, detail, score, hash: h(`git|${repo.name}|${kind}|${key}`) })

  const status = await run(['git', 'status', '--porcelain'], repo.path)
  if (status.ok) {
    const n = status.out ? status.out.split('\n').length : 0
    if (n > 0) f('uncommitted', `${n} uncommitted change${n === 1 ? '' : 's'} sitting in the working tree`, status.out.split('\n').slice(0, 8).join('\n'), 15)
  }

  const refs = await run(['git', 'for-each-ref', 'refs/heads', '--format=%(refname:short)|%(committerdate:unix)'], repo.path)
  if (refs.ok && refs.out) {
    const stale = refs.out
      .split('\n')
      .map((l) => l.split('|'))
      .filter(([name, ts]) => name && !['main', 'master'].includes(name) && Date.now() - Number(ts) * 1000 > 21 * DAY)
      .map(([name]) => name)
    if (stale.length) f('stale-branches', `${stale.length} branch${stale.length === 1 ? '' : 'es'} untouched for 3+ weeks`, stale.slice(0, 10).join(', '), 20, 'v1')
  }

  const todos = await run(['git', 'grep', '-In', '-E', 'TODO|FIXME|HACK'], repo.path)
  if (todos.ok && todos.out) {
    const lines = todos.out.split('\n')
    f('todos', `${lines.length} TODO/FIXME marker${lines.length === 1 ? '' : 's'} in the code`, lines.slice(0, 6).join('\n'), 18, 'v1')
  }
  return out
}

// ---------------------------------------------------------------- deps
async function depsSense(repo: RepoCfg): Promise<Finding[]> {
  const out: Finding[] = []
  if (!existsSync(join(repo.path, 'package.json'))) return out

  const outdated = await run(['bun', 'outdated'], repo.path, 60_000)
  if (outdated.ok && outdated.out) {
    // count table rows that contain two semver-ish versions
    const rows = outdated.out.split('\n').filter((l) => /\d+\.\d+\.\d+.*\d+\.\d+\.\d+/.test(l))
    if (rows.length > 0)
      out.push({
        sense: 'deps', repo: repo.name, kind: 'outdated',
        title: `${rows.length} dependenc${rows.length === 1 ? 'y is' : 'ies are'} behind`,
        detail: rows.slice(0, 12).join('\n'), score: rows.length > 10 ? 40 : 28,
        hash: h(`deps|${repo.name}|outdated`),
      })
  }

  const audit = await run(['bun', 'audit'], repo.path, 60_000)
  if (audit.out) {
    const grab = (level: string) => {
      const m = audit.out.match(new RegExp(`(\\d+)\\s+${level}`, 'i'))
      return m ? Number(m[1]) : 0
    }
    const critical = grab('critical'), high = grab('high'), moderate = grab('moderate')
    if (critical || high || moderate) {
      const score = critical ? 85 : high ? 70 : 45
      out.push({
        sense: 'deps', repo: repo.name, kind: 'vulnerabilities',
        title: `Vulnerable dependencies: ${[critical && `${critical} critical`, high && `${high} high`, moderate && `${moderate} moderate`].filter(Boolean).join(', ')}`,
        detail: audit.out.split('\n').slice(0, 25).join('\n'), score,
        hash: h(`deps|${repo.name}|vuln|${critical}|${high}`),
      })
    }
  }
  return out
}

// ---------------------------------------------------------------- checks
async function checksSense(repo: RepoCfg): Promise<Finding[]> {
  if (repo.checks === false) return []
  try {
    const pkg = JSON.parse(readFileSync(join(repo.path, 'package.json'), 'utf8'))
    const script = pkg.scripts?.typecheck ? 'typecheck' : pkg.scripts?.['type-check'] ? 'type-check' : null
    if (!script) return []
    const res = await run(['bun', 'run', script], repo.path, 150_000)
    if (!res.ok)
      return [{
        sense: 'checks', repo: repo.name, kind: 'typecheck',
        title: `Typecheck is failing (\`bun run ${script}\`)`,
        detail: res.out.split('\n').slice(-30).join('\n'), score: 80,
        hash: h(`checks|${repo.name}|typecheck`),
      }]
  } catch {}
  return []
}

// ---------------------------------------------------------------- uptime
async function uptimeSense(urls: string[]): Promise<Finding[]> {
  const checks = urls.map(async (url): Promise<Finding | null> => {
    const started = performance.now()
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'resident-uptime/0.1' } })
      const ms = Math.round(performance.now() - started)
      if (res.status >= 500) return { sense: 'uptime', repo: '', kind: 'down', title: `${host(url)} is returning ${res.status}`, detail: `${url} → HTTP ${res.status} in ${ms}ms`, score: 95, hash: h(`up|${url}|down`) }
      if (res.status >= 400) return { sense: 'uptime', repo: '', kind: 'http-error', title: `${host(url)} is returning ${res.status}`, detail: `${url} → HTTP ${res.status} in ${ms}ms`, score: 70, hash: h(`up|${url}|4xx`) }
      if (ms > 3000) return { sense: 'uptime', repo: '', kind: 'slow', title: `${host(url)} is slow (${(ms / 1000).toFixed(1)}s)`, detail: `${url} → HTTP ${res.status} in ${ms}ms`, score: 55, hash: h(`up|${url}|slow`) }
      return null
    } catch (e) {
      return { sense: 'uptime', repo: '', kind: 'down', title: `${host(url)} is unreachable`, detail: `${url} → ${String(e).slice(0, 200)}`, score: 95, hash: h(`up|${url}|unreachable`) }
    }
  })
  return (await Promise.all(checks)).filter(Boolean) as Finding[]
}
const host = (u: string) => { try { return new URL(u).host } catch { return u } }

// ---------------------------------------------------------------- github
let ghOk: boolean | null = null
async function githubSense(repo: RepoCfg): Promise<Finding[]> {
  const out: Finding[] = []
  if (ghOk === null) ghOk = (await run(['gh', 'auth', 'status'], undefined, 10_000)).ok
  if (!ghOk) return out
  const remote = await run(['git', 'remote', 'get-url', 'origin'], repo.path)
  if (!remote.ok || !remote.out.includes('github.com')) return out

  const prs = await run(['gh', 'pr', 'list', '--json', 'number,title,mergeable,reviewDecision,statusCheckRollup', '--limit', '15'], repo.path, 30_000)
  if (prs.ok) {
    try {
      for (const pr of JSON.parse(prs.out)) {
        const rollup = JSON.stringify(pr.statusCheckRollup ?? [])
        if (rollup.includes('"FAILURE"') || rollup.includes('"ERROR"'))
          out.push({ sense: 'github', repo: repo.name, kind: 'pr-failing', title: `PR #${pr.number} has failing checks — “${pr.title}”`, detail: `gh pr view ${pr.number}`, score: 65, hash: h(`gh|${repo.name}|prfail|${pr.number}`) })
        if (pr.mergeable === 'CONFLICTING')
          out.push({ sense: 'github', repo: repo.name, kind: 'pr-conflict', title: `PR #${pr.number} has merge conflicts — “${pr.title}”`, detail: `gh pr view ${pr.number}`, score: 60, hash: h(`gh|${repo.name}|prconf|${pr.number}`) })
        if (pr.reviewDecision === 'APPROVED')
          out.push({ sense: 'github', repo: repo.name, kind: 'pr-approved', title: `PR #${pr.number} is approved but not merged — “${pr.title}”`, detail: `gh pr view ${pr.number}`, score: 55, hash: h(`gh|${repo.name}|prok|${pr.number}`) })
      }
    } catch {}
  }

  const issues = await run(['gh', 'issue', 'list', '--json', 'number,title,createdAt', '--limit', '10'], repo.path, 30_000)
  if (issues.ok) {
    try {
      for (const is of JSON.parse(issues.out)) {
        if (Date.now() - new Date(is.createdAt).getTime() < 2 * DAY)
          out.push({ sense: 'github', repo: repo.name, kind: 'new-issue', title: `New issue #${is.number}: “${is.title}”`, detail: `gh issue view ${is.number}`, score: 50, hash: h(`gh|${repo.name}|issue|${is.number}`) })
      }
    } catch {}
  }
  return out
}

// ---------------------------------------------------------------- all
export async function runSenses(cfg: Config, log: (s: string) => void = () => {}): Promise<Finding[]> {
  const perRepo = cfg.repos.map(async (repo) => {
    const found: Finding[] = []
    for (const sense of [gitSense, depsSense, checksSense, githubSense]) {
      try { found.push(...(await sense(repo))) } catch {}
    }
    log(`  scanned ${repo.name} → ${found.length} finding(s)`)
    return found
  })
  const uptime = uptimeSense(cfg.urls)
  const all = (await Promise.all([...perRepo, uptime])).flat()
  return all
}
