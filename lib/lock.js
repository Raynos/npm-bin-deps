'use strict'

// A cross-process lock so concurrent `npr` runs don't race an install.
//
// The lock is a file created with O_EXCL (`wx`) holding the owner's
// pid, host and start time. While held, the owner touches it every few
// seconds. A waiter treats a lock as stale, and removes it, when its
// owner on this host is gone or it hasn't been touched for a while.
// Exit and signal handlers remove held locks on the way out.

const fs = require('node:fs')
const os = require('node:os')

const { UserError } = require('./log.js')

const SECOND = 1000
const MINUTE = 60 * SECOND

/**
 * @typedef {{
 *   waitMs?: number,
 *   staleMs?: number,
 *   pollMs?: number,
 *   heartbeatMs?: number
 * }} LockOptions
 */

const DEFAULTS = {
  waitMs: 10 * MINUTE,
  staleMs: 30 * SECOND,
  pollMs: 100,
  heartbeatMs: 5 * SECOND
}

/** @type {Set<string>} */
const held = new Set()

/** @type {NodeJS.Signals[]} */
const SIGNALS = process.platform === 'win32'
  ? ['SIGINT', 'SIGTERM', 'SIGBREAK']
  : ['SIGINT', 'SIGTERM', 'SIGHUP']

/**
 * Remove every lock this process holds.
 *
 * @returns {void}
 */
function releaseAll () {
  for (const lockPath of held) {
    try {
      fs.unlinkSync(lockPath)
    } catch (_err) {
      // already gone
    }
  }
  held.clear()
}

/**
 * On a signal: drop our locks, then die of the same signal.
 *
 * @param {NodeJS.Signals} signal
 */
function onSignal (signal) {
  releaseAll()
  removeHandlers()
  process.kill(process.pid, signal)
}

let handlersInstalled = false

/**
 * Listen for exit and signals while any lock is held.
 *
 * @returns {void}
 */
function installHandlers () {
  if (handlersInstalled) return
  handlersInstalled = true
  process.on('exit', releaseAll)
  for (const sig of SIGNALS) process.on(sig, onSignal)
}

/**
 * Stop listening once no lock is held, so default signal handling
 * comes back.
 *
 * @returns {void}
 */
function removeHandlers () {
  if (!handlersInstalled) return
  handlersInstalled = false
  process.removeListener('exit', releaseAll)
  for (const sig of SIGNALS) process.removeListener(sig, onSignal)
}

/**
 * Is a process with this pid running?
 *
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM'
  }
}

/**
 * Should a waiter break this lock? Returns the contents it judged, so
 * the caller only removes that same lock, or null if not stale.
 *
 * @param {string} lockPath
 * @param {number} staleMs
 * @returns {string | null}
 */
function staleContents (lockPath, staleMs) {
  let text
  let stat
  try {
    text = fs.readFileSync(lockPath, 'utf8')
    stat = fs.statSync(lockPath)
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code
    if (code === 'ENOENT' || windowsBusy(code)) return null
    throw err
  }
  const age = Date.now() - stat.mtimeMs
  if (age > staleMs) return text

  /** @type {{ pid?: unknown, host?: unknown }} */
  let owner = {}
  try {
    owner = JSON.parse(text)
  } catch (_err) {
    // Half-written by an owner that is starting up; give it staleMs.
    return null
  }
  if (owner.host === os.hostname() && typeof owner.pid === 'number' &&
      owner.pid !== process.pid && !pidAlive(owner.pid)) {
    return text
  }
  return null
}

/**
 * On Windows a lock file that another process is deleting can't be
 * opened, read or deleted: it fails with EPERM (or EACCES / EBUSY)
 * instead of EEXIST / ENOENT. Treat that as "held, try again".
 *
 * @param {string | undefined} code
 * @returns {boolean}
 */
function windowsBusy (code) {
  return process.platform === 'win32' &&
    (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Take the lock at `lockPath`, waiting for it if needed.
 *
 * @param {string} lockPath
 * @param {LockOptions} [options]
 * @returns {Promise<() => void>} release
 */
async function acquire (lockPath, options) {
  const opts = { ...DEFAULTS, ...options }
  const start = Date.now()
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      try {
        fs.writeSync(fd, JSON.stringify({
          pid: process.pid,
          host: os.hostname(),
          time: new Date().toISOString()
        }) + '\n')
      } finally {
        fs.closeSync(fd)
      }
      break
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code
      if (code !== 'EEXIST' && !windowsBusy(code)) throw err
    }

    const stale = staleContents(lockPath, opts.staleMs)
    if (stale !== null) {
      // Remove it only if it is still the lock we judged stale.
      try {
        if (fs.readFileSync(lockPath, 'utf8') === stale) fs.unlinkSync(lockPath)
      } catch (err) {
        const code = /** @type {NodeJS.ErrnoException} */ (err).code
        if (code !== 'ENOENT' && !windowsBusy(code)) throw err
      }
      continue
    }

    if (Date.now() - start > opts.waitMs) {
      throw new UserError('Could not acquire lock for concurrent npr', [
        `${lockPath} is held by another npr run.`,
        'If no npr is running, delete that file.'
      ])
    }
    await sleep(opts.pollMs)
  }

  held.add(lockPath)
  installHandlers()

  const heartbeat = setInterval(() => {
    const now = new Date()
    try {
      fs.utimesSync(lockPath, now, now)
    } catch (_err) {
      // best effort
    }
  }, opts.heartbeatMs)
  heartbeat.unref()

  let released = false
  return function release () {
    if (released) return
    released = true
    clearInterval(heartbeat)
    held.delete(lockPath)
    try {
      fs.unlinkSync(lockPath)
    } catch (_err) {
      // already gone
    }
    if (held.size === 0) removeHandlers()
  }
}

/**
 * Run `fn` while holding the lock at `lockPath`.
 *
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>} fn
 * @param {LockOptions} [options]
 * @returns {Promise<T>}
 */
async function withLock (lockPath, fn, options) {
  const release = await acquire(lockPath, options)
  try {
    return await fn()
  } finally {
    release()
  }
}

module.exports = { acquire, withLock, pidAlive }
