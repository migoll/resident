import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { saveConfig, commandAllowed, applyModel, type Config } from './config'
import { MAX_MEMORY_CHARS, type Store } from './store'
import type { DaemonState } from './daemon'
import { approve, applyCommand } from './hands'
import { notify } from './notify'

export function startServer(deps: {
  cfg: Config
  store: Store
  state: DaemonState
  requestCycle: () => void
  log: (s: string) => void
}) {
  const { cfg, store, state, log } = deps
  const html = readFileSync(new URL('./ui/inbox.html', import.meta.url), 'utf8')
  const port = Number(process.env.PORT) || 5117

  // repo name → https://github.com/... (best-effort; retried while empty,
  // e.g. when folder access was denied at startup and granted later)
  const repoUrls: Record<string, string> = {}
  let repoUrlsAt = 0
  function refreshRepoUrls() {
    const missing = cfg.repos.some((r) => !(r.name in repoUrls))
    if (!missing || Date.now() - repoUrlsAt < 60_000) return
    repoUrlsAt = Date.now()
    for (const r of cfg.repos) {
      try {
        const out = Bun.spawnSync(['git', '-C', r.path, 'remote', 'get-url', 'origin'], { stdout: 'pipe', stderr: 'pipe' })
          .stdout.toString().trim()
        if (out.includes('github.com'))
          repoUrls[r.name] = out.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '')
      } catch {}
    }
  }
  refreshRepoUrls()

  const server = Bun.serve({
    port,
    hostname: process.env.RESIDENT_BIND ?? cfg.bind ?? '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === '/') {
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      if (url.pathname === '/icon.png') {
        return new Response(Bun.file(new URL('./ui/icon.png', import.meta.url).pathname))
      }
      if (url.pathname === '/manifest.json') {
        return new Response(Bun.file(new URL('./ui/manifest.json', import.meta.url).pathname), {
          headers: { 'content-type': 'application/manifest+json' },
        })
      }

      if (url.pathname === '/api/state') {
        refreshRepoUrls()
        return Response.json({
          now: Date.now(),
          nextCycleAt: state.nextCycleAt,
          cycling: state.cycling,
          lastCycle: state.lastCycle,
          usedToday: store.usedToday(),
          costToday: store.costToday(),
          budgets: cfg.budgets,
          intervalMinutes: cfg.intervalMinutes,
          watching: { repos: cfg.repos.map((r) => r.name), urls: cfg.urls },
          repoUrls,
          memories: cfg.repos.map((r) => {
            const memory = store.memory(r.name)
            return { repo: r.name, notes: memory?.notes ?? '', updated: memory?.updated ?? null }
          }),
          // tell the UI which proposed commands are runnable (allowlisted) without duplicating the rule client-side
          items: store.items(150).map((it) =>
            it.command ? { ...it, commandAllowed: commandAllowed(cfg.repos.find((r) => r.name === it.repo), it.command) } : it,
          ),
        })
      }

      if (url.pathname === '/api/cycle' && req.method === 'POST') {
        deps.requestCycle()
        return Response.json({ ok: true })
      }

      // Repository memory is intentionally a small, editable notebook rather than opaque model state.
      if (url.pathname === '/api/memory' && req.method === 'POST') {
        let body: any
        try { body = await req.json() } catch { return Response.json({ ok: false, error: 'bad json' }, { status: 400 }) }
        if (typeof body.repo !== 'string' || !cfg.repos.some((r) => r.name === body.repo))
          return Response.json({ ok: false, error: 'unknown repo' }, { status: 400 })
        if (typeof body.notes !== 'string') return Response.json({ ok: false, error: 'notes must be text' }, { status: 400 })
        if (!store.setMemory(body.repo, body.notes))
          return Response.json({ ok: false, error: `memory is limited to ${MAX_MEMORY_CHARS.toLocaleString()} characters` }, { status: 400 })
        log(`↳ memory edited for ${body.repo}`)
        return Response.json({ ok: true })
      }

      // watchlist editing: {add: "<url or repo path>"} or {remove: "<url or repo name>"}
      // cfg is shared by reference with the daemon, so changes apply from the next cycle.
      if (url.pathname === '/api/watch' && req.method === 'POST') {
        let body: any
        try { body = await req.json() } catch { return Response.json({ ok: false, error: 'bad json' }, { status: 400 }) }

        if (typeof body.add === 'string' && body.add.trim()) {
          const v = body.add.trim()
          if (/^https?:\/\//.test(v)) {
            if (cfg.urls.includes(v)) return Response.json({ ok: false, error: 'already watching that url' }, { status: 400 })
            cfg.urls.push(v)
            log(`+ watching url ${v}`)
          } else {
            const path = v.replace(/^~(?=\/|$)/, homedir()).replace(/\/$/, '')
            if (!existsSync(join(path, '.git'))) return Response.json({ ok: false, error: 'not a git repo (no .git at that path)' }, { status: 400 })
            const name = basename(path)
            if (cfg.repos.some((r) => r.name === name || r.path === path))
              return Response.json({ ok: false, error: 'already watching that repo' }, { status: 400 })
            cfg.repos.push({ path, name })
            repoUrlsAt = 0
            refreshRepoUrls() // pick up its github link immediately
            log(`+ watching repo ${name}`)
          }
        } else if (typeof body.remove === 'string' && body.remove.trim()) {
          const v = body.remove.trim()
          const ri = cfg.repos.findIndex((r) => r.name === v)
          const ui = cfg.urls.indexOf(v)
          if (ri >= 0) { cfg.repos.splice(ri, 1); delete repoUrls[v]; log(`− stopped watching repo ${v}`) }
          else if (ui >= 0) { cfg.urls.splice(ui, 1); log(`− stopped watching url ${v}`) }
          else return Response.json({ ok: false, error: 'not found' }, { status: 404 })
        } else {
          return Response.json({ ok: false, error: 'need add or remove' }, { status: 400 })
        }

        saveConfig(cfg)
        deps.requestCycle()
        return Response.json({ ok: true, repos: cfg.repos.map((r) => r.name), urls: cfg.urls })
      }

      const m = url.pathname.match(/^\/api\/item\/(\d+)\/(dismiss|approve|restore|reinvestigate|issue)$/)
      if (m && req.method === 'POST') {
        const item = store.byId(Number(m[1]))
        if (!item) return Response.json({ ok: false, error: 'not found' }, { status: 404 })
        const action = m[2]

        if (action === 'dismiss') {
          store.update(item.id, { status: 'dismissed' })
          return Response.json({ ok: true })
        }

        // regret is allowed: dismissed/failed items come back with their evidence
        if (action === 'restore') {
          store.update(item.id, { status: item.evidence ? 'ready' : 'queued', reason: 'restored by you' })
          if (!item.evidence) deps.requestCycle()
          return Response.json({ ok: true })
        }

        // fresh eyes: requeue and re-run on the STRONG model (costs one budget unit)
        if (action === 'reinvestigate') {
          store.update(item.id, { status: 'queued', evidence: null, patch: null, command: null, escalate: 1, reason: 'fresh look requested by you — escalating to the strong model' })
          deps.requestCycle()
          return Response.json({ ok: true })
        }

        // track it instead of fixing it: deterministic gh issue create, no AI cost
        if (action === 'issue') {
          const repo = cfg.repos.find((r) => r.name === item.repo)
          if (!repo || !repoUrls[item.repo]) return Response.json({ ok: false, error: 'no github remote' }, { status: 400 })
          store.update(item.id, { status: 'working' })
          ;(async () => {
            log(`⚒ opening issue for #${item.id}: ${item.title}`)
            const body =
              `**Resident finding** · score ${item.score} · \`${item.sense}/${item.kind}\`\n\n` +
              (item.detail ? '```\n' + item.detail.slice(0, 1500) + '\n```\n\n' : '') +
              (item.evidence ?? '').slice(0, 6000) +
              '\n\n---\nOpened from the Resident inbox (human-approved).'
            try {
              const p = Bun.spawn(['gh', 'issue', 'create', '--title', `[resident] ${item.title}`, '--body', body], {
                cwd: repo.path, stdout: 'pipe', stderr: 'pipe', timeout: 60_000,
              })
              const out = await new Response(p.stdout).text()
              const code = await p.exited
              const link = out.match(/https?:\/\/\S+/)?.[0] ?? null
              if (code === 0 && link) {
                store.update(item.id, { status: 'tracked', pr_url: link })
                log(`  → ${link}`)
              } else {
                store.update(item.id, { status: 'ready', reason: 'issue creation failed — see daemon log' })
              }
            } catch {
              store.update(item.id, { status: 'ready', reason: 'issue creation failed' })
            }
          })()
          return Response.json({ ok: true })
        }

        // approve → apply the proposed fix on a worktree branch + open PR (async; UI polls).
        // A fix is either a diff (AI-applied) or an allowlisted command (deterministic, no AI).
        const repo = cfg.repos.find((r) => r.name === item.repo)
        if (!repo) return Response.json({ ok: false, error: 'unknown repo' }, { status: 400 })
        const useCommand = !item.patch && !!item.command
        if (!item.patch && !item.command) return Response.json({ ok: false, error: 'no fix to apply' }, { status: 400 })
        if (useCommand && !commandAllowed(repo, item.command!))
          return Response.json({ ok: false, error: `command not in ${repo.name}'s allowlist: ${item.command}` }, { status: 400 })
        store.update(item.id, { status: 'approving' })
        ;(async () => {
          log(`⚒ approving #${item.id}: ${item.title}${useCommand ? ` · $ ${item.command}` : ''}`)
          // applyModel, never bare cfg.model: with no pin set, runClaude would omit --model and inherit
          // whatever the user's interactive CLI default happens to be — an invisible cost change
          const res = useCommand ? await applyCommand(item, repo.path) : await approve(item, repo.path, applyModel(cfg))
          store.addCost(res.cost)
          if (res.ok) {
            store.update(item.id, { status: 'approved', pr_url: res.pr_url, cost: item.cost + res.cost })
            log(`  → ${res.pr_url}`)
            notify(cfg, 'Resident: PR opened', `${item.title}\n${res.pr_url}`)
          } else {
            const noChanges = (res as any).noChanges
            // a command that changed nothing isn't a failure — surface it as ready with the explanation.
            // cost lands on the item either way (a failed AI approve still spent real money)
            store.update(item.id, { status: noChanges ? 'ready' : 'failed', cost: item.cost + res.cost, reason: noChanges ? 'command ran but produced no changes' : 'apply/PR failed — see runs log' })
            log(`  → ${noChanges ? 'command: no changes' : 'approve failed'}`)
            if (!noChanges) notify(cfg, 'Resident: approve failed', item.title)
          }
        })()
        return Response.json({ ok: true })
      }

      return new Response('not found', { status: 404 })
    },
  })

  return { port: server.port, stop: () => server.stop(true) }
}
