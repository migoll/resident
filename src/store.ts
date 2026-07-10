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
  | 'deduped'       // represented by another active item with the same root cause

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
  /** Stable root-cause label supplied by the investigation. */
  dedupe_key: string | null
  /** Canonical item that represents this signal in the inbox. */
  duplicate_of: number | null
  /** Extra machine-readable target, currently used by authority proposals. */
  target_kind: string | null
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

export type AuthorityMode = 'shadow' | 'auto_pr' | 'auto_merge'
export interface Authority { repo: string; kind: string; mode: AuthorityMode; granted: number; updated: number }
export interface Trust { repo: string; kind: string; accepted: number; dismissed: number; merged: number; total: number; rate: number }
export interface Delivery { id: number; created: number; title: string; body: string; priority: string; status: string }

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
    archived INTEGER NOT NULL DEFAULT 0,
    dedupe_key TEXT,
    duplicate_of INTEGER,
    target_kind TEXT
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`)
  db.run(`CREATE TABLE IF NOT EXISTS repo_memory (
    repo TEXT PRIMARY KEY,
    notes TEXT NOT NULL,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS authorities (
    repo TEXT NOT NULL,
    kind TEXT NOT NULL,
    mode TEXT NOT NULL,
    granted INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    PRIMARY KEY (repo, kind)
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    priority TEXT NOT NULL,
    status TEXT NOT NULL
  )`)

  // migrations for DBs created before these columns existed (no-op on fresh DBs — duplicate-column throws and is swallowed)
  for (const stmt of [
    'ALTER TABLE items ADD COLUMN model TEXT',
    'ALTER TABLE items ADD COLUMN escalate INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE items ADD COLUMN command TEXT',
    'ALTER TABLE items ADD COLUMN archived INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE items ADD COLUMN dedupe_key TEXT',
    'ALTER TABLE items ADD COLUMN duplicate_of INTEGER',
    'ALTER TABLE items ADD COLUMN target_kind TEXT',
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
      title: string; detail: string; score: number; status: ItemStatus; reason?: string; target_kind?: string
    }): 'new' | 'existing' {
      const now = Date.now()
      const ex = db.query<any, any>('SELECT id, status FROM items WHERE hash = ?').get(f.hash)
      if (ex) {
        const promote = ex.status === 'ignored' && f.score >= INVESTIGATE_THRESHOLD
        // archived=0: a sense re-emitting the hash means the finding is back — retention must not hide a live problem
        db.run(
          'UPDATE items SET updated=?, title=?, detail=?, score=?, target_kind=COALESCE(?,target_kind), archived=0' + (promote ? ", status='queued', reason=NULL" : '') + ' WHERE id=?',
          [now, f.title, f.detail, f.score, f.target_kind ?? null, ex.id],
        )
        return 'existing'
      }
      db.run(
        `INSERT INTO items (created, updated, hash, sense, repo, kind, title, detail, score, status, reason, target_kind)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [now, now, f.hash, f.sense, f.repo, f.kind, f.title, f.detail, f.score, f.status, f.reason ?? null, f.target_kind ?? null],
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
      return db.query<Item, any>('SELECT * FROM items WHERE archived=0 AND duplicate_of IS NULL ORDER BY updated DESC LIMIT ?').all(limit)
    },

    byId(id: number): Item | null {
      return db.query<Item, any>('SELECT * FROM items WHERE id=?').get(id) ?? null
    },

    queued(limit: number): Item[] {
      return db
        .query<Item, any>("SELECT * FROM items WHERE status='queued' AND archived=0 AND duplicate_of IS NULL ORDER BY score DESC, updated DESC LIMIT ?")
        .all(limit)
    },

    /** Retention: hide items that settled into a terminal status more than `days` ago.
     *  Rows are flagged, never deleted — the db stays the audit trail. days <= 0 disables. */
    archiveOld(days: number): number {
      if (!days || days <= 0) return 0
      return db.run(
        "UPDATE items SET archived=1 WHERE archived=0 AND status IN ('merged','closed','dismissed','failed','ignored','deduped') AND updated < ?",
        [Date.now() - days * 86_400_000],
      ).changes
    },

    archivedCount(): number {
      return db.query<any, any>('SELECT COUNT(*) AS n FROM items WHERE archived=1').get()?.n ?? 0
    },

    /** Attach a completed investigation to an already-active canonical root cause, if one exists. */
    dedupe(itemId: number, repo: string, key: string): number | null {
      const clean = key.trim().toLowerCase().slice(0, 100)
      if (!clean) return null
      const canonical = db.query<any, any>(
        "SELECT id FROM items WHERE repo=? AND dedupe_key=? AND duplicate_of IS NULL AND status IN ('queued','investigating','ready','approving','approved') AND id<>? ORDER BY created ASC LIMIT 1",
      ).get(repo, clean, itemId)
      if (canonical) {
        db.run("UPDATE items SET dedupe_key=?, duplicate_of=?, status='deduped', reason=?, updated=? WHERE id=?", [clean, canonical.id, `same root cause as finding #${canonical.id}`, Date.now(), itemId])
        return canonical.id
      }
      db.run('UPDATE items SET dedupe_key=?, updated=? WHERE id=?', [clean, Date.now(), itemId])
      return null
    },

    duplicatesFor(itemId: number): Item[] {
      return db.query<Item, any>('SELECT * FROM items WHERE duplicate_of=? ORDER BY created ASC').all(itemId)
    },

    authority(repo: string, kind: string): AuthorityMode {
      return db.query<Authority, any>('SELECT * FROM authorities WHERE repo=? AND kind=?').get(repo, kind)?.mode ?? 'shadow'
    },

    authorities(): Authority[] {
      return db.query<Authority, any>("SELECT * FROM authorities WHERE mode<>'shadow' ORDER BY repo, kind").all()
    },

    setAuthority(repo: string, kind: string, mode: AuthorityMode) {
      const now = Date.now()
      db.run(
        `INSERT INTO authorities (repo,kind,mode,granted,updated) VALUES (?,?,?,?,?)
         ON CONFLICT(repo,kind) DO UPDATE SET mode=excluded.mode, updated=excluded.updated`,
        [repo, kind, mode, now, now],
      )
    },

    /** Human decisions on real proposed fixes: used to earn—not assume—authority. */
    trust(): Trust[] {
      const rows = db.query<any, any>(
        `SELECT repo, kind,
          SUM(CASE WHEN status IN ('approved','merged','closed') THEN 1 ELSE 0 END) AS accepted,
          SUM(CASE WHEN status='dismissed' THEN 1 ELSE 0 END) AS dismissed,
          SUM(CASE WHEN status='merged' THEN 1 ELSE 0 END) AS merged
         FROM items
         WHERE repo<>'' AND sense<>'autonomy' AND duplicate_of IS NULL AND (patch IS NOT NULL OR command IS NOT NULL)
           AND status IN ('approved','merged','closed','dismissed')
         GROUP BY repo, kind`,
      ).all()
      return rows.map((r) => {
        const accepted = Number(r.accepted), dismissed = Number(r.dismissed), merged = Number(r.merged)
        const total = accepted + dismissed
        return { repo: r.repo, kind: r.kind, accepted, dismissed, merged, total, rate: total ? accepted / total : 0 }
      })
    },

    recordDelivery(title: string, body: string, priority: string, status: 'pending' | 'sent' | 'silenced') {
      db.run('INSERT INTO deliveries (created,title,body,priority,status) VALUES (?,?,?,?,?)', [Date.now(), title, body, priority, status])
    },

    pendingDeliveries(limit = 30): Delivery[] {
      return db.query<Delivery, any>("SELECT * FROM deliveries WHERE status='pending' ORDER BY created ASC LIMIT ?").all(limit)
    },

    sendDeliveries(ids: number[]) {
      if (!ids.length) return
      db.run(`UPDATE deliveries SET status='sent' WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
    },

    pendingDeliveryCount(): number {
      return db.query<any, any>("SELECT COUNT(*) AS n FROM deliveries WHERE status='pending'").get()?.n ?? 0
    },

    outcomesSince(since: number): { merged: number; closed: number; autoPr: number } {
      const r = db.query<any, any>(
        `SELECT
          SUM(CASE WHEN status='merged' THEN 1 ELSE 0 END) AS merged,
          SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) AS closed,
          SUM(CASE WHEN reason LIKE 'auto-PR%' THEN 1 ELSE 0 END) AS autoPr
         FROM items WHERE updated>=?`,
      ).get(since) ?? {}
      return { merged: Number(r.merged ?? 0), closed: Number(r.closed ?? 0), autoPr: Number(r.autoPr ?? 0) }
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
  }
  return store
}

export type Store = ReturnType<typeof openStore>

function dayKey() {
  return new Date().toISOString().slice(0, 10)
}
