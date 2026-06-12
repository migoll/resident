# Resident ☉

**The agent that doesn't wait to be prompted.**

Every AI coding tool so far has the same dead spot: a blinking cursor, waiting for a human to show up and type. Resident is the inversion — a daemon that lives next to your repos, watches everything on a heartbeat, decides for itself what matters, investigates with real agent sessions, and greets you with evidence and ready-to-approve fixes. For seventy years humans prompted computers. This is the computer prompting you.

```
 senses ──► heartbeat ──► judgment ──► hands ──► face
 (git, deps, (cycle every (scores +    (headless  (the inbox:
  typecheck,  15 min)      budgets)     claude     approve, track,
  uptime, gh)                           sessions)  dismiss, restore)
```

## What it does today

- **Watches** your repos and sites every cycle, for free: git state (uncommitted work, stale branches, TODO rot), `bun outdated` / `bun audit`, typecheck, uptime/latency, GitHub PRs with failing checks or conflicts, fresh issues.
- **Judges** every finding with a score. Below threshold → logged visibly with its reasoning (you can always audit what it chose to ignore). Above → queued for investigation, capped by budgets (default 2/cycle, 10/day).
- **Investigates** queued findings with headless Claude sessions locked to a read-only toolset: root cause, file:line evidence, ONE minimal proposed diff, risk rating. Full transcripts on disk.
- **Acts only when you click.** Approve → applies the fix in a disposable git worktree (your checkout is never touched), pushes a `resident/*` branch, opens a PR. Or open a tracking issue instead (deterministic, no AI cost). Or dismiss — and restore later if you regret it.
- **Remembers what matters.** Each watched repo has a small, editable notebook in the inbox for decisions, conventions, known false positives, and failed approaches. Investigations read it as context and append only concise, verified learnings — the notes always stay visible and yours to edit.
- **Tracks outcomes.** Opened PRs are followed to merged/closed automatically. Interrupted runs are reconciled against GitHub on restart. If macOS revokes folder access, Resident detects its own blindness and tells you loudly — "quiet" and "blind" are never allowed to look the same.

## "Isn't this just a cron job running an agent?"

The *act* part — something triggers, an agent runs, a PR appears — is commodity. CI-triggered Claude does it, scheduled cloud agents do it, Dependabot has done it for years. Dependabot is also the cautionary tale: trigger → PR with no judgment in between is precisely the automation everyone learns to mute.

A trigger is a boolean, not judgment. What it can't give you:

- **State between runs.** A cron'd agent re-discovers the same stale branch every cycle — then either re-spends tokens re-investigating it or spams duplicate PRs. Resident's store means a finding is judged once, deduped forever, and its outcome (merged, dismissed, closed unmerged) is remembered.
- **Free senses gating paid judgment.** Re-deriving "does this matter?" in model calls every 15 minutes is expensive and inconsistent. Resident's senses are deterministic and free; tokens are spent only past a scored threshold, under hard budget ceilings. That inversion is what makes always-on affordable at all.
- **Signals with no event to subscribe to.** Nothing fires a webhook when a branch goes stale, a dependency drifts, a site slows past its limit, or a Sentry error fades into old noise. Those signals exist only because something polls for them on a heartbeat.
- **An accountability loop.** A CI-triggered agent doesn't know its last PR was closed unmerged, can't show you what it chose to ignore, and never learns from your dismissals. Resident's inbox is built around visible judgment — everything ignored, with its reason.

Notice → judge → remember → stay quiet is the product. The PR at the end is the easy part.

## Quickstart

Requirements: [bun](https://bun.sh), the [`claude`](https://docs.anthropic.com/claude-code) CLI (logged in — Resident rides your existing subscription, no API key needed), and [`gh`](https://cli.github.com) (logged in) for the GitHub senses and PR/issue actions.

```sh
git clone https://github.com/migoll/resident && cd resident
printf '#!/bin/sh\nexec bun %s/src/cli.ts "$@"\n' "$PWD" > ~/.bun/bin/resident && chmod +x ~/.bun/bin/resident

resident init    # discovers your repos → ~/.resident/config.json
resident doctor  # check the setup: tools, auth, config, folder access, daemon
resident once    # one foreground cycle — see what it finds right now
resident start   # the daemon: cycles forever + inbox UI on :5117
resident open    # open the inbox (--app for a chromeless desktop window)
resident install # or: run permanently via launchd — starts at login, restarts if killed
```

If anything misbehaves, `resident doctor` checks every dependency — bun/git/claude/gh auth, config, repo folder access (the macOS TCC trap), the db, the daemon, Sentry token, notify URL — and prints a fix hint per failure (exit 1 if something's truly broken).

Config lives in `~/.resident/config.json`: repos, watched URLs, cycle interval, budgets, and optional `"notify"` — point it at an [ntfy](https://ntfy.sh) topic URL or a Slack incoming webhook and Resident pings your phone when something's ready for you, when a PR opens, or when a site goes down. State in `~/.resident/resident.db`, investigation transcripts in `~/.resident/runs/`. The watchlist is also editable from the inbox itself (the chips row).

Got [Sentry](https://sentry.io)? Add `"sentry": { "org": "your-org", "token": "sntryu_..." }` (a Personal Token with `event:read` + `project:read` + `org:read` — the free tier is enough) and Resident polls for fresh production errors every cycle: new and regressed issues get investigated like any other finding, and if a Sentry project slug matches a watched repo's name, the investigation digs through that codebase. Old, ongoing errors are deliberately kept below the investigation threshold — visible in the activity feed, never an alarm.

Model spend is tiered by default: routine investigations run on a cheap base model (`sonnet`) and only escalate to the strong one (`opus`) when a finding scores ≥ 85 or you click *Re-investigate* — tune via `"models": { "base": ..., "escalated": ... }` and `"escalateScore"`, or pin everything with the legacy `"model"` override. Findings whose right fix is a *command* (a lockfile refresh, `bun update x`) become one-click approvals only if you allowlist the command prefix per repo: `"repos": [{ ..., "commands": ["bun update", "bun install"] }]` — empty by default, enforced server-side, and the command runs with no shell in a disposable worktree.

## Run it on a spare machine

An old MacBook, a Mac mini, a home server — the same boxes people park OpenClaw on — make a perfect "residence": always on, always watching, while you read the inbox from any device.

```sh
# on the spare machine (logged into claude + gh once):
git clone <your repos> ~/repos/...     # resident scans local clones
resident init                          # then edit ~/.resident/config.json:
#   "repos":  [{ "path": "...", "name": "...", "pull": true }]   ← pull:true keeps clones fresh
#   "bind":   "0.0.0.0"                                          ← reachable from your other devices
#   "notify": "https://ntfy.sh/<your-secret-topic>"              ← pings your phone
resident install                       # permanent: starts at login, restarts if killed
```

Notes for laptop-as-server: keep it on power and enable *Prevent automatic sleeping when display is off* (System Settings → Battery → Options) so it works with the lid closed. The inbox has no auth — on anything beyond your home network, put it behind [Tailscale](https://tailscale.com) and reach it via the tailnet IP from your phone anywhere. Logs: the daemon writes `~/.resident/resident.log` itself and rotates it past 5 MB (one `.1` generation kept); launchd captures only bun-level crash spew in `~/.resident/launchd.log`. Installs from before this split should re-run `resident install` once to adopt the new plist.

## The authority model

Everything autonomous is **read-only by design** — the investigation toolset cannot write. Writes happen only on a human click, and even then on a disposable worktree branch, never your checkout, never `main`. Budgets cap the AI spend per cycle and per day; the inbox header shows running usage. Graduated autonomy (auto-merge for trivial, well-tested classes of fix) is on the roadmap, gated behind trust earned per repo — not a default.

## Honest status

This is a young v0.2 — a working single-user local daemon, born 2026-06-09, with one merged PR to its name on day one. The senses are pull-based polling; the killer ambient senses (Slack, analytics, CVE feeds via webhooks) aren't built yet. It runs while your machine is awake; the hosted always-on residence is the end-state. Treat it as a sharp prototype of an inverted workflow, not a finished product.

## License

AGPL-3.0 — open, and it *stays* open: if you run a modified Resident for others (including as a hosted service), you must share your source. Copyright © 2026 Christian Lund.
