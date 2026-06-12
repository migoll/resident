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

export const INVESTIGATE_THRESHOLD = 55

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

  // migrations for DBs created before these columns existed (no-op on fresh DBs — duplicate-column throws and is swallowed)
  for (const stmt of [
    'ALTER TABLE items ADD COLUMN model TEXT',
    'ALTER TABLE items ADD COLUMN escalate INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE items ADD COLUMN command TEXT',
    'ALTER TABLE items ADD COLUMN archived INTEGER NOT NULL DEFAULT 0',
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
    }): 'new' | 'existing' {
      const now = Date.now()
      const ex = db.query<any, any>('SELECT id, status FROM items WHERE hash = ?').get(f.hash)
      if (ex) {
        const promote = ex.status === 'ignored' && f.score >= INVESTIGATE_THRESHOLD
        // archived=0: a sense re-emitting the hash means the finding is back — retention must not hide a live problem
        db.run(
          'UPDATE items SET updated=?, title=?, detail=?, score=?, archived=0' + (promote ? ", status='queued', reason=NULL" : '') + ' WHERE id=?',
          [now, f.title, f.detail, f.score, ex.id],
        )
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
  }
  return store
}

export type Store = ReturnType<typeof openStore>

function dayKey() {
  return new Date().toISOString().slice(0, 10)
}
