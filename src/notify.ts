import type { Config } from './config'

/** Push a notification to the configured endpoint, if any.
 *  Supports ntfy (any URL, plain POST with Title header) and Slack incoming webhooks.
 *  Fire-and-forget: notification failures must never break a cycle. */
export async function notify(cfg: Config, title: string, body: string) {
  const url = cfg.notify
  if (!url) return
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
