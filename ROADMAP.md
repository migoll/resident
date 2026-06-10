# Resident — Roadmap to 1.0

> The single source of truth for scope and status. Any session (human or agent) working on
> Resident reads this first and updates checkboxes + the changelog line when something lands.
> Born 2026-06-09 in one night. This file is the contract from ~5% → 100%.

**The thesis:** every prior AI dev tool waits for a prompt. Resident inverts initiative — it
watches, judges, investigates, and comes to you with evidence. The product is not the agent;
it's the **judgment** (what to act on, what to ask, what to shut up about) and the **trust ramp**
(read-only → propose → act, earned per repo).

**Definition of done (1.0):** a developer who isn't Christian installs it in under 10 minutes,
runs it for a month unattended without noise fatigue, grants it real authority because the
shadow-mode evidence earned it, and at least one team runs a shared residence reachable from
anywhere. Open core (AGPL) + a paid hosted/relay tier.

---

## Phase 0 — The proof ✅ (done, 2026-06-09/10)

- [x] Daemon: sense → score → budget → investigate → inbox loop (15-min heartbeat, SQLite state)
- [x] Senses v1 (polling): git (uncommitted/stale/TODOs), deps (`bun outdated`/`bun audit`),
      typecheck, uptime/latency, GitHub PRs (failing/conflict/approved) + fresh issues via `gh`
- [x] Read-only investigations: headless `claude -p` with locked tool allowlist; root cause +
      file:line evidence + minimal diff + risk; transcripts in `~/.resident/runs/`
- [x] Human actions: Approve → disposable-worktree branch + PR (`gh`); Open issue instead
      (deterministic, no AI); Dismiss → Restore; Re-investigate
- [x] Outcome tracking: approved PRs followed to merged/closed; issues to closed
- [x] Self-healing: startup reconciliation of orphaned runs (checks GitHub for the branch's PR)
- [x] Self-awareness: blindness detector (macOS TCC denial → loud red alert, auto-resolves)
- [x] Budgets: investigations per cycle/day, cost ledger shown in inbox (subscription usage)
- [x] Inbox UI (Apple-dark): Ready-for-you cards w/ evidence+diff, Activity feed incl. *ignored
      with reasons* (auditable judgment), watchlist chips (add/remove live), PWA installable
      (manifest+icon), `resident open --app` chromeless window
- [x] Always-on: `resident install/uninstall/stop` (launchd, KeepAlive), `--lan` bind,
      per-repo `pull: true` for dedicated-machine clones, ntfy/Slack notifications
- [x] Public repo, AGPL-3.0 (sole copyright → dual-license possible; add CLA before accepting PRs)
- [x] Real-world proof: PocketPane PR #1 proposed, human-approved, merged, auto-tracked

## Phase 1 — Daily driver (make Christian's setup boringly reliable)

- [ ] **Deploy the residence**: 2018 MBP at home — clones w/ `pull:true`, `bind 0.0.0.0`,
      Tailscale, ntfy topic, `resident install`, lid-closed power settings (runbook in README)
- [ ] **Sentry / error sense**: poll Sentry API (or generic error-log webhook receiver) — this is
      the killer signal; prod errors at 2am are the founding demo of the whole pitch
- [x] **Command-type approvals**: findings whose right fix is a command (lockfile refresh,
      `bun update x y`) get an approvable action with a per-repo command allowlist — closes the
      gap discovered on day one (el-plato investigation correctly refused to hand-diff a lockfile).
      Investigation may propose a ```sh command instead of a diff; approve runs it **deterministically**
      (no AI, no shell — arg-array spawn) in a disposable worktree → PR. Allowlist (`repo.commands`)
      enforced server-side; empty by default (opt in per repo). UI gates the button on it.
- [x] **Model tiering**: config default `sonnet` for investigations; escalate to the big model
      only for score ≥ 85 or on Re-investigate (legacy `model` still pins everything; model recorded
      per finding + shown in the inbox)
- [x] **Cost accounting for killed runs**: estimate from elapsed time × model rate when the final
      JSON never arrives (wall-clock × per-tier $/min, opus:sonnet:haiku ≈ 5:3:1, opus fallback so it
      over- never under-counts; flagged as an estimate). NB: runs orphaned by killing the daemon
      itself still fall to reconcile() — only intra-lifetime timeouts/crashes are estimated.
- [ ] **Smoke tests + CI**: senses/triage/store/watch-API covered; GitHub Actions on the repo;
      Resident watches its own CI (dogfood loop closes)
- [ ] **Hygiene**: log rotation, archive items older than N days, `resident doctor`
      (checks bun/claude/gh/tailscale auth and folder access)

## Phase 2 — The moat (memory + earned autonomy)

- [ ] **Memory layer** (the compounding asset): per-repo durable notes — decisions, known
      false-positives, conventions, "tried X, failed because Y". Investigations read memory
      before digging and write back after. Surfaced + editable in the inbox.
- [ ] **Dismissals teach**: repeated dismissal of a kind/repo dampens its score automatically
      ("you've dismissed stale-branches in tierflix 3× → auto-ignore, reversible in settings")
- [ ] **Graduated autonomy**: per-repo, per-kind authority earned from accept-rate —
      shadow → auto-PR (no click) → auto-merge (trivial classes, CI-green, small diffs only).
      Authority changes are themselves inbox items you approve.
- [ ] **Noise discipline**: morning digest mode, quiet hours, weekly "what I did" summary —
      Dependabot fatigue is the named enemy; silence > spam, always
- [ ] **Semantic dedupe**: same root cause across findings collapses into one item

## Phase 3 — Second user, then a team

- [ ] **10-minute install**: `bun build --compile` single binary, brew tap or `curl | sh`,
      onboarding wizard; first-week **shadow report** ("here's what I would have done") as the
      activation moment
- [ ] **Auth on the inbox**: token/passkey — required the moment it leaves localhost/tailnet
- [ ] **GitHub App packaging**: webhook senses (PR/issue/CI events push instead of polls),
      installable on an org; per-repo enable
- [ ] **Multi-user**: shared residence, per-person views/approvals, team budgets, audit log of
      who approved what
- [ ] Recruit user #2 at Homerunner; their friction list becomes the backlog, verbatim

## Phase 4 — The product (hosted residence + launch)

- [ ] **Relay**: residence dials out to a broker; login from anywhere, no Tailscale required —
      the "surely it can't be LAN" answer; likely first paid feature
- [ ] **Hosted tier**: managed residences (their box, your login) — open core stays AGPL
- [ ] **Security hardening**: scoped tokens per run, sandboxed executors, secrets never in
      transcripts, third-party security review before any team tier
- [ ] **Native shells**: web push on the PWA first; then macOS menu-bar app (badge = items
      ready); iOS app last — all consume the existing `/api/state` + action endpoints
- [ ] **The launch**: demo video (the 2am-fix morning), blog post telling the inversion story,
      HN/X; README is already the pitch

---

## Standing principles (don't violate these casually)

1. **Autonomous = read-only.** Writes require a human click (or explicitly granted, earned,
   per-repo autonomy in Phase 2+). Structural, not policy: the autonomous toolset has no write tools.
2. **Budgets are hard ceilings.** It must be impossible for Resident to surprise anyone on cost.
3. **Visible judgment.** Everything ignored shows up with its reason. "Quiet" and "blind" must
   never look the same (the TCC incident is canon — see blindnessCheck).
4. **Zero runtime deps** stays until a dependency earns its place. Bun + SQLite + the CLIs.
5. **The user's checkout is sacred.** All write work happens in disposable worktrees.
6. **Boring tech, Apple-calm UI.** The product is judgment, not framework novelty.

## Open questions (decide deliberately, not by drift)

- Pricing shape for the hosted tier; CLA timing before first external PR
- Sentry: poll API vs receive webhooks (webhook receiver needs reachable endpoint → relay first?)
- How much of triage moves from heuristics to a cheap model (cost vs taste)
- Rename risk: "Resident" collision check before launch

## Changelog

- 2026-06-09 — idea → v0.1 built, first investigations on real repos
- 2026-06-10 — PocketPane PR #1 merged (first real outcome); v0.2: reconciliation, outcome
  tracking, issue/restore/reinvestigate, blindness detector, watchlist editing, PWA shell,
  launchd + notifications; public on GitHub (AGPL-3.0); moved to ~/.resident/app after TCC incident
- 2026-06-10 — Phase 1: model tiering (sonnet base → opus on score ≥85 or Re-investigate; legacy
  `model` still pins) + killed-run cost estimation (wall-clock × per-tier rate). Model shown per
  finding in the inbox. First live dig under tiering correctly routed a score-60 finding to sonnet
  for $0.66 vs ~$2.47 on opus that morning (~73% cheaper).
- 2026-06-10 — Phase 1: command-type approvals. Investigations can propose a `sh` command fix;
  Approve runs it deterministically (no AI, no shell) in a disposable worktree → PR, gated by a
  per-repo command allowlist (`repo.commands`, server-enforced, empty by default). Closes the
  day-one lockfile gap.
- 2026-06-10 — review-hardening pass (requested after the day's two features): approve step now
  pins to the base model via applyModel() — it had been inheriting the user's interactive CLI
  default, which silently became Fable 5 (2× opus cost) that afternoon; escalation now survives
  daemon restarts (consumed on success, not at dig start); failed commands no longer report as
  "no changes"; applyCommand retries are idempotent (worktree prune + force-with-lease + existing-PR
  URL recovery); extractCommand refuses multi-command blocks; SHELL_META also rejects \r, quotes,
  backslash; reinvestigate clears stale command proposals.
