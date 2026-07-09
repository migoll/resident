import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sensesReal from './senses'
import * as handsReal from './hands'
import { cycle } from './daemon'
import { openStore, type Store } from './store'
import type { Finding } from './senses'
import type { Config } from './config'

// Same mock discipline as senses.test.ts (one shared process): snapshot the real exports,
// spread them into the mock so every other file keeps the genuine functions, restore in afterAll.
const SENSES = { ...sensesReal }
const HANDS = { ...handsReal }

let sensed: Finding[] = []
const investigate = mock(async (_item: any, _repoPath: string, _model?: string) =>
  ({ ok: true, evidence: 'dug', patch: null as string | null, command: null as string | null, cost: 0, costEstimated: undefined as boolean | undefined }))

mock.module('./senses', () => ({ ...SENSES, runSenses: async () => sensed }))
mock.module('./hands', () => ({ ...HANDS, investigate }))
afterAll(() => {
  mock.module('./senses', () => SENSES)
  mock.module('./hands', () => HANDS)
})

const repoDir = mkdtempSync(join(tmpdir(), 'resident-triage-')) // readable, so blindnessCheck stays calm
const CFG: Config = { intervalMinutes: 15, budgets: { perCycle: 2, perDay: 10 }, urls: [], repos: [{ path: repoDir, name: 'r' }] }
const noLog = () => {}
const finding = (over: Partial<Finding> = {}): Finding =>
  ({ sense: 'git', repo: 'r', kind: 'k', title: 't', detail: 'd', score: 60, hash: 'h1', ...over })
const byHash = (s: Store, hash: string) => s.items(50).find((i) => i.hash === hash)!

beforeEach(() => investigate.mockClear())

// ---------------------------------------------------------------- triage
describe('cycle: triage', () => {
  test('scores at the threshold queue; below is ignored WITH its reason (visible judgment)', async () => {
    const s = openStore(':memory:')
    sensed = [finding({ hash: 'hot', score: 55 }), finding({ hash: 'cold', score: 54 })]
    const sum = await cycle(CFG, s, noLog, { maxInvestigations: 0 })
    expect(sum).toEqual({ findings: 2, new: 2, investigated: 0 })
    expect(byHash(s, 'hot').status).toBe('queued')
    expect(byHash(s, 'cold').status).toBe('ignored')
    expect(byHash(s, 'cold').reason).toBe('below threshold (score 54)')
  })
  test('re-sensing hotter promotes an ignored item to queued', async () => {
    const s = openStore(':memory:')
    sensed = [finding({ score: 40 })]
    await cycle(CFG, s, noLog, { maxInvestigations: 0 })
    expect(byHash(s, 'h1').status).toBe('ignored')
    sensed = [finding({ score: 70 })]
    await cycle(CFG, s, noLog, { maxInvestigations: 0 })
    expect(byHash(s, 'h1').status).toBe('queued')
    expect(byHash(s, 'h1').reason).toBeNull() // the stale below-threshold reason is gone
  })
  test('maxInvestigations: 0 spends nothing — queued items stay queued', async () => {
    const s = openStore(':memory:')
    sensed = [finding({ score: 90 })]
    await cycle(CFG, s, noLog, { maxInvestigations: 0 })
    expect(investigate).not.toHaveBeenCalled()
    expect(byHash(s, 'h1').status).toBe('queued')
    expect(s.usedToday()).toBe(0)
  })
})

// ---------------------------------------------------------------- investigation budget
describe('cycle: investigations', () => {
  test('a successful dig lands ready, pays the ledger, and consumes the escalation', async () => {
    const s = openStore(':memory:')
    sensed = [finding()]
    await cycle(CFG, s, noLog, { maxInvestigations: 0 }) // queue it first
    s.update(byHash(s, 'h1').id, { escalate: 1 }) // as Re-investigate would
    investigate.mockResolvedValueOnce({ ok: true, evidence: 'root cause', patch: 'a diff', command: null, cost: 0.42, costEstimated: undefined })
    sensed = []
    const sum = await cycle(CFG, s, noLog, { maxInvestigations: 1 })
    expect(sum.investigated).toBe(1)
    const it = byHash(s, 'h1')
    expect(it.status).toBe('ready')
    expect(it.evidence).toBe('root cause')
    expect(it.patch).toBe('a diff')
    expect(it.cost).toBe(0.42)
    expect(it.escalate).toBe(0) // consumed on success, not at dig start
    expect(it.model).toBe('opus') // escalate=1 routed the dig to the strong tier
    expect(investigate.mock.calls[0][0].hash).toBe('h1')
    expect(investigate.mock.calls[0][1]).toBe(repoDir)
    expect(investigate.mock.calls[0][2]).toBe('opus')
    expect(s.usedToday()).toBe(1)
    expect(s.costToday()).toBeCloseTo(0.42)
  })
  test('a killed dig fails with the cost-estimate phrasing and still pays the ledger', async () => {
    const s = openStore(':memory:')
    sensed = [finding()]
    investigate.mockResolvedValueOnce({ ok: false, evidence: 'partial transcript', patch: null, command: null, cost: 1.23, costEstimated: true })
    await cycle(CFG, s, noLog, { maxInvestigations: 1 })
    const it = byHash(s, 'h1')
    expect(it.status).toBe('failed')
    expect(it.reason).toBe('investigation killed — est. $1.23 spent before final accounting')
    expect(s.costToday()).toBeCloseTo(1.23)
    expect(s.usedToday()).toBe(1) // the attempt consumed budget even though it died
  })
  test('repo-less alerts surface as ready without an investigation or budget spend', async () => {
    const s = openStore(':memory:')
    sensed = [finding({ repo: '', sense: 'uptime', kind: 'down', score: 95 })]
    await cycle({ ...CFG, repos: [] }, s, noLog, { maxInvestigations: 1 })
    const it = byHash(s, 'h1')
    expect(it.status).toBe('ready')
    expect(it.reason).toBe('alert — no local repo to investigate')
    expect(investigate).not.toHaveBeenCalled()
    expect(s.usedToday()).toBe(0)
  })
})
