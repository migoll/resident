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
  pr_url: string | null
  cost: number
  reason: string | null
}

export const INVESTIGATE_THRESHOLD = 55

export function openStore() {
  mkdirSync(HOME, { recursive: true })
  const db = new Database(join(HOME, 'resident.db'))
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
    reason TEXT
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`)

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
        db.run(
          'UPDATE items SET updated=?, title=?, detail=?, score=?' + (promote ? ", status='queued', reason=NULL" : '') + ' WHERE id=?',
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
      return db.query<Item, any>('SELECT * FROM items ORDER BY updated DESC LIMIT ?').all(limit)
    },

    byId(id: number): Item | null {
      return db.query<Item, any>('SELECT * FROM items WHERE id=?').get(id) ?? null
    },

    queued(limit: number): Item[] {
      return db
        .query<Item, any>("SELECT * FROM items WHERE status='queued' ORDER BY score DESC, updated DESC LIMIT ?")
        .all(limit)
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
