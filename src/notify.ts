import type { Config } from './config'

/** "HH:MM" → minutes since midnight; NaN when malformed OR out of range ("25:00", "08:99") —
 *  a parseable-but-impossible time would otherwise gate a digest that can never fire, silently.
 *  Exported for tests. */
export function hm(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s?.trim() ?? '')
  if (!m) return NaN
  const h = Number(m[1]), min = Number(m[2])
  return h > 23 || min > 59 ? NaN : h * 60 + min
}

/** True inside the configured quiet window (which may wrap midnight). A malformed or
 *  degenerate window (start === end) never silences anything — fail toward noisy, not deaf. */
export function inQuietHours(cfg: Config, now = new Date()): boolean {
  const q = cfg.quietHours
  if (!q) return false
  const start = hm(q.start), end = hm(q.end)
  if (Number.isNaN(start) || Number.isNaN(end) || start === end) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  return start < end ? cur >= start && cur < end : cur >= start || cur < end
}

/** Push a notification to the configured endpoint, if any.
 *  Supports ntfy (any URL, plain POST with Title header) and Slack incoming webhooks.
 *  Fire-and-forget: notification failures must never break a cycle.
 *  Quiet hours suppress everything except force (the digest the user explicitly scheduled) —
 *  the inbox still records it all; pings are a convenience layer, not the record. */
export async function notify(cfg: Config, title: string, body: string, opts: { force?: boolean } = {}) {
  const url = cfg.notify
  if (!url) return
  if (!opts.force && inQuietHours(cfg)) return
  try {
    if (url.includes('hooks.slack.com')) {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `*${title}*\n${body}` }),
        signal: AbortSignal.timeout(10_000),
      })
    } else {
      await fetch(url, {
        method: 'POST',
        // headers must be latin-1 safe; anything fancy goes in the body
        headers: { Title: title.replace(/[^\x20-\x7E]/g, '').trim() || 'Resident', Tags: 'house' },
        body,
        signal: AbortSignal.timeout(10_000),
      })
    }
  } catch {}
}
