import { dirname } from 'node:path'
import { open, rename } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

// On Windows a file cannot be replaced while another program has it open: another DSH
// reading the team's state, the search indexer, a virus scanner, a sync client. Those
// readers let go within moments.
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])
const TRIES = 6
const WAIT_MS = 40

/**
 * Moves `temp` over `path`, trying again for a moment while Windows reports `path` busy.
 * `check` runs before each new try and throws to stop, as when the lock that allows the
 * write was lost in the meantime.
 */
// A blue screen must not leave a file of the right length and no content. Data and
// metadata still sit in the cache when rename commits the directory entry; a hard
// reset then yields a hole that reads as NULs. fsync before the rename, and the
// directory after it, so the name can only ever point at flushed bytes.
export async function writeFileDurable(path, data) {
  const handle = await open(path, 'w')
  try {
    await handle.writeFile(data, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectory(path) {
  // Windows cannot open a directory handle; there the file sync above is what counts.
  if (process.platform === 'win32') return
  const handle = await open(dirname(path), 'r').catch(() => undefined)
  if (handle === undefined) return
  try {
    await handle.sync()
  } catch {
    // Some filesystems refuse to sync a directory; the rename is still atomic there.
  } finally {
    await handle.close()
  }
}

export async function replaceFile(temp, path, check = () => {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temp, path)
      await syncDirectory(path)
      return
    } catch (error) {
      if (process.platform !== 'win32' || attempt >= TRIES || !BUSY.has(error?.code)) throw error
      // Real filesystem contention must clear even while tests freeze application timers.
      await delay(WAIT_MS * attempt)
      check()
    }
  }
}
