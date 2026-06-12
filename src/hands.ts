import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOME } from './config'
import { run } from './proc'
import type { Item } from './store'

/** Read-only toolset for shadow-mode investigations. */
const READONLY_TOOLS = [
  'Read', 'Glob', 'Grep',
  'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git blame:*)',
  'Bash(git status:*)', 'Bash(git branch:*)',
  'Bash(gh pr view:*)', 'Bash(gh pr checks:*)', 'Bash(gh pr diff:*)',
  'Bash(gh issue view:*)', 'Bash(gh run view:*)',
  'Bash(bun outdated:*)', 'Bash(bun audit:*)',
]

/** Write-enabled toolset, used only when a human clicks Approve. */
const APPLY_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash(git:*)', 'Bash(gh pr create:*)', 'Bash(gh pr view:*)', 'Bash(bun install:*)', 'Bash(bun run:*)',
]

interface ClaudeResult { ok: boolean; text: string; cost: number; costEstimated?: boolean }

/** Rough $/min by tier — used ONLY when a run dies before emitting its final-cost JSON (timeout/kill/crash),
 *  so spent-but-unrecorded runs don't read as free in the budget ledger. Ratios track published per-token
 *  pricing (fable:opus:sonnet:haiku ≈ 10:5:3:1); the absolute rate is a deliberately conservative wall-clock
 *  heuristic, and unknown models fall back to the fable rate so the ledger errs toward over-counting, never
 *  under. Exported for tests. */
export function estimateCost(model: string | undefined, ms: number): number {
  const m = (model ?? '').toLowerCase()
  const perMin = m.includes('haiku') ? 0.15 : m.includes('sonnet') ? 0.45 : m.includes('opus') ? 0.75 : 1.5
  return +((perMin * Math.max(0, ms)) / 60_000).toFixed(2)
}

async function runClaude(prompt: string, cwd: string, tools: string[], model?: string, timeoutMs = 600_000, extraArgs: string[] = []): Promise<ClaudeResult> {
  const args = ['claude', '-p', prompt, '--output-format', 'json', '--allowedTools', ...tools, ...extraArgs]
  if (model) args.push('--model', model)
  const t0 = Date.now()
  const r = await run(args, cwd, timeoutMs)
  try {
    const j = JSON.parse(r.stdout)
    return { ok: r.ok && !j.is_error, text: j.result ?? r.stdout, cost: Number(j.total_cost_usd ?? 0) }
  } catch {
    // no final JSON → killed / timed-out / crashed mid-run; estimate spend from wall-clock
    return { ok: false, text: r.out.slice(0, 8000), cost: estimateCost(model, Date.now() - t0), costEstimated: true }
  }
}

function extractDiff(text: string): string | null {
  const m = text.match(/```diff\n([\s\S]*?)```/)
  return m ? m[1].trimEnd() : null
}

/** Pull durable write-back notes out of an investigation's NOTES FOR NEXT TIME section.
 *  Strict: only bullet/numbered lines count (prose and "none" are not memories), 3 max,
 *  each clipped — memory is injected into every future dig, so it must stay terse. */
export function extractNotes(text: string): string[] {
  const m = text.match(/## NOTES FOR NEXT TIME\s*\n([\s\S]*?)(?=\n## |$)/)
  if (!m) return []
  return m[1]
    .split('\n')
    .filter((l) => /^\s*(?:[-*•]|\d+\.)\s+/.test(l))
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+\.)\s+/, '').trim())
    .filter((l) => l && !/^none\.?$/i.test(l))
    .slice(0, 3)
    .map((l) => l.slice(0, 300))
}

/** Exported for tests. */
export function extractCommand(text: string): string | null {
  const m = text.match(/```(?:sh|bash|shell)\n([\s\S]*?)```/)
  if (!m) return null
  // real command lines, stripping "$ " prompts and comment/blank lines
  const lines = m[1].split('\n').map((s) => s.replace(/^\$\s*/, '').trim()).filter((s) => s && !s.startsWith('#'))
  // the contract is ONE command — if the model stacked several, refuse to extract rather than
  // silently run a subset of what the evidence shows
  return lines.length === 1 ? lines[0] : null
}

/** Best-effort default base ref for a new branch: origin's default → origin/main|master → current local branch. */
async function defaultBase(repoPath: string, hasRemote: boolean): Promise<string> {
  if (hasRemote) {
    const h = await run(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoPath)
    if (h.ok && h.stdout) return h.stdout
    for (const b of ['origin/main', 'origin/master'])
      if ((await run(['git', 'rev-parse', '--verify', '--quiet', b], repoPath)).ok) return b
  }
  const cur = await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
  return cur.ok && cur.stdout && cur.stdout !== 'HEAD' ? cur.stdout : 'HEAD'
}

function saveTranscript(id: number, kind: string, text: string) {
  try {
    const dir = join(HOME, 'runs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}-${kind}.md`), text)
  } catch {}
}

/** Deterministic branch name for an item — also used by restart reconciliation. */
export function branchFor(item: Pick<Item, 'id' | 'title'>) {
  const slug = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  return `resident/${item.id}-${slug}`
}

/** What the dig is told about prior work on this repo. Newest notes first, hard char cap —
 *  memory rides along on EVERY investigation, so it pays prompt cost every time. */
function memoryBlock(memories: string[], cap = 2500): string {
  if (!memories.length) return ''
  const lines: string[] = []
  let used = 0
  for (const m of memories) {
    if (used + m.length > cap) break
    lines.push(`- ${m}`)
    used += m.length
  }
  if (!lines.length) return ''
  return `
DURABLE NOTES from prior work on this repo (written by earlier investigations and the human — trust them; they encode conventions, known false positives, and approaches that already failed):
${lines.join('\n')}
`
}

/** Shadow-mode investigation: read-only dig, returns evidence + proposed patch. */
export async function investigate(item: Item, repoPath: string, model?: string, memories: string[] = []) {
  const prompt = `You are Resident, an always-on codebase custodian. You are investigating ONE finding in this repository, strictly read-only.

FINDING: ${item.title}
KIND: ${item.sense}/${item.kind}
DETAIL:
${item.detail || '(none)'}
${memoryBlock(memories)}
Investigate the real situation in this codebase (read files, git history, gh, etc). Then respond with EXACTLY this structure:

## ROOT CAUSE
2–4 sentences. Name specific files and lines.

## EVIDENCE
Bullet list of file:line references, each with a one-line explanation.

## PROPOSED FIX
Choose exactly ONE:
- A minimal, surgical unified diff inside a \`\`\`diff fenced block (correct relative paths) — for ordinary code edits. This is the default.
- A single shell command inside a \`\`\`sh fenced block — ONLY when a hand-written diff is the wrong tool (refreshing a lockfile, bumping a dependency, regenerating a generated file). One command, no shell chaining (no &&, ;, |, redirects), e.g. \`bun update foo bar\`.
- NONE, with one sentence why, if it's informational or needs a human decision.
Prefer the diff for anything you can hand-edit correctly; reach for a command only when editing the file by hand would be wrong.

## RISK
One line: low/medium/high and why.

## NOTES FOR NEXT TIME
0–3 bullets, or the single word "none". ONLY durable repo-level lessons a future investigation should know before digging: conventions you discovered, false-positive patterns ("X always flags but is intentional because Y"), approaches that don't work here. NEVER a summary of this finding, never secrets or tokens.

Be concrete and honest. If the finding is stale or a false positive, say so under ROOT CAUSE and propose NONE.`

  const res = await runClaude(prompt, repoPath, READONLY_TOOLS, model)
  saveTranscript(item.id, 'investigate', res.text)
  const patch = extractDiff(res.text)
  // a command-fix is only honoured when no diff was proposed (diffs are the constrained default);
  // notes are only honoured from a CLEAN run — a crashed dig doesn't get to write memory
  return { ok: res.ok, evidence: res.text, patch, command: patch ? null : extractCommand(res.text), notes: res.ok ? extractNotes(res.text) : [], cost: res.cost, costEstimated: res.costEstimated }
}

/** Human clicked Approve: apply the proposed fix on a branch and open a PR.
 *  Runs in a disposable git worktree so the user's live checkout is never touched. */
export async function approve(item: Item, repoPath: string, model?: string) {
  const branch = branchFor(item)
  const worktree = `/tmp/resident-wt-${item.id}`
  const prompt = `You are Resident, applying an already-approved fix for this repository.

TASK: ${item.title}

THE APPROVED FIX (apply this; adapt minimally if line numbers drifted):
\`\`\`diff
${item.patch}
\`\`\`

INVESTIGATION NOTES (context):
${(item.evidence ?? '').slice(0, 4000)}

HARD RULES — the user's working checkout must never be disturbed:
1. Do NOT switch branches or modify files in ${repoPath} itself. Work in a disposable worktree:
   git fetch origin (if a remote exists), then
   git worktree add ${worktree} -B ${branch} (based on origin's default branch if a remote exists, else the local default branch).
   Do all work inside ${worktree}.
2. This may be a RETRY of an interrupted run: if branch ${branch} already exists (locally or on origin) and already contains the fix commit, do not redo the work — continue from the first missing step.
3. Apply the fix by editing files directly (do not blind-run git apply if context drifted). Stage and commit ONLY the files the fix touches — never unrelated changes.
4. Commit message exactly: "${item.title.replace(/"/g, "'")} (via Resident)".
5. If an origin remote exists: push the branch and open a PR with gh pr create (title = commit message, body = short root cause + evidence summary, noting it was proposed by Resident and human-approved). If no remote: stop after committing.
6. Clean up the worktree when done: git worktree remove ${worktree} --force (the branch itself stays).
7. The VERY LAST line of your response must be either the PR URL, or "LOCAL: ${branch}" if there was no remote.`

  const res = await runClaude(prompt, repoPath, APPLY_TOOLS, model, 900_000, ['--add-dir', worktree, '--add-dir', '/tmp'])
  saveTranscript(item.id, 'approve', res.text)
  const lines = res.text.trim().split('\n')
  const last = lines[lines.length - 1]?.trim() ?? ''
  const url = last.match(/https?:\/\/\S+/)?.[0] ?? res.text.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0] ?? null
  const local = last.startsWith('LOCAL:') ? last : null
  return { ok: res.ok && !!(url || local), pr_url: url ?? local, cost: res.cost, text: res.text }
}

/** Human approved a COMMAND fix (e.g. `bun update foo`): run the already-allowlisted command in a
 *  disposable worktree, commit whatever it changed, open a PR. Fully deterministic — no AI, no cost,
 *  no shell (arg-array spawn). The caller MUST have validated item.command against the repo allowlist. */
export async function applyCommand(item: Item, repoPath: string) {
  const branch = branchFor(item)
  const worktree = `/tmp/resident-wt-${item.id}`
  const tokens = (item.command ?? '').trim().split(/\s+/).filter(Boolean)
  const steps: string[] = []
  const done = (ok: boolean, pr_url: string | null, extra: Record<string, unknown> = {}) => {
    saveTranscript(item.id, 'command', steps.join('\n\n'))
    return { ok, pr_url, cost: 0, text: steps.join('\n\n'), ...extra }
  }
  if (!tokens.length) return done(false, null)

  const hasRemote = (await run(['git', 'remote', 'get-url', 'origin'], repoPath)).ok
  if (hasRemote) await run(['git', 'fetch', 'origin', '--quiet'], repoPath, 120_000)
  const base = await defaultBase(repoPath, hasRemote)

  // fresh, retry-safe worktree: clear stale registrations AND a stale dir (a crashed run can leave
  // a dir git no longer tracks — `worktree remove` alone won't recover that, `add` would then fail)
  await run(['git', 'worktree', 'remove', worktree, '--force'], repoPath, 60_000)
  await run(['git', 'worktree', 'prune'], repoPath)
  await run(['rm', '-rf', worktree], repoPath, 60_000)
  const add = await run(['git', 'worktree', 'add', worktree, '-B', branch, base], repoPath, 120_000)
  steps.push(`worktree add -B ${branch} ${base}\n${add.out}`)
  if (!add.ok) return done(false, null)

  // run the approved command IN the worktree, never the user's checkout (generous timeout: cold installs)
  const ran = await run(tokens, worktree, 300_000)
  steps.push(`$ ${tokens.join(' ')}\n${ran.out}`)

  // a failed command is a failure even if it changed nothing — check this BEFORE no-changes
  if (!ran.ok) {
    await run(['git', 'worktree', 'remove', worktree, '--force'], repoPath, 60_000)
    steps.push('→ command exited non-zero — worktree discarded')
    return done(false, null)
  }

  await run(['git', 'add', '-A'], worktree)
  const noChanges = (await run(['git', 'diff', '--cached', '--quiet'], worktree)).ok // exit 0 = nothing staged
  if (noChanges) {
    await run(['git', 'worktree', 'remove', worktree, '--force'], repoPath, 60_000)
    steps.push('→ command succeeded but produced no changes — nothing to PR')
    return done(false, null, { noChanges: true })
  }

  const msg = `${(item.title || 'fix').replace(/"/g, "'")} (via Resident)`
  const commit = await run(['git', 'commit', '-m', msg], worktree)
  steps.push(commit.out)

  let prUrl: string | null = null
  if (hasRemote && commit.ok) {
    // force-with-lease: the resident/<id>-* branch is ours by construction, and a RETRY of an
    // interrupted run re-creates it from base — a plain push would be rejected as non-fast-forward
    const push = await run(['git', 'push', '-u', 'origin', branch, '--quiet', '--force-with-lease'], worktree, 120_000)
    steps.push(push.out)
    if (push.ok) {
      const body = `Proposed by Resident, human-approved.\n\nFix run: \`${tokens.join(' ')}\`\n\n${(item.evidence ?? '').slice(0, 3000)}`
      const pr = await run(['gh', 'pr', 'create', '--title', msg, '--body', body, '--head', branch], worktree, 120_000)
      steps.push(pr.out)
      prUrl = pr.stdout.match(/https?:\/\/\S+/)?.[0] ?? null
      if (!prUrl) {
        // pr create fails if a PR already exists for this branch (retry) — recover its URL instead of failing
        const ls = await run(['gh', 'pr', 'list', '--head', branch, '--state', 'open', '--json', 'url'], worktree, 60_000)
        try { prUrl = JSON.parse(ls.stdout)[0]?.url ?? null } catch {}
        if (prUrl) steps.push(`→ PR already existed, recovered: ${prUrl}`)
      }
    }
  }

  await run(['git', 'worktree', 'remove', worktree, '--force'], repoPath, 60_000)
  const local = !hasRemote && commit.ok ? `LOCAL: ${branch}` : null
  return done(commit.ok && !!(prUrl || local), prUrl ?? local)
}
