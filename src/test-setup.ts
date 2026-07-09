/** bun test preload (wired in bunfig.toml) — runs before ANY test file in the shared test process.
 *  config.ts computes HOME once at import time, and the watch-API tests exercise the real
 *  saveConfig(); without this override they would overwrite the user's actual ~/.resident/config.json.
 *  ES imports hoist, so an in-file `process.env` assignment can land too late — only a preload is
 *  guaranteed to win the race. Every suite runs against a fresh throwaway state dir. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.RESIDENT_HOME = mkdtempSync(join(tmpdir(), 'resident-test-home-'))
