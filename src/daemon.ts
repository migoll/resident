import { readdirSync } from 'node:fs'
import { investigationModel, type Config } from './config'
import { maybeRotateLog } from './hygiene'
import { run } from './proc'
import { runSenses } from './senses'
import { investigate, branchFor } from './hands'
import { notify, hm } from './notify'
import { INVESTIGATE_THRESHOLD, MUTE_THRESHOLD, type Store } from './store'

export interface DaemonState {
  nextCycleAt: number
  cycling: boolean
  lastCycle: { at: number; findings: number; new: number; investigated: number } | null
  /** resolves the current sleep early (UI "Run now") */
  wake?: () => void
}

/** Heal state orphaned by restarts. No run survives a daemon death — anything
 *  mid-flight either finished out in the world (check GitHub) or must be requeued.
 *  Async on purpose: spawnSync here would freeze the inbox server it shares a process with. */
export async function reconcile(cfg: Config, store: Store, log: (s: string) => void) {
  for (const it of store.items(500)) {
    if (it.status === 'investigating') {
      store.update(it.id, { status: 'queued', reason: 'interrupted by restart — requeued' })
      log(`  ↺ requeued interrupted investigation: ${it.title}`)
    } else if (it.status === 'approving' || it.status === 'working') {
      const repo = cfg.repos.find((r) => r.name === it.repo)
      let url: string | null = null
      if (repo) {
        try {
          const r = await run(['gh', 'pr', 'list', '--head', branchFor(it), '--state', 'all', '--json', 'url'], repo.path)
          url = JSON.parse(r.stdout)[0]?.url ?? null
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
 *  issues get closed — the inbox should reflect reality without being told.
 *  Async on purpose: spawnSync here would freeze the inbox server it shares a process with. */
export async function refreshOutcomes(store: Store, log: (s: string) => void) {
  for (const it of store.items(300)) {
    if (!it.pr_url?.startsWith('https://github.com')) continue
    try {
      if (it.status === 'approved') {
        const r = await run(['gh', 'pr', 'view', it.pr_url, '--json', 'state'])
        if (!r.ok) continue
        const st = JSON.parse(r.stdout).state
        if (st === 'MERGED') { store.update(it.id, { status: 'merged', reason: 'PR merged' }); log(`  ✓ merged: ${it.title}`) }
        else if (st === 'CLOSED') store.update(it.id, { status: 'closed', reason: 'PR closed without merging' })
      } else if (it.status === 'tracked') {
        const r = await run(['gh', 'issue', 'view', it.pr_url, '--json', 'state'])
        if (r.ok && JSON.parse(r.stdout).state === 'CLOSED') store.update(it.id, { status: 'closed', reason: 'issue closed' })
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

/** Once a day, the first cycle at/after the configured digest time sends ONE summary ping —
 *  the morning-coffee read of what accumulated while pings were quiet. `send` is injectable
 *  for tests; the flag is set before sending (a lost digest is never retried — silence > spam). */
export function maybeDigest(cfg: Config, store: Store, log: (s: string) => void, send = notify, now = new Date()) {
  if (!cfg.digest) return
  const t = hm(cfg.digest)
  if (Number.isNaN(t)) return
  if (now.getHours() * 60 + now.getMinutes() < t) return
  // LOCAL date key, matching the local time gate above — a UTC key would mint a second key
  // mid-local-day for small-hours digest times in UTC+ zones (double-fire, then drift)
  const key = `digest:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  if (store.metaGet(key)) return
  store.metaSet(key, String(Date.now()))
  const ready = store.items(150).filter((i) => i.status === 'ready')
  const queued = store.queued(99).length
  const lines = [
    ready.length ? `${ready.length} ready for you${queued ? ` · ${queued} queued` : ''}` : `nothing needs you${queued ? ` — ${queued} queued` : ''}`,
    ...ready.slice(0, 3).map((i) => `· ${i.title}${i.repo ? ` [${i.repo}]` : ''}`),
    `$${store.costToday().toFixed(2)} AI spend today · ${store.usedToday()} investigation(s)`,
  ]
  log(`☉ digest sent (${ready.length} ready)`)
  send(cfg, 'Resident: morning digest', lines.join('\n'), { force: true })
}

/** One full heartbeat: outcomes → sense → triage → investigate within budget. */
export async function cycle(
  cfg: Config,
  store: Store,
  log: (s: string) => void,
  opts: { maxInvestigations?: number } = {},
) {
  const t0 = Date.now()
  maybeRotateLog() // before this cycle's lines append, never mid-stream
  log(`◉ cycle started — ${cfg.repos.length} repos, ${cfg.urls.length} url(s)`)

  // retention: long-settled items leave the views (not the db) so the inbox and outcome polls stay lean
  const retention = cfg.retentionDays ?? 30
  const archived = store.archiveOld(retention)
  if (archived > 0) log(`  🗄 archived ${archived} item(s) older than ${retention}d`)

  await refreshOutcomes(store, log)
  blindnessCheck(cfg, store)

  const findings = await runSenses(cfg, log)

  let fresh = 0
  const mutes = new Map(store.mutes().map((m) => [`${m.repo}|${m.kind}`, m.source]))
  for (const f of findings) {
    const muteSrc = mutes.get(`${f.repo}|${f.kind}`)
    const status = !muteSrc && f.score >= INVESTIGATE_THRESHOLD ? 'queued' : 'ignored'
    const res = store.upsertFinding({
      ...f,
      status,
      reason: status === 'ignored'
        ? muteSrc === 'auto' ? `muted — you've dismissed ${f.kind} in ${f.repo || 'alerts'} ${MUTE_THRESHOLD}×; unmute from the inbox`
        : muteSrc ? 'muted by you — unmute from the inbox'
        : `below threshold (score ${f.score})`
        : undefined,
    }, !!muteSrc)
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
        // repo-less alert (uptime, self): surface directly, nothing to dig through.
        // Hard outages and blindness PIERCE quiet hours — a site down at 3am and a daemon gone
        // blind are exactly what the phone alarm exists for; only calm pings sleep.
        store.update(item.id, { status: 'ready', reason: item.sense === 'self' ? 'action needed on your Mac' : 'alert — no local repo to investigate' })
        notify(cfg, 'Resident: alert', item.title, { force: item.kind === 'down' || item.kind === 'blind' })
        continue
      }
      // routine digs run on the cheap base model; high scores and Re-investigate earn the strong one
      const escalate = !!item.escalate
      const model = investigationModel(cfg, item.score, escalate)
      log(`  ⚒ investigating: ${item.title} [${item.repo}] · ${model}${escalate ? ' (escalated)' : ''}`)
      // NB: escalate is consumed on SUCCESS, not here — so a dig interrupted by a restart keeps its
      // tier when reconcile() requeues it (and a failed escalated dig retries escalated)
      store.update(item.id, { status: 'investigating', model, reason: null }) // clear stale queued/requeue reason
      store.bumpToday()
      const res = await investigate(item, repo.path, model, store.memory(repo.name)?.notes ?? '')
      store.addCost(res.cost)
      if (res.ok) {
        if (res.memory) {
          if (store.appendMemory(repo.name, res.memory)) log(`    ↳ memory updated for ${repo.name}`)
          else log(`    ↳ memory full for ${repo.name} — edit it in the inbox to make room`)
        }
        store.update(item.id, { status: 'ready', evidence: res.evidence, patch: res.patch, command: res.command, cost: res.cost, escalate: 0 })
        const fix = res.patch ? 'fix proposed' : res.command ? `command proposed: ${res.command}` : 'no patch'
        log(`    → ready (${fix}, ${model}, $${res.cost.toFixed(2)})`)
        notify(cfg, 'Resident: ready for you', `${item.title} [${item.repo}]${res.patch ? ' — fix proposed, one tap to PR' : res.command ? ` — command proposed: ${res.command}` : ''}`)
      } else {
        // killed/timed-out runs spend real money before dying — record the estimate so the budget ledger isn't fooled
        store.update(item.id, {
          status: 'failed', evidence: res.evidence, cost: res.cost,
          reason: res.costEstimated ? `investigation killed — est. $${res.cost.toFixed(2)} spent before final accounting` : 'investigation errored',
        })
        log(`    → failed${res.costEstimated ? ` (est. $${res.cost.toFixed(2)})` : ''}`)
      }
      investigated++
    }
  } else {
    const stillQueued = store.queued(99).length
    if (stillQueued) log(`  ${stillQueued} item(s) queued — investigation budget exhausted for now`)
  }

  maybeDigest(cfg, store, log)

  log(`◉ cycle done in ${Math.round((Date.now() - t0) / 1000)}s`)
  return { findings: findings.length, new: fresh, investigated }
}

/** The forever loop. */
export async function startLoop(cfg: Config, store: Store, state: DaemonState, log: (s: string) => void) {
  const interval = Math.max(2, cfg.intervalMinutes) * 60_000
  await reconcile(cfg, store, log)
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
