# Resident — session context

Always-on repo custodian ("the agent that doesn't wait to be prompted"). Owner: Christian Lund
(migoll on GitHub). Public repo: https://github.com/migoll/resident · AGPL-3.0.

**Start every working session by reading `ROADMAP.md`** — it is the single source of truth for
scope, status, and standing principles. Update its checkboxes + changelog when you land things.

## Run / develop

```sh
resident start            # daemon + inbox on :5117 (portless alias → https://resident.localhost)
resident once             # one foreground cycle (--investigations 0 for a free dry run)
resident install|stop     # launchd permanence / stop everything
pkill -f ".resident/app/src/cli.ts"   # kill a session-run daemon
bun build src/cli.ts --target=bun --outfile=/dev/null   # parse check
```

- Global shim `~/.bun/bin/resident` (+ `/opt/homebrew/bin` symlink) execs `src/cli.ts` directly —
  source edits apply on next daemon restart, no build step.
- Runtime state lives in `~/.resident/` (config.json, resident.db SQLite, runs/ transcripts,
  resident.log). The app deliberately lives in `~/.resident/app`, NOT under ~/Documents
  (macOS TCC once revoked Documents access mid-session; never move it back).
- A daemon may already be running — check `lsof -i :5117`. Restart it after code changes.

## Architecture (src/)

- `cli.ts` — commands: init/once/start/install/uninstall/stop/status/open
- `config.ts` — `~/.resident/config.json`: repos (path/name/checks/pull), urls, budgets,
  intervalMinutes, model, bind, notify, quiet/digest/silent delivery
- `senses.ts` — polling watchers: git/deps/typecheck/uptime/github/sentry → scored `Finding`s
- `store.ts` — SQLite findings + per-repo memory notebook + mutes + earned authority; statuses: queued→investigating→ready→(approving→approved→
  merged|closed)|(working→tracked)|failed|ignored|dismissed; INVESTIGATE_THRESHOLD = 55
- `daemon.ts` — cycle loop: outcomes/auto-merge → digest/report → blindness → senses → triage → budgeted
  investigations/earned auto-PR; reconcile() heals restart-orphaned runs against GitHub
- `hands.ts` — headless `claude -p` runners: investigate (READONLY_TOOLS) and approve
  (APPLY_TOOLS, disposable git worktree in /tmp, never the user's checkout)
- `server.ts` — inbox API: /api/state, /api/cycle, /api/watch, /api/memory, /api/notifications, /api/autonomy, /api/item/:id/{approve,issue,
  dismiss,restore,reinvestigate}; serves ui/inbox.html + PWA manifest/icon
- `notify.ts` — ntfy/Slack pushes (fire-and-forget)

## Conventions

- Bun + zero runtime deps. No build step. Loose TS (no typecheck gate); verify with `bun build`.
- UI is a single `ui/inbox.html`, vanilla JS, Apple-dark design (Christian's direction: "Apple").
- Autonomous work is read-only by construction; writes only behind human clicks. Budgets are
  hard caps. Everything ignored is shown with its reason. (Full principles in ROADMAP.md.)
- Feature work goes up as one PR per feature — Christian reads every PR before merge. Trivial
  meta-fixes may still push to main. Imperative messages.
- Investigations cost real subscription usage — when testing, use `--investigations 0` or low
  budgets; don't burn the daily budget on smoke tests.
