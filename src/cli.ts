#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { loadConfig, saveConfig, discoverRepos, DEFAULTS, CONFIG_PATH, type Config } from './config'
import { openStore } from './store'
import { cycle, startLoop, type DaemonState } from './daemon'
import { startServer } from './server'

const B = '\x1b[1m', D = '\x1b[2m', C = '\x1b[36m', G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[0m'
const ts = () => new Date().toTimeString().slice(0, 8)
const log = (s: string) => console.log(`${D}${ts()}${R} ${s}`)

const HELP = `
${B}resident${R} — the agent that doesn't wait to be prompted

${B}usage${R}
  resident init          discover repos, write ~/.resident/config.json
  resident once          run a single cycle in the foreground (great first run)
                           --investigations <n>   cap claude investigations (default config)
  resident start         run the daemon: cycles forever + inbox UI
  resident status        what it knows right now
  resident open          open the inbox

${B}how it behaves${R}
  Everything autonomous is read-only (shadow mode): it watches, investigates,
  and proposes patches. Writes happen only when you click Approve (branch + PR)
  or Open issue in the inbox. Approved PRs are tracked to merged/closed.

  Config: ${CONFIG_PATH}  (repos, urls, interval, budgets)
`

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    investigations: { type: 'string' },
    port: { type: 'string' },
    lan: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
})

const cmd = positionals[0] ?? 'help'
if (values.help || cmd === 'help') {
  console.log(HELP)
  process.exit(0)
}

function ensureConfig(): Config {
  let cfg = loadConfig()
  if (!cfg) {
    cfg = { ...DEFAULTS, repos: discoverRepos() }
    saveConfig(cfg)
    console.log(`${G}✓${R} created ${CONFIG_PATH}`)
  }
  return cfg
}

switch (cmd) {
  case 'init': {
    const cfg = ensureConfig()
    console.log(`\n${B}watching${R}`)
    for (const r of cfg.repos) console.log(`  ${C}${r.name}${R} ${D}${r.path}${R}`)
    for (const u of cfg.urls) console.log(`  ${C}${u}${R} ${D}uptime${R}`)
    console.log(`\n${D}interval ${cfg.intervalMinutes}m · budgets ${cfg.budgets.perCycle}/cycle, ${cfg.budgets.perDay}/day · edit ${CONFIG_PATH}${R}\n`)
    break
  }

  case 'once': {
    const cfg = ensureConfig()
    const store = openStore()
    const max = values.investigations !== undefined ? Number(values.investigations) : undefined
    await cycle(cfg, store, log, { maxInvestigations: max })
    const ready = store.items(50).filter((i) => i.status === 'ready')
    if (ready.length) {
      console.log(`\n${B}ready for you${R}`)
      for (const i of ready) console.log(`  ${scoreDot(i.score)} ${i.title} ${D}[${i.repo || 'alert'}]${R}`)
      console.log(`\n${D}open the inbox with: resident start  (then resident open)${R}`)
    }
    break
  }

  case 'start': {
    const cfg = ensureConfig()
    const store = openStore()
    const state: DaemonState = { nextCycleAt: 0, cycling: false, lastCycle: null }
    if (values.port) process.env.PORT = values.port
    if (values.lan) cfg.bind = '0.0.0.0' // reachable from other devices (pair with Tailscale off home Wi-Fi)
    const srv = startServer({ cfg, store, state, log, requestCycle: () => state.wake?.() })
    if (values.lan) {
      const ip = Bun.spawnSync(['ipconfig', 'getifaddr', 'en0'], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim()
      console.log(`${Y}  ⚠ inbox bound to all interfaces — no auth; trust your network (or use Tailscale).${R}`)
      if (ip) console.log(`  from other devices: ${C}http://${ip}:${srv.port}${R}\n`)
    }

    // stable URL via portless if available (alias → https://resident.localhost)
    let url = `http://localhost:${srv.port}`
    try {
      const r = Bun.spawnSync(['portless', 'alias', 'resident', String(srv.port)], { stdout: 'pipe', stderr: 'pipe' })
      if (r.exitCode === 0) url = 'https://resident.localhost'
    } catch {}

    console.log(`
${B}resident${R} ${D}· awake. watching ${cfg.repos.length} repos and ${cfg.urls.length} site(s).${R}

  inbox     ${C}${url}${R}
  rhythm    ${D}every ${cfg.intervalMinutes} minutes · ${cfg.budgets.perCycle} investigations/cycle · ${cfg.budgets.perDay}/day${R}
  mode      ${D}shadow — read-only until you approve something${R}
`)
    await startLoop(cfg, store, state, log)
    break
  }

  case 'status': {
    const store = openStore()
    const items = store.items(500)
    const by = (s: string) => items.filter((i) => i.status === s).length
    console.log(`
${B}resident status${R}
  ready       ${by('ready')}
  queued      ${by('queued')}
  approved    ${by('approved')} ${D}(PR open)${R}
  merged      ${by('merged')}
  tracked     ${by('tracked')} ${D}(issue open)${R}
  ignored     ${by('ignored')} ${D}(below threshold)${R}
  dismissed   ${by('dismissed')}
  today       ${store.usedToday()} investigations · $${store.costToday().toFixed(2)}
`)
    break
  }

  case 'open': {
    let url = `http://localhost:${process.env.PORT ?? 5117}`
    try {
      const r = Bun.spawnSync(['portless', 'get', 'resident'], { stdout: 'pipe', stderr: 'pipe' })
      const out = r.stdout.toString().trim()
      if (r.exitCode === 0 && out.startsWith('http')) url = out
    } catch {}
    Bun.spawn(['open', url], { stdout: 'ignore', stderr: 'ignore' })
    console.log(url)
    break
  }

  default:
    console.error(`${Y}unknown command: ${cmd}${R}`)
    console.log(HELP)
    process.exit(1)
}

function scoreDot(score: number) {
  return score >= 80 ? '\x1b[31m●\x1b[0m' : score >= 60 ? '\x1b[33m●\x1b[0m' : '\x1b[36m●\x1b[0m'
}
