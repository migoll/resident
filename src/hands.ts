import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOME } from './config'
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
 *  pricing (opus:sonnet:haiku ≈ 5:3:1); the absolute rate is a deliberately conservative wall-clock heuristic,
 *  and unknown models fall back to the opus rate so the ledger errs toward over-counting, never under. */
function estimateCost(model: string | undefined, ms: number): number {
  const m = (model ?? 'opus').toLowerCase()
  const perMin = m.includes('haiku') ? 0.15 : m.includes('sonnet') ? 0.45 : 0.75
  return +((perMin * Math.max(0, ms)) / 60_000).toFixed(2)
}

async function runClaude(prompt: string, cwd: string, tools: string[], model?: string, timeoutMs = 600_000, extraArgs: string[] = []): Promise<ClaudeResult> {
  const args = ['claude', '-p', prompt, '--output-format', 'json', '--allowedTools', ...tools, ...extraArgs]
  if (model) args.push('--model', model)
  const t0 = Date.now()
  try {
    const p = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs, killSignal: 'SIGKILL', env: { ...process.env } })
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    const code = await p.exited
    try {
      const j = JSON.parse(out)
      return { ok: code === 0 && !j.is_error, text: j.result ?? out, cost: Number(j.total_cost_usd ?? 0) }
    } catch {
      // no final JSON → killed / timed-out / crashed mid-run; estimate spend from wall-clock
      return { ok: code === 0, text: (out || err).slice(0, 8000), cost: estimateCost(model, Date.now() - t0), costEstimated: true }
    }
  } catch (e) {
    return { ok: false, text: String(e), cost: estimateCost(model, Date.now() - t0), costEstimated: true }
  }
}

function extractDiff(text: string): string | null {
  const m = text.match(/```diff\n([\s\S]*?)```/)
  return m ? m[1].trimEnd() : null
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

/** Shadow-mode investigation: read-only dig, returns evidence + proposed patch. */
export async function investigate(item: Item, repoPath: string, model?: string) {
  const prompt = `You are Resident, an always-on codebase custodian. You are investigating ONE finding in this repository, strictly read-only.

FINDING: ${item.title}
KIND: ${item.sense}/${item.kind}
DETAIL:
${item.detail || '(none)'}

Investigate the real situation in this codebase (read files, git history, gh, etc). Then respond with EXACTLY this structure:

## ROOT CAUSE
2–4 sentences. Name specific files and lines.

## EVIDENCE
Bullet list of file:line references, each with a one-line explanation.

## PROPOSED FIX
ONE minimal, surgical unified diff inside a \`\`\`diff fenced block. Use correct relative paths. If no code fix is appropriate (e.g. it's informational or needs a human decision), write NONE and one sentence why.

## RISK
One line: low/medium/high and why.

Be concrete and honest. If the finding is stale or a false positive, say so under ROOT CAUSE and propose NONE.`

  const res = await runClaude(prompt, repoPath, READONLY_TOOLS, model)
  saveTranscript(item.id, 'investigate', res.text)
  return { ok: res.ok, evidence: res.text, patch: extractDiff(res.text), cost: res.cost, costEstimated: res.costEstimated }
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
