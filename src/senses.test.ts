import { describe, test, expect, mock, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as procReal from './proc'
import { gitSense, depsSense, githubSense, sentrySense, type Finding } from './senses'
import type { Config, RepoCfg } from './config'

// Every test file shares one process, so module mocks leak. Discipline: snapshot the real
// exports first, ALWAYS spread them into the mock (other files keep getting genuine functions),
// and hand the originals back in afterAll.
const PROC = { ...procReal }

type ProcResult = { ok: boolean; out: string; stdout: string }
let canned: Record<string, Partial<ProcResult>> = {}
let calls: { cmd: string[]; cwd?: string }[] = []
/** Arm the proc mock: keys are exact arg arrays joined with spaces; anything unlisted looks quiet. */
const sees = (map: Record<string, Partial<ProcResult>>) => { canned = map; calls = [] }

mock.module('./proc', () => ({
  ...PROC,
  run: async (cmd: string[], cwd?: string): Promise<ProcResult> => {
    calls.push({ cmd, cwd })
    return { ok: true, out: '', stdout: '', ...(canned[cmd.join(' ')] ?? {}) }
  },
}))
afterAll(() => mock.module('./proc', () => PROC))

const REPO: RepoCfg = { path: '/repos/r', name: 'r' }
const DAY = 86_400_000
const find = (fs: Finding[], kind: string) => fs.find((f) => f.kind === kind)

// ---------------------------------------------------------------- git sense
describe('gitSense', () => {
  test('uncommitted changes are counted, pluralized, scored 15', async () => {
    sees({ 'git status --porcelain': { out: ' M a.ts\n?? b.ts' } })
    const f = find(await gitSense(REPO), 'uncommitted')!
    expect(f.title).toBe('2 uncommitted changes sitting in the working tree')
    expect(f.score).toBe(15)
    sees({ 'git status --porcelain': { out: ' M a.ts' } })
    expect(find(await gitSense(REPO), 'uncommitted')!.title).toBe('1 uncommitted change sitting in the working tree')
  })
  test('a clean repo reports nothing at all', async () => {
    sees({})
    expect(await gitSense(REPO)).toEqual([])
  })
  test('stale branches: 21+ days old only, main/master never count', async () => {
    const old = Math.floor((Date.now() - 30 * DAY) / 1000)
    const fresh = Math.floor((Date.now() - 2 * DAY) / 1000)
    sees({
      'git for-each-ref refs/heads --format=%(refname:short)|%(committerdate:unix)': {
        out: `main|${old}\nmaster|${old}\nold-feature|${old}\nfresh-feature|${fresh}`,
      },
    })
    const f = find(await gitSense(REPO), 'stale-branches')!
    expect(f.title).toBe('1 branch untouched for 3+ weeks')
    expect(f.detail).toBe('old-feature')
    expect(f.score).toBe(20)
  })
  test('TODO/FIXME markers are counted from git grep', async () => {
    sees({ 'git grep -In -E TODO|FIXME|HACK': { out: 'a.ts:1:// TODO: x\nb.ts:9:// FIXME: y' } })
    const f = find(await gitSense(REPO), 'todos')!
    expect(f.title).toBe('2 TODO/FIXME markers in the code')
    expect(f.score).toBe(18)
  })
  test('pull: true refreshes the clone before judging it', async () => {
    sees({})
    await gitSense({ ...REPO, pull: true })
    expect(calls[0]).toEqual({ cmd: ['git', 'pull', '--ff-only', '--quiet'], cwd: REPO.path })
  })
  test('without pull configured, git pull is never attempted', async () => {
    sees({})
    await gitSense(REPO)
    expect(calls.some((c) => c.cmd[1] === 'pull')).toBe(false)
  })
})

// ---------------------------------------------------------------- deps sense
describe('depsSense', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'resident-deps-'))
  writeFileSync(join(repoDir, 'package.json'), '{}')
  const DEPS: RepoCfg = { path: repoDir, name: 'r' }
  const row = (pkg: string) => `│ ${pkg} │ 1.0.0 │ 1.0.1 │ 2.0.0 │`

  test('counts outdated table rows (the version-pair lines, not headers)', async () => {
    sees({ 'bun outdated': { out: ['│ Package │ Current │ Update │ Latest │', row('zod'), row('elysia')].join('\n') } })
    const f = find(await depsSense(DEPS), 'outdated')!
    expect(f.title).toBe('2 dependencies are behind')
    expect(f.score).toBe(28)
  })
  test('a single lagging dep reads singular', async () => {
    sees({ 'bun outdated': { out: row('zod') } })
    expect(find(await depsSense(DEPS), 'outdated')!.title).toBe('1 dependency is behind')
  })
  test('more than 10 behind raises the score to 40', async () => {
    sees({ 'bun outdated': { out: Array.from({ length: 11 }, (_, i) => row(`pkg${i}`)).join('\n') } })
    expect(find(await depsSense(DEPS), 'outdated')!.score).toBe(40)
  })
  test('audit severity drives the score: critical 85 / high 70 / moderate 45', async () => {
    sees({ 'bun audit': { ok: false, out: '5 vulnerabilities (1 critical, 2 high, 2 moderate)' } })
    const crit = find(await depsSense(DEPS), 'vulnerabilities')!
    expect(crit.score).toBe(85)
    expect(crit.title).toBe('Vulnerable dependencies: 1 critical, 2 high, 2 moderate')
    sees({ 'bun audit': { ok: false, out: '2 vulnerabilities (2 high)' } })
    expect(find(await depsSense(DEPS), 'vulnerabilities')!.score).toBe(70)
    sees({ 'bun audit': { ok: false, out: '1 moderate vulnerability' } })
    expect(find(await depsSense(DEPS), 'vulnerabilities')!.score).toBe(45)
  })
  test('a clean audit reports nothing', async () => {
    sees({ 'bun audit': { out: 'No vulnerabilities found' } })
    expect(await depsSense(DEPS)).toEqual([])
  })
  test('no package.json → no findings and no commands spawned', async () => {
    sees({ 'bun outdated': { out: row('zod') } })
    expect(await depsSense({ path: '/no/such/dir', name: 'r' })).toEqual([])
    expect(calls.length).toBe(0)
  })
})

// ---------------------------------------------------------------- github sense
describe('githubSense', () => {
  const PR_CMD = 'gh pr list --json number,title,mergeable,reviewDecision,statusCheckRollup --limit 15'
  const ISSUE_CMD = 'gh issue list --json number,title,createdAt --limit 10'
  const prJson = JSON.stringify([
    { number: 1, title: 'Red CI', mergeable: 'MERGEABLE', reviewDecision: '', statusCheckRollup: [{ state: 'FAILURE' }] },
    { number: 2, title: 'Tangled', mergeable: 'CONFLICTING', reviewDecision: '', statusCheckRollup: [] },
    { number: 3, title: 'Ship me', mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', statusCheckRollup: [] },
  ])
  const issueJson = JSON.stringify([
    { number: 9, title: 'Fresh bug', createdAt: new Date(Date.now() - 3_600_000).toISOString() },
    { number: 4, title: 'Old request', createdAt: new Date(Date.now() - 5 * DAY).toISOString() },
  ])
  const HAPPY = {
    'gh auth status': { out: 'Logged in to github.com' },
    'git remote get-url origin': { out: 'git@github.com:migoll/r.git', stdout: 'git@github.com:migoll/r.git' },
    // gh writes upgrade nags to stderr — they land in `out`, so JSON.parse MUST target `stdout`
    [PR_CMD]: { stdout: prJson, out: prJson + '\nA new release of gh is available: 2.0.0 → 3.0.0' },
    [ISSUE_CMD]: { stdout: issueJson, out: issueJson + '\nA new release of gh is available: 2.0.0 → 3.0.0' },
  }

  test('flags failing, conflicting and approved-but-unmerged PRs, plus fresh issues', async () => {
    sees(HAPPY)
    const fs = await githubSense(REPO)
    expect(fs.map((f) => [f.kind, f.score])).toEqual([
      ['pr-failing', 65], ['pr-conflict', 60], ['pr-approved', 55], ['new-issue', 50],
    ])
    expect(find(fs, 'pr-failing')!.title).toBe('PR #1 has failing checks — “Red CI”')
    expect(find(fs, 'new-issue')!.title).toBe('New issue #9: “Fresh bug”') // the 5-day-old issue is not news
  })
  test('gh auth is checked once, then cached for the process (module-level ghOk)', async () => {
    sees(HAPPY)
    await githubSense(REPO) // warms the cache whether or not an earlier test already did
    sees(HAPPY)
    await githubSense(REPO)
    expect(calls.map((c) => c.cmd.join(' '))).not.toContain('gh auth status')
  })
  test('non-github remotes are left alone', async () => {
    sees({ ...HAPPY, 'git remote get-url origin': { out: 'git@gitlab.com:x/y.git', stdout: 'git@gitlab.com:x/y.git' } })
    expect(await githubSense(REPO)).toEqual([])
  })
  test('gh auth failure → no findings (fresh module instance, since ghOk caches per process)', async () => {
    sees({ ...HAPPY, 'gh auth status': { ok: false, out: 'You are not logged into any GitHub hosts.' } })
    const fresh = await import('./senses.ts?gh-auth-fails') // its own ghOk, still null
    expect(await fresh.githubSense(REPO)).toEqual([])
    expect(calls.map((c) => c.cmd.join(' '))).toEqual(['gh auth status']) // bailed before any data calls
  })
})

// ---------------------------------------------------------------- sentry sense
describe('sentrySense', () => {
  const realFetch = globalThis.fetch
  afterAll(() => { globalThis.fetch = realFetch })
  let requests: { url: string; init?: RequestInit }[] = []
  const sentryReplies = (reply: () => Response) => {
    requests = []
    globalThis.fetch = (async (url: any, init?: any) => { requests.push({ url: String(url), init }); return reply() }) as any
  }
  const CFG: Config = {
    intervalMinutes: 15, budgets: { perCycle: 2, perDay: 10 }, urls: [],
    repos: [{ path: '/repos/pocketpane', name: 'PocketPane' }],
    sentry: { org: 'chrlnd', token: 'sntryu_test' },
  }
  const issue = (over: Record<string, unknown> = {}) => ({
    id: '101', title: 'TypeError: boom', level: 'error',
    firstSeen: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    project: { slug: 'pocketpane' }, shortId: 'POCKETPANE-1', count: '7', userCount: 3,
    permalink: 'https://chrlnd.sentry.io/issues/101/', ...over,
  })

  test('no sentry config → no findings, no network', async () => {
    sentryReplies(() => new Response('[]'))
    expect(await sentrySense({ ...CFG, sentry: undefined })).toEqual([])
    expect(requests.length).toBe(0)
  })
  test('a rejected token is BLINDNESS — one loud finding, never silence', async () => {
    for (const status of [401, 403]) {
      sentryReplies(() => new Response('', { status }))
      const fs = await sentrySense(CFG)
      expect(fs.length).toBe(1)
      expect(fs[0].kind).toBe('blind')
      expect(fs[0].score).toBe(70)
      expect(fs[0].repo).toBe('')
    }
  })
  test('issues map to findings; project slug ↔ repo name gives the dig a codebase', async () => {
    sentryReplies(() => Response.json([issue(), issue({ id: '102', project: { slug: 'unwatched-svc' }, title: 'Other' })]))
    const fs = await sentrySense(CFG)
    expect(requests[0].url).toContain('/api/0/organizations/chrlnd/issues/')
    expect((requests[0].init?.headers as any).authorization).toBe('Bearer sntryu_test')
    expect(fs.length).toBe(2)
    expect(fs[0].repo).toBe('PocketPane') // slug matched case-insensitively → the watched repo's name
    expect(fs[0].title).toBe('[pocketpane] TypeError: boom')
    expect(fs[0].score).toBe(82) // new error, per scoreSentryIssue
    expect(fs[0].detail).toContain('POCKETPANE-1')
    expect(fs[1].repo).toBe('') // nothing watched matches → repo-less finding
  })
  test('non-array payloads are ignored', async () => {
    sentryReplies(() => Response.json({ detail: 'rate limited' }))
    expect(await sentrySense(CFG)).toEqual([])
  })
  test('a fetch blow-up skips the cycle quietly (the next one retries)', async () => {
    sentryReplies(() => { throw new Error('ECONNRESET') })
    expect(await sentrySense(CFG)).toEqual([])
  })
})
