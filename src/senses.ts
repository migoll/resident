import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from './proc'
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

const DAY = 86_400_000

// ---------------------------------------------------------------- git
export async function gitSense(repo: RepoCfg): Promise<Finding[]> {
  const out: Finding[] = []
  // server mode: keep dedicated-machine clones fresh before judging them
  if (repo.pull) await run(['git', 'pull', '--ff-only', '--quiet'], repo.path, 60_000)
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
export async function depsSense(repo: RepoCfg): Promise<Finding[]> {
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

// ---------------------------------------------------------------- sentry
export interface SentryIssue {
  id: string
  title?: string
  culprit?: string
  permalink?: string
  shortId?: string
  level?: string
  count?: string
  userCount?: number
  firstSeen?: string
  lastSeen?: string
  substatus?: string
  isUnhandled?: boolean
  project?: { slug?: string; name?: string }
  metadata?: { type?: string; value?: string; filename?: string }
}

/** Judgment for one Sentry issue (pure; exported for tests). New errors burn hot, regressions
 *  matter, old ongoing noise stays visible but below the investigate threshold — Dependabot
 *  fatigue is the named enemy, and an error that's been firing for weeks is not news. */
export function scoreSentryIssue(is: SentryIssue, now = Date.now()): number {
  const first = is.firstSeen ? new Date(is.firstSeen).getTime() : 0
  const isNew = is.substatus === 'new' || (first > 0 && now - first < 2 * DAY)
  const regressed = is.substatus === 'regressed' || is.substatus === 'escalating'
  let score = isNew
    ? is.level === 'fatal' ? 92 : is.level === 'warning' ? 52 : 82
    : regressed ? 78
    : 50 // ongoing — shows up as "ignored, with reason", not as a fresh alarm
  if (is.isUnhandled) score += 4
  return Math.min(score, 99)
}

/** Poll Sentry for unresolved issues active in the last 24h (org-level, all projects).
 *  Exported so it can be exercised standalone. */
export async function sentrySense(cfg: Config): Promise<Finding[]> {
  const s = cfg.sentry
  if (!s?.org || !s?.token) return []
  const base = (s.url ?? 'https://sentry.io').replace(/\/$/, '')
  let res: Response
  try {
    res = await fetch(`${base}/api/0/organizations/${s.org}/issues/?query=is%3Aunresolved&statsPeriod=24h&sort=date&limit=25&project=-1`, {
      headers: { authorization: `Bearer ${s.token}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    return [] // transient network failure — skip this cycle, next one retries
  }
  // a rejected token is BLINDNESS, not quiet — surface it loudly (quiet and blind must never look the same)
  if (res.status === 401 || res.status === 403) {
    return [{
      sense: 'sentry', repo: '', kind: 'blind',
      title: 'Sentry sense is blind — the API token was rejected',
      detail: `GET ${base}/api/0/organizations/${s.org}/issues/ → HTTP ${res.status}.\n\nThe Personal Token is missing, revoked, or under-scoped. Re-create one (scopes: event:read, project:read, org:read) and update the "sentry" key in ~/.resident/config.json.`,
      score: 70, hash: h('sentry|auth'),
    }]
  }
  if (!res.ok) return []
  let issues: SentryIssue[]
  try { issues = await res.json() } catch { return [] }
  if (!Array.isArray(issues)) return []

  return issues.map((is): Finding => {
    const slug = is.project?.slug ?? ''
    // project slug ←→ watched repo name: when they match, the investigation gets the codebase
    const repo = cfg.repos.find((r) => r.name.toLowerCase() === slug.toLowerCase())?.name ?? ''
    const meta = is.metadata ?? {}
    return {
      sense: 'sentry', repo, kind: is.level || 'error',
      title: `[${slug || s.org}] ${is.title ?? meta.type ?? 'error'}`.slice(0, 140),
      detail: [
        `${is.shortId ?? is.id} · level=${is.level ?? '?'} · ${is.count ?? '?'} event(s) / ${is.userCount ?? 0} user(s)${is.isUnhandled ? ' · UNHANDLED' : ''}`,
        `first seen ${is.firstSeen ?? '?'} · last seen ${is.lastSeen ?? '?'}${is.substatus ? ` · ${is.substatus}` : ''}`,
        is.culprit ? `culprit: ${is.culprit}` : '',
        meta.filename ? `file: ${meta.filename}` : '',
        meta.type || meta.value ? `${meta.type ?? 'error'}: ${(meta.value ?? '').slice(0, 300)}` : '',
        is.permalink ?? '',
      ].filter(Boolean).join('\n'),
      score: scoreSentryIssue(is),
      hash: h(`sentry|${s.org}|${is.id}`),
    }
  })
}

// ---------------------------------------------------------------- github
let ghOk: boolean | null = null
export async function githubSense(repo: RepoCfg): Promise<Finding[]> {
  const out: Finding[] = []
  if (ghOk === null) ghOk = (await run(['gh', 'auth', 'status'], undefined, 10_000)).ok
  if (!ghOk) return out
  const remote = await run(['git', 'remote', 'get-url', 'origin'], repo.path)
  if (!remote.ok || !remote.out.includes('github.com')) return out

  const prs = await run(['gh', 'pr', 'list', '--json', 'number,title,mergeable,reviewDecision,statusCheckRollup', '--limit', '15'], repo.path, 30_000)
  if (prs.ok) {
    try {
      for (const pr of JSON.parse(prs.stdout)) {
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
      for (const is of JSON.parse(issues.stdout)) {
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
  const sentry = sentrySense(cfg).then((f) => {
    if (cfg.sentry) log(`  sentry (${cfg.sentry.org}) → ${f.length} finding(s)`)
    return f
  })
  const all = (await Promise.all([...perRepo, uptime, sentry])).flat()
  return all
}
