import type { Config, NoiseCfg, NotificationMode } from './config'
import type { Store } from './store'
import { notify } from './notify'

export const DEFAULT_NOISE: Required<Pick<NoiseCfg, 'mode' | 'weeklySummary'>> = { mode: 'immediate', weeklySummary: false }

export function noiseSettings(cfg: Config): Required<Pick<NoiseCfg, 'mode' | 'weeklySummary'>> & Pick<NoiseCfg, 'quietHours'> {
  return { mode: cfg.noise?.mode ?? DEFAULT_NOISE.mode, weeklySummary: cfg.noise?.weeklySummary ?? DEFAULT_NOISE.weeklySummary, quietHours: cfg.noise?.quietHours }
}

export function validClock(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = value.match(/^(\d\d):(\d\d)$/)
  return !!m && Number(m[1]) < 24 && Number(m[2]) < 60
}

export function inQuietHours(cfg: Config, now = new Date()): boolean {
  const quiet = noiseSettings(cfg).quietHours
  if (!quiet || !validClock(quiet.start) || !validClock(quiet.end) || quiet.start === quiet.end) return false
  const minutes = now.getHours() * 60 + now.getMinutes()
  const toMinutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3))
  const start = toMinutes(quiet.start), end = toMinutes(quiet.end)
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

export async function deliver(cfg: Config, store: Store, title: string, body: string, priority: 'normal' | 'critical' = 'normal') {
  const settings = noiseSettings(cfg)
  if (priority === 'critical') {
    store.recordDelivery(title, body, priority, 'sent')
    await notify(cfg, title, body)
    return 'sent'
  }
  if (settings.mode === 'silent') { store.recordDelivery(title, body, priority, 'silenced'); return 'silenced' }
  if (settings.mode === 'morning_digest' || inQuietHours(cfg)) { store.recordDelivery(title, body, priority, 'pending'); return 'pending' }
  store.recordDelivery(title, body, priority, 'sent')
  await notify(cfg, title, body)
  return 'sent'
}

/** One compact digest after quiet hours or at 09:00 in digest mode; never spams every queued event. */
export async function flushNoise(cfg: Config, store: Store, log: (s: string) => void, now = new Date()) {
  const settings = noiseSettings(cfg)
  if (settings.mode === 'silent' || inQuietHours(cfg)) return
  const day = now.toISOString().slice(0, 10)
  if (settings.mode === 'morning_digest' && (now.getHours() < 9 || store.metaGet('digest:' + day))) return
  const pending = store.pendingDeliveries()
  if (!pending.length) return
  const body = pending.map((d) => `• ${d.title}${d.body ? ` — ${d.body.slice(0, 180)}` : ''}`).join('\n')
  await notify(cfg, settings.mode === 'morning_digest' ? 'Resident: morning digest' : 'Resident: after-hours digest', body)
  store.sendDeliveries(pending.map((d) => d.id))
  store.metaSet('digest:' + day, '1')
  log(`  ☾ delivered ${pending.length} queued notification(s) as one digest`)
}

/** A low-frequency accounting of outcomes, deliberately separate from finding notifications. */
export async function weeklySummary(cfg: Config, store: Store, log: (s: string) => void, now = new Date()) {
  const settings = noiseSettings(cfg)
  if (!settings.weeklySummary || settings.mode === 'silent' || now.getDay() !== 1 || now.getHours() < 9) return
  const week = `${now.getFullYear()}-${Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 604_800_000)}`
  if (store.metaGet('weekly:' + week)) return
  const counts = store.outcomesSince(now.getTime() - 7 * 86_400_000)
  await notify(cfg, 'Resident: weekly report', `${counts.merged} PR${counts.merged === 1 ? '' : 's'} merged · ${counts.closed} item${counts.closed === 1 ? '' : 's'} closed · ${counts.autoPr} auto-PR${counts.autoPr === 1 ? '' : 's'} opened`)
  store.metaSet('weekly:' + week, '1')
  log('  ☀ delivered weekly report')
}

export function notificationMode(value: unknown): value is NotificationMode {
  return value === 'immediate' || value === 'morning_digest' || value === 'silent'
}
