import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { HOME } from './config'

export type ItemStatus =
  | 'queued'        // worth investigating, waiting for budget
  | 'investigating' // claude session running
  | 'ready'         // investigated (or alert) — waiting for the human
  | 'failed'        // investigation/approval errored
  | 'ignored'       // seen, judged below threshold (visible for trust)
  | 'dismissed'     // human said no (restorable)
  | 'approving'     // applying patch / opening PR
  | 'approved'      // PR opened, not yet merged
  | 'working'       // opening issue
  | 'tracked'       // issue opened
  | 'merged'        // PR merged — outcome reached
  | 'closed'        // PR/issue closed, or alert resolved

export interface Item {
  id: number
  created: number
  updated: number
  hash: string
  sense: string
  repo: string
  kind: string
  title: string
  detail: string
  score: number
  status: ItemStatus
  evidence: string | null
  patch: string | null
  /** a shell command proposed as the fix instead of a diff (lockfile refresh, dep bump) */
  command: string | null
  pr_url: string | null
  cost: number
  reason: string | null
  /** model that investigated this item (recorded when the dig starts) */
  model: string | null
  /** 1 = next investigation should escalate to the strong model (set by Re-investigate) */
  escalate: number
  /** 1 = aged out by retention — hidden from every view, kept as the audit trail */
  archived: number
}

/** A human-editable, durable notebook for one watched repository. */
export interface RepoMemory {
  repo: string
  notes: string
  created: number
  updated: number
  /** Bumped on every write so the inbox can refuse a stale whole-notebook save. */
  revision: number
}

export const MAX_MEMORY_CHARS = 16_000

export interface Mute {
  repo: string // '' for repo-less kinds (uptime alerts)
  kind: string
  created: number
  source: 'auto' | 'manual'
}

export const INVESTIGATE_THRESHOLD = 55

/** Distinct dismissals of one (repo, kind) before Resident learns to stop asking. */
export const MUTE_THRESHOLD = 3

/** Kinds whose silence may never be EARNED, only explicitly chosen — and 'blind' not even that.
 *  Three routine dismissals must not be able to disarm the 2am alarm: hard outages ('down') and
 *  fatal prod errors ('fatal') only go quiet when the human says so deliberately (/api/mute). */
export const NEVER_AUTO_MUTE = new Set(['blind', 'down', 'fatal'])

/** Open the item store. `dbPath` exists for tests (`:memory:`); production always uses the default. */
export function openStore(dbPath?: string) {
  if (!dbPath) mkdirSync(HOME, { recursive: true })
  const db = new Database(dbPath ?? join(HOME, 'resident.db'))
  // a second connection (resident doctor, a future CLI) probing while the daemon is mid-write
  // must wait briefly, not throw SQLITE_BUSY — a healthy db must never look broken
  db.run('PRAGMA busy_timeout = 2000')
  db.run(`CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    hash TEXT UNIQUE NOT NULL,
    sense TEXT NOT NULL,
    repo TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    score INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    evidence TEXT,
    patch TEXT,
    pr_url TEXT,
    cost REAL NOT NULL DEFAULT 0,
    reason TEXT,
    model TEXT,
    escalate INTEGER NOT NULL DEFAULT 0,
    command TEXT,
    archived INTEGER NOT NULL DEFAULT 0
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`)
  db.run(`CREATE TABLE IF NOT EXISTS repo_memory (
    repo TEXT PRIMARY KEY,
    notes TEXT NOT NULL,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS mutes (
    repo TEXT NOT NULL,
    kind TEXT NOT NULL,
    created INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'auto',
    PRIMARY KEY (repo, kind)
  )`)

  // migrations for DBs created before these columns existed (no-op on fresh DBs — duplicate-column throws and is swallowed)
  for (const stmt of [
    'ALTER TABLE items ADD COLUMN model TEXT',
    'ALTER TABLE items ADD COLUMN escalate INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE items ADD COLUMN command TEXT',
    'ALTER TABLE items ADD COLUMN archived INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE repo_memory ADD COLUMN revision INTEGER NOT NULL DEFAULT 1',
  ]) {
    try { db.run(stmt) } catch {}
  }

  const store = {
    db,

    /** Insert a finding (deduped by hash). Existing items get refreshed
     *  title/detail/score; ignored items get promoted if they now score high. */
    upsertFinding(f: {
      hash: string; sense: string; repo: string; kind: string
      title: string; detail: string; score: number; status: ItemStatus; reason?: string
    }, muted = false): 'new' | 'existing' {
      const now = Date.now()
      const ex = db.query<any, any>('SELECT id, status FROM items WHERE hash = ?').get(f.hash)
      if (ex) {
        // archived=0: a sense re-emitting the hash means the finding is back — retention must not hide a live problem
        // a muted kind never earns its way back to queued on score alone — that's what unmute is for
        const promote = !muted && ex.status === 'ignored' && f.score >= INVESTIGATE_THRESHOLD
        const sets = ['updated=?', 'title=?', 'detail=?', 'score=?', 'archived=0']
        const params: any[] = [now, f.title, f.detail, f.score]
        if (promote) sets.push("status='queued'", 'reason=NULL')
        // keep a muted item's stated reason honest — "below threshold" would be a lie once the
        // score rises and only the mute is holding it down
        else if (muted && ex.status === 'ignored') { sets.push('reason=?'); params.push(f.reason ?? null) }
        db.run(`UPDATE items SET ${sets.join(', ')} WHERE id=?`, [...params, ex.id])
        return 'existing'
      }
      db.run(
        `INSERT INTO items (created, updated, hash, sense, repo, kind, title, detail, score, status, reason)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [now, now, f.hash, f.sense, f.repo, f.kind, f.title, f.detail, f.score, f.status, f.reason ?? null],
      )
      return 'new'
    },

    update(id: number, fields: Partial<Item>) {
      const keys = Object.keys(fields)
      if (!keys.length) return
      const sets = keys.map((k) => `${k}=?`).join(', ')
      db.run(`UPDATE items SET ${sets}, updated=? WHERE id=?`, [...keys.map((k) => (fields as any)[k]), Date.now(), id])
    },

    items(limit = 200): Item[] {
      return db.query<Item, any>('SELECT * FROM items WHERE archived=0 ORDER BY updated DESC LIMIT ?').all(limit)
    },

    byId(id: number): Item | null {
      return db.query<Item, any>('SELECT * FROM items WHERE id=?').get(id) ?? null
    },

    queued(limit: number): Item[] {
      return db
        .query<Item, any>("SELECT * FROM items WHERE status='queued' AND archived=0 ORDER BY score DESC, updated DESC LIMIT ?")
        .all(limit)
    },

    /** Retention: hide items that settled into a terminal status more than `days` ago.
     *  Rows are flagged, never deleted — the db stays the audit trail. days <= 0 disables. */
    archiveOld(days: number): number {
      if (!days || days <= 0) return 0
      return db.run(
        "UPDATE items SET archived=1 WHERE archived=0 AND status IN ('merged','closed','dismissed','failed','ignored') AND updated < ?",
        [Date.now() - days * 86_400_000],
      ).changes
    },

    archivedCount(): number {
      return db.query<any, any>('SELECT COUNT(*) AS n FROM items WHERE archived=1').get()?.n ?? 0
    },

    /** The repository notebook. Empty means no saved memory yet. */
    memory(repo: string): RepoMemory | null {
      return db.query<RepoMemory, any>('SELECT * FROM repo_memory WHERE repo=?').get(repo) ?? null
    },

    memories(): RepoMemory[] {
      return db.query<RepoMemory, any>('SELECT * FROM repo_memory ORDER BY repo').all()
    },

    /** Replace a repository notebook from the inbox. An empty notebook is removed. */
    setMemory(repo: string, notes: string): boolean {
      const clean = notes.trim()
      if (clean.length > MAX_MEMORY_CHARS) return false
      if (!clean) {
        db.run('DELETE FROM repo_memory WHERE repo=?', [repo])
        return true
      }
      const now = Date.now()
      db.run(
        `INSERT INTO repo_memory (repo,notes,created,updated) VALUES (?,?,?,?)
         ON CONFLICT(repo) DO UPDATE SET notes=excluded.notes, updated=excluded.updated,
           revision=repo_memory.revision+1`,
        [repo, clean, now, now],
      )
      return true
    },

    /** Save a human edit only if the notebook is still the version the inbox rendered.
     * This prevents a stale textarea from replacing an investigation learning that arrived while it was open. */
    saveMemory(repo: string, notes: string, expectedRevision: number | null): 'saved' | 'conflict' | 'too_large' {
      if (notes.trim().length > MAX_MEMORY_CHARS) return 'too_large'
      const current = store.memory(repo)
      if ((current?.revision ?? null) !== expectedRevision) return 'conflict'
      return store.setMemory(repo, notes) ? 'saved' : 'too_large'
    },

    /** Keep an investigation's concise learning separate from human-authored notes. */
    appendMemory(repo: string, learning: string): boolean {
      const clean = learning.trim()
      if (!clean) return true
      const previous = store.memory(repo)?.notes
      const entry = `### ${new Date().toISOString().slice(0, 10)} · Resident investigation\n${clean}`
      const next = previous ? `${previous}\n\n${entry}` : entry
      return store.setMemory(repo, next)
    },

    metaGet(key: string): string | null {
      return db.query<any, any>('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null
    },
    metaSet(key: string, value: string) {
      db.run('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, value])
    },

    /** investigations started today (budget accounting) */
    usedToday(): number {
      return Number(store.metaGet('inv:' + dayKey()) ?? 0)
    },
    bumpToday() {
      store.metaSet('inv:' + dayKey(), String(store.usedToday() + 1))
    },
    costToday(): number {
      return Number(store.metaGet('cost:' + dayKey()) ?? 0)
    },
    addCost(c: number) {
      store.metaSet('cost:' + dayKey(), String(store.costToday() + c))
    },

    /** Learned silences, oldest first (chips render in the order they were earned). */
    mutes(): Mute[] {
      return db.query<Mute, any>('SELECT * FROM mutes ORDER BY created ASC, kind ASC').all()
    },

    isMuted(repo: string, kind: string): boolean {
      return !!db.query<any, any>('SELECT 1 FROM mutes WHERE repo=? AND kind=?').get(repo, kind)
    },

    /** False (and nothing stored) for 'blind' — blindness is never mutable, by anyone, from any
     *  path. Enforced here at the store boundary so no caller can forget the rule. */
    addMute(repo: string, kind: string, source: Mute['source']): boolean {
      if (kind === 'blind') return false
      db.run('INSERT INTO mutes (repo, kind, created, source) VALUES (?,?,?,?) ON CONFLICT(repo, kind) DO NOTHING', [repo, kind, Date.now(), source])
      return true
    },

    /** Unmute + remember WHEN — only dismissals after this moment count toward re-muting,
     *  so "I changed my mind" isn't instantly overruled by the old evidence. */
    removeMute(repo: string, kind: string) {
      db.run('DELETE FROM mutes WHERE repo=? AND kind=?', [repo, kind])
      // un-lie the leftovers: ignored items still wearing a "muted" reason would point at a mute
      // that no longer exists; the next cycle re-states the honest reason (or promotes outright)
      db.run("UPDATE items SET reason=NULL, updated=? WHERE repo=? AND kind=? AND status='ignored' AND reason LIKE 'muted%'", [Date.now(), repo, kind])
      store.metaSet(`unmuted:${repo}|${kind}`, String(Date.now()))
    },

    /** How many findings a mute is currently holding down (ignored rows wearing its reason) —
     *  an active suppression must be visible at a glance, not discoverable by archaeology. */
    mutedHolding(repo: string, kind: string): number {
      return db.query<any, any>("SELECT COUNT(*) n FROM items WHERE repo=? AND kind=? AND status='ignored' AND reason LIKE 'muted%'").get(repo, kind)?.n ?? 0
    },

    /** Distinct findings of this (repo, kind) currently dismissed, counted since the last unmute. */
    dismissCount(repo: string, kind: string): number {
      const since = Number(store.metaGet(`unmuted:${repo}|${kind}`) ?? 0)
      return db.query<any, any>("SELECT COUNT(*) n FROM items WHERE repo=? AND kind=? AND status='dismissed' AND updated>?").get(repo, kind, since)?.n ?? 0
    },

    /** Called on every human dismissal: the MUTE_THRESHOLDth distinct "no" on a (repo, kind)
     *  earns a mute — except the sacred kinds (NEVER_AUTO_MUTE) and self-sense findings, where
     *  routine dismissals must never accumulate into silence. */
    maybeAutoMute(repo: string, kind: string, sense: string): boolean {
      if (sense === 'self' || NEVER_AUTO_MUTE.has(kind)) return false
      if (store.isMuted(repo, kind)) return false
      if (store.dismissCount(repo, kind) < MUTE_THRESHOLD) return false
      return store.addMute(repo, kind, 'auto')
    },
  }
  return store
}

export type Store = ReturnType<typeof openStore>

function dayKey() {
  return new Date().toISOString().slice(0, 10)
}
