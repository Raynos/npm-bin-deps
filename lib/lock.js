'use strict'

// A cross-process lock so concurrent `npr` runs don't race an install.

const util = require('node:util')

const lockfile = require('../lockfile.js')

const SECOND = 1000
const MINUTE = 60 * SECOND

/**
 * Run `fn` while holding the lock at `lockPath`.
 *
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withLock (lockPath, fn) {
  await util.promisify((/** @type {(err: Error | null) => void} */ cb) => {
    lockfile.lock(lockPath, {
      wait: 10 * MINUTE,
      pollPeriod: 200,
      stale: 10 * MINUTE
    }, cb)
  })()
  try {
    return await fn()
  } finally {
    lockfile.unlockSync(lockPath)
  }
}

module.exports = { withLock }
