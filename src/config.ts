import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOME = join(homedir(), '.resident')
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

export interface Config {
  intervalMinutes: number
  budgets: { perCycle: number; perDay: number }
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

/** Which model investigates this item. Legacy `model` pins everything; otherwise base, escalating
 *  on a high score or an explicit Re-investigate. Returns undefined only if a pin was set to "". */
export function investigationModel(cfg: Config, score: number, escalate = false): string {
  if (cfg.model) return cfg.model
  const base = cfg.models?.base ?? MODEL_DEFAULTS.base
  const escalated = cfg.models?.escalated ?? MODEL_DEFAULTS.escalated
  const threshold = cfg.escalateScore ?? MODEL_DEFAULTS.escalateScore
  return escalate || score >= threshold ? escalated : base
}

// chaining / redirection / subshell / newline — no place in an allowlisted package command, and a
// signal the proposal is trying to do more than it claims. (Commands also run shell-less, so these are
// inert at execution; rejecting them is defence-in-depth + keeps the allowlist honest.)
const SHELL_META = /[;&|`$<>(){}\n]/

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
