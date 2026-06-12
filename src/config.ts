import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** State dir (config, db, transcripts). `RESIDENT_HOME` overrides it — relocated installs and
 *  tests (which must never touch the real ~/.resident) both ride this. Read once, at import time. */
export const HOME = process.env.RESIDENT_HOME || join(homedir(), '.resident')
export const CONFIG_PATH = join(HOME, 'config.json')

export interface RepoCfg {
  path: string
  name: string
  /** run `bun run typecheck` each cycle if the script exists (default true) */
  checks?: boolean
  /** git pull --ff-only before each scan — for dedicated/server machines watching clones */
  pull?: boolean
  /** command prefixes a human may one-click run for this repo, e.g. ["bun update", "bun install"].
   *  Absent/empty = no command-fix may run here (safe default — opt in per repo to earn the capability). */
  commands?: string[]
}

export interface SentryCfg {
  org: string
  /** Personal Token (scopes: event:read, project:read, org:read) — lives only in ~/.resident/config.json */
  token: string
  /** API base; new orgs may live on a regional host (e.g. https://de.sentry.io) */
  url?: string
}

export interface Config {
  intervalMinutes: number
  budgets: { perCycle: number; perDay: number }
  /** archive merged/closed/dismissed/failed/ignored items untouched for this many days —
   *  hidden from the inbox, kept in the db (default 30; 0 or negative keeps everything) */
  retentionDays?: number
  /** error monitoring — the 2am-prod-error signal */
  sentry?: SentryCfg
  /** @deprecated legacy pin: if set, forces EVERY investigation onto this model (disables tiering). Prefer `models`. */
  model?: string
  /** model tiering for investigations: a cheap base model for routine digs, a stronger one for the hard cases */
  models?: { base?: string; escalated?: string }
  /** investigations scoring at/above this escalate to models.escalated (default 85); Re-investigate always escalates */
  escalateScore?: number
  /** interface for the inbox server (default 127.0.0.1; "0.0.0.0" for LAN/Tailscale access) */
  bind?: string
  /** push endpoint: an ntfy topic URL (e.g. https://ntfy.sh/your-secret-topic) or a Slack incoming webhook */
  notify?: string
  /** notification quiet hours, e.g. { start: "22:00", end: "08:00" } (may wrap midnight).
   *  Pings are suppressed inside the window — the inbox itself never sleeps. */
  quietHours?: { start: string; end: string }
  /** "HH:MM" — once a day, the first cycle at/after this time sends ONE summary ping
   *  (what's ready, what was spent) instead of Resident having pinged all night */
  digest?: string
  urls: string[]
  repos: RepoCfg[]
}

export const DEFAULTS: Config = {
  intervalMinutes: 15,
  budgets: { perCycle: 2, perDay: 10 },
  urls: ['https://homerunner.com'],
  repos: [],
}

/** Tiering defaults: routine digs run cheap; only high-signal/asked-for ones pay for the big model. */
export const MODEL_DEFAULTS = { base: 'sonnet', escalated: 'opus', escalateScore: 85 } as const

/** Which model investigates this item. Legacy `model` pins everything; otherwise base,
 *  escalating on a high score or an explicit Re-investigate. Always returns a model string. */
export function investigationModel(cfg: Config, score: number, escalate = false): string {
  if (cfg.model) return cfg.model
  const base = cfg.models?.base ?? MODEL_DEFAULTS.base
  const escalated = cfg.models?.escalated ?? MODEL_DEFAULTS.escalated
  const threshold = cfg.escalateScore ?? MODEL_DEFAULTS.escalateScore
  return escalate || score >= threshold ? escalated : base
}

/** Model for the apply/approve step (applying an already-written diff, opening the PR — mechanical
 *  work): the cheap base tier unless the legacy pin is set. Never fall through to the CLI's own
 *  default model — that follows the user's interactive setting and silently changes Resident's costs. */
export function applyModel(cfg: Config): string {
  return cfg.model ?? cfg.models?.base ?? MODEL_DEFAULTS.base
}

// chaining / redirection / subshell / newline+CR — no place in an allowlisted package command, and a
// signal the proposal is trying to do more than it claims. Quotes/backslash are rejected too: commands
// run shell-less (arg-array spawn), so quoting is never meaningful — a quoted token would be passed
// literally and misbehave. (Metachars are equally inert at execution; rejecting is defence-in-depth.)
const SHELL_META = /[;&|`$<>(){}'"\\\n\r]/

/** True only if `cmd` is a single, metachar-free command whose leading tokens match one of the repo's
 *  allowed prefixes on a token boundary (so "bun update" allows "bun update zod" but not "bun updatex"). */
export function commandAllowed(repo: RepoCfg | undefined, cmd: string): boolean {
  const c = (cmd ?? '').trim()
  if (!repo || !c || SHELL_META.test(c)) return false
  const toks = c.split(/\s+/)
  return (repo.commands ?? []).some((allow) => {
    const a = allow.trim().split(/\s+/).filter(Boolean)
    return a.length > 0 && a.length <= toks.length && a.every((t, i) => t === toks[i])
  })
}

export function loadConfig(): Config | null {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    return { ...DEFAULTS, ...raw, budgets: { ...DEFAULTS.budgets, ...(raw.budgets ?? {}) } }
  } catch {
    return null
  }
}

export function saveConfig(c: Config) {
  mkdirSync(HOME, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n')
}

/** Find the most recently touched git repos under ~/Documents/GitHub. */
export function discoverRepos(root = join(homedir(), 'Documents', 'GitHub'), max = 8): RepoCfg[] {
  if (!existsSync(root)) return []
  const out: { path: string; name: string; mtime: number }[] = []
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    try {
      if (!statSync(join(path, '.git')).isDirectory()) continue
      out.push({ path, name, mtime: statSync(path).mtimeMs })
    } catch {}
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out.slice(0, max).map(({ path, name }) => ({ path, name }))
}
