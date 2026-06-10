import { readdirSync } from 'node:fs'
import type { Config } from './config'
import { runSenses } from './senses'
import { investigate, branchFor } from './hands'
import { notify } from './notify'
import { INVESTIGATE_THRESHOLD, type Store } from './store'

export interface DaemonState {
  nextCycleAt: number
  cycling: boolean
  lastCycle: { at: number; findings: number; new: number; investigated: number } | null
  /** resolves the current sleep early (UI "Run now") */
  wake?: () => void
}

/** Heal state orphaned by restarts. No run survives a daemon death — anything
 *  mid-flight either finished out in the world (check GitHub) or must be requeued. */
export function reconcile(cfg: Config, store: Store, log: (s: string) => void) {
  for (const it of store.items(500)) {
    if (it.status === 'investigating') {
      store.update(it.id, { status: 'queued', reason: 'interrupted by restart — requeued' })
      log(`  ↺ requeued interrupted investigation: ${it.title}`)
    } else if (it.status === 'approving' || it.status === 'working') {
      const repo = cfg.repos.find((r) => r.name === it.repo)
      let url: string | null = null
      if (repo) {
        try {
          const r = Bun.spawnSync(['gh', 'pr', 'list', '--head', branchFor(it), '--state', 'all', '--json', 'url'], { cwd: repo.path, stdout: 'pipe', stderr: 'pipe' })
          url = JSON.parse(r.stdout.toString())[0]?.url ?? null
        } catch {}
      }
      if (url) {
        store.update(it.id, { status: 'approved', pr_url: url })
        log(`  ✓ reconciled interrupted run → ${url}`)
      } else {
        store.update(it.id, { status: 'ready', reason: 'run interrupted by restart — approve again to retry' })
        log(`  ↺ reset interrupted approval: ${it.title}`)
      }
    }
  }
}

/** Track outcomes after our part is done: PRs get merged/closed by humans,
 *  issues get closed — the inbox should reflect reality without being told. */
export function refreshOutcomes(store: Store, log: (s: string) => void) {
  for (const it of store.items(300)) {
    if (!it.pr_url?.startsWith('https://github.com')) continue
    try {
      if (it.status === 'approved') {
        const r = Bun.spawnSync(['gh', 'pr', 'view', it.pr_url, '--json', 'state'], { stdout: 'pipe', stderr: 'pipe' })
        const st = JSON.parse(r.stdout.toString()).state
        if (st === 'MERGED') { store.update(it.id, { status: 'merged', reason: 'PR merged' }); log(`  ✓ merged: ${it.title}`) }
        else if (st === 'CLOSED') store.update(it.id, { status: 'closed', reason: 'PR closed without merging' })
      } else if (it.status === 'tracked') {
        const r = Bun.spawnSync(['gh', 'issue', 'view', it.pr_url, '--json', 'state'], { stdout: 'pipe', stderr: 'pipe' })
        if (JSON.parse(r.stdout.toString()).state === 'CLOSED') store.update(it.id, { status: 'closed', reason: 'issue closed' })
      }
    } catch {}
  }
}

/** If the OS is denying access to the watched repos, say so loudly — a blind
 *  custodian reporting "all quiet" is the one unforgivable failure mode. */
function blindnessCheck(cfg: Config, store: Store) {
  if (!cfg.repos.length) return
  let blind = true
  for (const r of cfg.repos.slice(0, 3)) {
    // readdir, not stat: macOS TCC allows stat on a denied folder but blocks reading it
    try { readdirSync(r.path); blind = false; break } catch {}
  }
  if (blind) {
    store.upsertFinding({
      hash: 'self|blind', sense: 'self', repo: '', kind: 'blind',
      title: 'Resident can’t read your repos — macOS is denying folder access',
      detail: 'Filesystem access to the watched repos is failing (Operation not permitted), so scans are running blind — “0 findings” currently means “couldn’t look”, not “all clear”.\n\nFix: System Settings → Privacy & Security → Files & Folders → your terminal app → enable “Documents Folder” (or grant Full Disk Access). Then click “Run a cycle now”.',
      score: 90, status: 'queued',
    })
  } else {
    store.db.run("UPDATE items SET status='closed', reason='resolved — repos are visible again', updated=? WHERE hash='self|blind' AND status IN ('queued','ready')", [Date.now()])
  }
}

/** One full heartbeat: outcomes → sense → triage → investigate within budget. */
export async function cycle(
  cfg: Config,
  store: Store,
  log: (s: string) => void,
  opts: { maxInvestigations?: number } = {},
) {
  const t0 = Date.now()
  log(`◉ cycle started — ${cfg.repos.length} repos, ${cfg.urls.length} url(s)`)

  refreshOutcomes(store, log)
  blindnessCheck(cfg, store)

  const findings = await runSenses(cfg, log)

  let fresh = 0
  for (const f of findings) {
    const status = f.score >= INVESTIGATE_THRESHOLD ? 'queued' : 'ignored'
    const res = store.upsertFinding({
      ...f,
      status,
      reason: status === 'ignored' ? `below threshold (score ${f.score})` : undefined,
    })
    if (res === 'new') fresh++
  }
  log(`  ${findings.length} findings (${fresh} new)`)

  // ---- budgets
  const remainingToday = Math.max(0, cfg.budgets.perDay - store.usedToday())
  const budget = Math.min(opts.maxInvestigations ?? cfg.budgets.perCycle, remainingToday)

  let investigated = 0
  if (budget > 0) {
    for (const item of store.queued(budget)) {
      const repo = cfg.repos.find((r) => r.name === item.repo)
      if (!repo) {
        // repo-less alert (uptime, self): surface directly, nothing to dig through
        store.update(item.id, { status: 'ready', reason: item.sense === 'self' ? 'action needed on your Mac' : 'alert — no local repo to investigate' })
        notify(cfg, 'Resident: alert', item.title)
        continue
      }
      log(`  ⚒ investigating: ${item.title} [${item.repo}]`)
      store.update(item.id, { status: 'investigating' })
      store.bumpToday()
      const res = await investigate(item, repo.path, cfg.model)
      store.addCost(res.cost)
      if (res.ok) {
        store.update(item.id, { status: 'ready', evidence: res.evidence, patch: res.patch, cost: res.cost })
        log(`    → ready (${res.patch ? 'fix proposed' : 'no patch'}, $${res.cost.toFixed(2)})`)
        notify(cfg, 'Resident: ready for you', `${item.title} [${item.repo}]${res.patch ? ' — fix proposed, one tap to PR' : ''}`)
      } else {
        store.update(item.id, { status: 'failed', evidence: res.evidence, reason: 'investigation errored' })
        log(`    → failed`)
      }
      investigated++
    }
  } else {
    const stillQueued = store.queued(99).length
    if (stillQueued) log(`  ${stillQueued} item(s) queued — investigation budget exhausted for now`)
  }

  log(`◉ cycle done in ${Math.round((Date.now() - t0) / 1000)}s`)
  return { findings: findings.length, new: fresh, investigated }
}

/** The forever loop. */
export async function startLoop(cfg: Config, store: Store, state: DaemonState, log: (s: string) => void) {
  const interval = Math.max(2, cfg.intervalMinutes) * 60_000
  reconcile(cfg, store, log)
  while (true) {
    state.cycling = true
    try {
      const summary = await cycle(cfg, store, log)
      state.lastCycle = { at: Date.now(), ...summary }
    } catch (e) {
      log(`cycle error: ${e}`)
    }
    state.cycling = false
    state.nextCycleAt = Date.now() + interval
    await new Promise<void>((resolve) => {
      state.wake = resolve
      setTimeout(resolve, interval)
    })
    state.wake = undefined
  }
}
