import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, CONFIG_PATH, HOME, type Config } from './config'
import { openStore } from './store'
import { run } from './proc'

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', RD = '\x1b[31m', R = '\x1b[0m'

export type Verdict = 'ok' | 'warn' | 'fail' | 'info'
export interface Check { name: string; verdict: Verdict; detail: string; hint?: string }

const ok = (name: string, detail: string): Check => ({ name, verdict: 'ok', detail })
const warn = (name: string, detail: string, hint?: string): Check => ({ name, verdict: 'warn', detail, hint })
const fail = (name: string, detail: string, hint?: string): Check => ({ name, verdict: 'fail', detail, hint })
const info = (name: string, detail: string, hint?: string): Check => ({ name, verdict: 'info', detail, hint })

const GLYPH: Record<Verdict, string> = { ok: `${G}✓${R}`, warn: `${Y}⚠${R}`, fail: `${RD}✗${R}`, info: `${D}−${R}` }

/** One aligned line per check; anything broken carries a dim remediation hint underneath. */
export function formatCheck(c: Check, pad: number): string {
  const line = `  ${GLYPH[c.verdict]} ${c.name.padEnd(pad)}${c.detail}`
  return c.hint ? `${line}\n${' '.repeat(pad + 4)}${D}↳ ${c.hint}${R}` : line
}

/** ✗ anywhere → 1. Warnings and the informational "−" never fail the doctor. */
export function exitCode(checks: Check[]): number {
  return checks.some((c) => c.verdict === 'fail') ? 1 : 0
}

// ---------------------------------------------------------------- the checks

async function checkGit(): Promise<Check> {
  if (!Bun.which('git')) return fail('git', 'not found', 'xcode-select --install (or brew install git)')
  const r = await run(['git', '--version'], undefined, 4_000)
  return r.ok ? ok('git', r.stdout.split('\n')[0]) : fail('git', '`git --version` failed', r.out.slice(0, 80))
}

async function checkClaude(): Promise<Check> {
  if (!Bun.which('claude')) return fail('claude', 'not found', 'install Claude Code and log in — investigations run on it')
  const r = await run(['claude', '--version'], undefined, 8_000)
  return r.ok ? ok('claude', r.stdout.split('\n')[0]) : fail('claude', '`claude --version` failed', 'reinstall Claude Code, then log in: claude')
}

async function checkGh(): Promise<Check> {
  if (!Bun.which('gh')) return fail('gh', 'not found', 'brew install gh && gh auth login')
  const r = await run(['gh', 'auth', 'status'], undefined, 8_000)
  return r.ok ? ok('gh', 'authenticated') : fail('gh', 'not logged in', 'gh auth login')
}

function checkTailscale(): Check {
  return Bun.which('tailscale') || existsSync('/Applications/Tailscale.app')
    ? ok('tailscale', 'found')
    : warn('tailscale', 'not found', 'optional — only needed to reach the inbox off-LAN (tailscale.com)')
}

function checkConfig(cfg: Config | null): Check {
  if (!existsSync(CONFIG_PATH)) return fail('config', 'missing', 'resident init')
  if (!cfg) return fail('config', `unparsable JSON at ${CONFIG_PATH}`, 'fix it, or start over: resident init')
  if (!cfg.repos.length && !cfg.urls.length) return warn('config', 'parses, but watches nothing', `add repos/urls in ${CONFIG_PATH} or the inbox watchlist`)
  return ok('config', `${cfg.repos.length} repo(s), ${cfg.urls.length} url(s)`)
}

function checkRepos(cfg: Config | null): Check[] {
  return (cfg?.repos ?? []).map((r) => {
    // readdir, not stat — the TCC blindness canary (macOS allows stat on a folder it won't let us read)
    try { readdirSync(r.path) } catch {
      return fail(r.name, `cannot read ${r.path}`, 'System Settings → Privacy & Security → Files & Folders → your terminal → allow it')
    }
    if (!existsSync(join(r.path, '.git'))) return fail(r.name, `no .git in ${r.path}`, 'point the config entry at the repo root (or remove it)')
    return ok(r.name, 'readable')
  })
}

function checkDb(): Check {
  try {
    const s = openStore()
    const v = String(Date.now())
    s.metaSet('doctor:ping', v)
    const back = s.metaGet('doctor:ping')
    s.db.run("DELETE FROM meta WHERE key='doctor:ping'") // leave no diagnostic residue behind
    s.db.close()
    return back === v ? ok('db', 'read/write ok') : fail('db', 'write/read roundtrip mismatch', `inspect ${join(HOME, 'resident.db')}`)
  } catch (e) {
    // busy ≠ broken: the daemon may simply hold the write lock right now (rare even with the
    // 2s busy_timeout in openStore, but the doctor is exactly the tool people run mid-incident)
    if (/SQLITE_BUSY|database is locked/i.test(String(e))) return warn('db', 'busy — the daemon is writing right now', 'fine; re-run doctor in a moment')
    return fail('db', `cannot open: ${String(e).slice(0, 60)}`, `check ${join(HOME, 'resident.db')} permissions`)
  }
}

async function checkDaemon(): Promise<Check> {
  const port = Number(process.env.PORT) || 5117
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(2_000) })
    if (res.ok) return ok('daemon', `running on :${port}`)
  } catch {}
  const uid = process.getuid?.() ?? 501
  const r = await run(['launchctl', 'print', `gui/${uid}/com.resident.daemon`], undefined, 3_000)
  return r.ok
    ? fail('daemon', `installed (launchd) but not answering on :${port}`, `bun-level crashes land in ${join(HOME, 'launchd.log')}`)
    : info('daemon', 'not running', 'resident start — or resident install for always-on')
}

async function checkSentry(cfg: Config | null): Promise<Check[]> {
  const s = cfg?.sentry
  if (!s) return []
  if (!s.org || !s.token) return [fail('sentry', 'config incomplete — needs org + token', 'personal token scopes: event:read, project:read, org:read')]
  const base = (s.url ?? 'https://sentry.io').replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/api/0/organizations/${s.org}/`, {
      headers: { authorization: `Bearer ${s.token}` },
      signal: AbortSignal.timeout(3_500),
    })
    if (res.ok) return [ok('sentry', `org ${s.org} reachable`)]
    if (res.status === 401 || res.status === 403)
      return [fail('sentry', `token rejected (HTTP ${res.status})`, 'token needs scopes: event:read, project:read, org:read')]
    return [warn('sentry', `HTTP ${res.status} from ${base}`, 'transient? the sense retries every cycle')]
  } catch {
    return [warn('sentry', `${base} unreachable`, 'network/VPN? the sense retries every cycle')]
  }
}

function checkNotify(cfg: Config | null): Check[] {
  const n = cfg?.notify
  if (!n) return []
  try {
    const u = new URL(n)
    // parse + protocol only — a real POST would ping the user's phone every doctor run
    if (u.protocol === 'https:') return [ok('notify', `${u.hostname} (not pinged)`)]
    return [warn('notify', `${u.protocol}// endpoint — unencrypted`, 'use an https URL (ntfy.sh topics and Slack webhooks are)')]
  } catch {
    return [fail('notify', `not a URL: ${n.slice(0, 40)}`, 'set "notify" to an ntfy topic URL or a Slack incoming webhook')]
  }
}

/** Check everything Resident leans on and say what to do about anything broken.
 *  Read-only against the world (one harmless meta write to its own db); exits 1 only on ✗. */
export async function runDoctor(): Promise<number> {
  const cfg = loadConfig()
  // independent checks run concurrently — the doctor should feel instant even when a tool hangs to its timeout
  const [git, claude, gh, daemon, sentry] = await Promise.all([
    checkGit(), checkClaude(), checkGh(), checkDaemon(), checkSentry(cfg),
  ])
  const results: Check[] = [
    ok('bun', `v${Bun.version}`), // the doctor runs on bun — presence is self-evident
    git, claude, gh,
    checkTailscale(),
    checkConfig(cfg),
    ...checkRepos(cfg),
    checkDb(),
    daemon,
    ...sentry,
    ...checkNotify(cfg),
  ]

  console.log(`\n${B}resident doctor${R}\n`)
  const pad = Math.max(...results.map((c) => c.name.length)) + 2
  for (const c of results) console.log(formatCheck(c, pad))
  const fails = results.filter((c) => c.verdict === 'fail').length
  const warns = results.filter((c) => c.verdict === 'warn').length
  console.log(
    fails ? `\n  ${RD}${fails} check(s) need attention${R}\n`
    : warns ? `\n  ${G}healthy${R} ${D}— ${warns} warning(s) above${R}\n`
    : `\n  ${G}all checks passed${R}\n`,
  )
  return exitCode(results)
}
