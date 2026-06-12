import { closeSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HOME } from './config'

export const LOG_PATH = join(HOME, 'resident.log')
/** rotate past this — the live file plus one .1 generation caps the log at ~10 MB total */
export const LOG_MAX_BYTES = 5 * 1024 * 1024

/** An append-only log file this process OWNS. launchd's StandardOutPath can't be rotated from
 *  inside the daemon (rename → launchd keeps appending to the old inode), so the daemon tees
 *  its own lines through an fd it can close, rename, and reopen. Every operation is
 *  best-effort: a broken logger degrades to console-only and must never crash the daemon. */
export function fileLogger(path = LOG_PATH, maxBytes = LOG_MAX_BYTES) {
  let fd: number | null = null
  const open = () => {
    try { mkdirSync(dirname(path), { recursive: true }); fd = openSync(path, 'a') } catch { fd = null }
  }
  open()
  return {
    /** append one line — datestamped, ANSI-stripped (the file is for grep; the terminal keeps the colors) */
    write(s: string) {
      if (fd === null) return
      try { writeSync(fd, `${stamp()} ${s.replace(/\x1b\[[0-9;]*m/g, '')}\n`) }
      catch { try { closeSync(fd) } catch {}; fd = null } // degrade silently; the next rotate check reopens
    },
    /** close → rename → reopen once the live file passes maxBytes. Exactly one .1 generation
     *  (the rename overwrites the previous one). A statSync — cheap enough for every cycle. */
    maybeRotate() {
      try {
        if (statSync(path).size > maxBytes) {
          if (fd !== null) { try { closeSync(fd) } catch {}; fd = null }
          renameSync(path, `${path}.1`)
        }
      } catch {} // missing file / fs trouble — fall through and (re)open
      if (fd === null) open()
    },
  }
}
export type FileLogger = ReturnType<typeof fileLogger>

// timestamps carry the date: a rotated 5 MB file can span weeks at Resident's log volume
function stamp() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 8)}`
}

// ---- daemon wiring: one active logger, rotation driven from the cycle loop
let active: FileLogger | null = null

/** Wrap the console logger so every line also lands in resident.log (the daemon-owned tee).
 *  Rotation is checked here once at start, then once per cycle via maybeRotateLog(). */
export function teeToFile(base: (s: string) => void): (s: string) => void {
  active = fileLogger()
  active.maybeRotate() // a >5 MB leftover from the previous run rotates before the first line, not a cycle later
  return (s: string) => { base(s); active?.write(s) }
}

/** Per-cycle hook. No-op when no file log is active (`resident once`, tests). */
export function maybeRotateLog() { active?.maybeRotate() }
