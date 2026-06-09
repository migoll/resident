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
}

export interface Config {
  intervalMinutes: number
  budgets: { perCycle: number; perDay: number }
  /** optional model override for investigations, e.g. "haiku" */
  model?: string
  /** interface for the inbox server (default 127.0.0.1; "0.0.0.0" for LAN/Tailscale access) */
  bind?: string
  urls: string[]
  repos: RepoCfg[]
}

export const DEFAULTS: Config = {
  intervalMinutes: 15,
  budgets: { perCycle: 2, perDay: 10 },
  urls: ['https://homerunner.com'],
  repos: [],
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
