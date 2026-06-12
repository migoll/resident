import { describe, test, expect, mock, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { CONFIG_PATH, type Config } from './config'
import { openStore } from './store'
import { startServer } from './server'
import type { DaemonState } from './daemon'
import type { Item, ItemStatus } from './store'

const allowedRepo = mkdtempSync(join(tmpdir(), 'resident-srv-allowed-'))
const bareRepo = mkdtempSync(join(tmpdir(), 'resident-srv-bare-'))
const cfg: Config = {
  intervalMinutes: 15, budgets: { perCycle: 2, perDay: 10 },
  urls: ['https://watched.example'],
  repos: [
    { path: allowedRepo, name: 'allowed', commands: ['bun update'] },
    { path: bareRepo, name: 'bare' },
  ],
}
const store = openStore(':memory:')
const state: DaemonState = { nextCycleAt: 0, cycling: false, lastCycle: null }
const requestCycle = mock(() => {})

let srv: { port: number; stop: () => void } | undefined
let base = ''
beforeAll(() => {
  // these tests WRITE config.json through the real saveConfig() — refuse to run at all unless
  // the preload (src/test-setup.ts) pointed the state dir at a throwaway RESIDENT_HOME
  const tmp = process.env.RESIDENT_HOME
  if (!tmp || !CONFIG_PATH.startsWith(tmp) || CONFIG_PATH.startsWith(join(homedir(), '.resident')))
    throw new Error(`RESIDENT_HOME override not in effect (CONFIG_PATH=${CONFIG_PATH}) — refusing to touch config`)

  // startServer takes its port from the PORT env; a few random high ports dodge collisions
  let err: unknown
  for (let i = 0; i < 5 && !srv; i++) {
    process.env.PORT = String(20000 + Math.floor(Math.random() * 30000))
    try { srv = startServer({ cfg, store, state, requestCycle, log: () => {} }) } catch (e) { err = e }
  }
  if (!srv) throw err
  base = `http://127.0.0.1:${srv.port}`
})
afterAll(() => { srv?.stop(); delete process.env.PORT })

let seq = 0
/** Insert an item the way a cycle would, then layer on the fields only updates can set. */
function seed(over: Partial<Item> & { status?: ItemStatus } = {}): Item {
  const hash = `srv-${++seq}`
  const { command, evidence, patch, status, ...basics } = over
  store.upsertFinding({ hash, sense: 'git', repo: 'allowed', kind: 'k', title: `item ${seq}`, detail: 'd', score: 60, status: status ?? 'ready', ...basics })
  const it = store.items(300).find((i) => i.hash === hash)!
  const extra: Partial<Item> = {}
  if (command !== undefined) extra.command = command
  if (evidence !== undefined) extra.evidence = evidence
  if (patch !== undefined) extra.patch = patch
  if (Object.keys(extra).length) store.update(it.id, extra)
  return store.byId(it.id)!
}
const post = (path: string, body?: unknown) =>
  fetch(base + path, { method: 'POST', body: typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body) })

// ---------------------------------------------------------------- the face
describe('GET /', () => {
  test('serves the inbox html', async () => {
    const res = await fetch(base + '/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('<!doctype html>')
  })
  test('unknown paths 404', async () => {
    expect((await fetch(base + '/nope')).status).toBe(404)
  })
})

// ---------------------------------------------------------------- state
describe('GET /api/state', () => {
  test('reports budgets, watchlist and items — with commandAllowed resolved server-side', async () => {
    const runnable = seed({ command: 'bun update zod' }) // repo "allowed" allowlists "bun update"
    const blocked = seed({ repo: 'bare', command: 'bun update zod' }) // repo "bare" allowlists nothing
    const plain = seed({})
    const st = await (await fetch(base + '/api/state')).json()
    expect(st.budgets).toEqual({ perCycle: 2, perDay: 10 })
    expect(st.watching).toEqual({ repos: ['allowed', 'bare'], urls: ['https://watched.example'] })
    const by = (id: number) => st.items.find((i: any) => i.id === id)
    expect(by(runnable.id).commandAllowed).toBe(true)
    expect(by(blocked.id).commandAllowed).toBe(false)
    expect('commandAllowed' in by(plain.id)).toBe(false) // only command-fix items carry the flag
  })
})

// ---------------------------------------------------------------- watchlist editing
describe('POST /api/watch', () => {
  let gitRepoName = ''

  test('adding a url writes config INSIDE the throwaway RESIDENT_HOME — never the real ~/.resident', async () => {
    requestCycle.mockClear()
    const res = await post('/api/watch', { add: 'https://example.com' })
    expect(res.status).toBe(200)
    expect(cfg.urls).toContain('https://example.com')
    expect(requestCycle).toHaveBeenCalled()
    const onDisk = join(process.env.RESIDENT_HOME!, 'config.json')
    expect(CONFIG_PATH).toBe(onDisk) // the override held — this is the test that keeps the user's config safe
    expect(existsSync(onDisk)).toBe(true)
    expect(JSON.parse(readFileSync(onDisk, 'utf8')).urls).toContain('https://example.com')
  })
  test('duplicate url → 400', async () => {
    expect((await post('/api/watch', { add: 'https://example.com' })).status).toBe(400)
  })
  test('a git repo path is added by basename and persisted', async () => {
    const gitDir = mkdtempSync(join(tmpdir(), 'resident-srv-git-'))
    Bun.spawnSync(['git', 'init'], { cwd: gitDir })
    const res = await post('/api/watch', { add: gitDir })
    expect(res.status).toBe(200)
    gitRepoName = basename(gitDir)
    expect(cfg.repos.map((r) => r.name)).toContain(gitRepoName)
    expect(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).repos.map((r: any) => r.name)).toContain(gitRepoName)
  })
  test('a plain folder is rejected — only git repos are watchable', async () => {
    const plainDir = mkdtempSync(join(tmpdir(), 'resident-srv-plain-'))
    const res = await post('/api/watch', { add: plainDir })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('not a git repo')
  })
  test('remove drops repos by name and urls by value', async () => {
    expect((await post('/api/watch', { remove: gitRepoName })).status).toBe(200)
    expect(cfg.repos.map((r) => r.name)).not.toContain(gitRepoName)
    expect((await post('/api/watch', { remove: 'https://example.com' })).status).toBe(200)
    expect(cfg.urls).not.toContain('https://example.com')
  })
  test('unknown remove → 404, bad json → 400, neither add nor remove → 400', async () => {
    expect((await post('/api/watch', { remove: 'never-watched' })).status).toBe(404)
    expect((await post('/api/watch', 'not json')).status).toBe(400)
    expect((await post('/api/watch', {})).status).toBe(400)
  })
})

// ---------------------------------------------------------------- item actions
// NB: the approve/issue HAPPY paths are deliberately not driven — they spawn claude/gh for real.
describe('item actions', () => {
  test('dismiss parks the item', async () => {
    const it = seed({})
    expect((await post(`/api/item/${it.id}/dismiss`)).status).toBe(200)
    expect(store.byId(it.id)!.status).toBe('dismissed')
  })
  test('restore with evidence goes straight back to ready', async () => {
    const it = seed({ status: 'dismissed', evidence: 'kept' })
    requestCycle.mockClear()
    await post(`/api/item/${it.id}/restore`)
    expect(store.byId(it.id)!.status).toBe('ready')
    expect(store.byId(it.id)!.reason).toBe('restored by you')
    expect(requestCycle).not.toHaveBeenCalled() // nothing to dig — no cycle needed
  })
  test('restore without evidence requeues and pokes the daemon', async () => {
    const it = seed({ status: 'dismissed' })
    requestCycle.mockClear()
    await post(`/api/item/${it.id}/restore`)
    expect(store.byId(it.id)!.status).toBe('queued')
    expect(requestCycle).toHaveBeenCalledTimes(1)
  })
  test('reinvestigate clears the stale proposal and escalates', async () => {
    const it = seed({ evidence: 'old', patch: 'old diff', command: 'bun update zod' })
    await post(`/api/item/${it.id}/reinvestigate`)
    const after = store.byId(it.id)!
    expect(after.status).toBe('queued')
    expect(after.evidence).toBeNull()
    expect(after.patch).toBeNull()
    expect(after.command).toBeNull()
    expect(after.escalate).toBe(1)
  })
  test('approve guards: missing item 404, unknown repo 400, no fix 400, un-allowlisted command 400', async () => {
    expect((await post('/api/item/424242/approve')).status).toBe(404)

    const ghost = seed({ repo: 'ghost', patch: 'a diff' })
    const r1 = await post(`/api/item/${ghost.id}/approve`)
    expect(r1.status).toBe(400)
    expect((await r1.json()).error).toBe('unknown repo')

    const nofix = seed({})
    const r2 = await post(`/api/item/${nofix.id}/approve`)
    expect(r2.status).toBe(400)
    expect((await r2.json()).error).toBe('no fix to apply')

    const blocked = seed({ repo: 'bare', command: 'bun update zod' })
    const r3 = await post(`/api/item/${blocked.id}/approve`)
    expect(r3.status).toBe(400)
    expect((await r3.json()).error).toContain("not in bare's allowlist")

    // every guard fired BEFORE the status flip — nothing ever started applying
    for (const it of [ghost, nofix, blocked]) expect(store.byId(it.id)!.status).toBe('ready')
  })
})
