'use strict'

// The install cache: one dir per distinct set of bin-deps files, keyed
// by a sha256 of them, under ~/.cache/npm-bin-deps.

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Written into an install dir once its install finished. */
const MARKER = '.npr-installed'

/**
 * The cache root: $XDG_CACHE_HOME/npm-bin-deps, else on Windows
 * %LOCALAPPDATA%\npm-bin-deps, else ~/.cache/npm-bin-deps.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function cacheRoot (env) {
  const xdg = env.XDG_CACHE_HOME
  if (xdg && path.isAbsolute(xdg)) {
    return path.join(xdg, 'npm-bin-deps')
  }
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    return path.join(env.LOCALAPPDATA, 'npm-bin-deps')
  }
  return path.join(os.homedir(), '.cache', 'npm-bin-deps')
}

/**
 * A short sha256 hex of some text.
 *
 * @param {string} text
 * @returns {string}
 */
function shortHash (text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32)
}

/**
 * The cache key of a set of bin-deps files: the lockfile, plus the
 * generated package.json and config that the install also reads.
 *
 * @param {string} managerName
 * @param {Record<string, string>} files  name -> contents
 * @returns {string}
 */
function hashFiles (managerName, files) {
  const hash = crypto.createHash('sha256')
  hash.update(managerName + '\0')
  for (const name of Object.keys(files).sort()) {
    hash.update(name + '\0' + files[name] + '\0')
  }
  return hash.digest('hex').slice(0, 32)
}

/**
 * Has the install in `dir` finished?
 *
 * @param {string} dir
 * @returns {boolean}
 */
function isInstalled (dir) {
  return fs.existsSync(path.join(dir, MARKER))
}

/**
 * Mark the install in `dir` finished.
 *
 * @param {string} dir
 */
function markInstalled (dir) {
  fs.writeFileSync(path.join(dir, MARKER), new Date().toISOString() + '\n')
}

/**
 * Record that `dir` was used now; `npr cache prune` reads this.
 *
 * @param {string} dir
 */
function touch (dir) {
  const now = new Date()
  try {
    fs.utimesSync(path.join(dir, MARKER), now, now)
  } catch (_err) {
    // A read-only cache still runs; it just can't be pruned by age.
  }
}

/**
 * When `dir` was last used, in ms since the epoch.
 *
 * @param {string} dir
 * @returns {number}
 */
function lastUsed (dir) {
  return fs.statSync(path.join(dir, MARKER)).mtimeMs
}

const DAY = 24 * 60 * 60 * 1000

/**
 * Remove install dirs unused for `days` days, plus leftovers from
 * crashed installs (work dirs and unfinished install dirs older than a
 * day). Returns what was removed.
 *
 * @param {string} root
 * @param {{ days: number, now?: number }} opts
 * @returns {{ removed: string[], kept: string[] }}
 */
function prune (root, opts) {
  const now = opts.now || Date.now()
  /** @type {string[]} */
  const removed = []
  /** @type {string[]} */
  const kept = []

  /** @type {fs.Dirent[]} */
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return { removed, kept }
    }
    throw err
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    let stale
    if (isInstalled(dir)) {
      stale = now - lastUsed(dir) > opts.days * DAY
    } else {
      stale = now - fs.statSync(dir).mtimeMs > DAY
    }
    if (stale) {
      fs.rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    } else {
      kept.push(dir)
    }
  }
  return { removed, kept }
}

/**
 * A fresh scratch dir directly under the cache root. Work dirs sit
 * beside the install dirs so relative `file:` paths in a lockfile
 * resolve the same in both.
 *
 * @param {string} root
 * @returns {string}
 */
function makeWorkDir (root) {
  fs.mkdirSync(root, { recursive: true })
  return fs.mkdtempSync(path.join(root, '.work-'))
}

module.exports = {
  MARKER,
  cacheRoot,
  shortHash,
  hashFiles,
  isInstalled,
  markInstalled,
  touch,
  lastUsed,
  prune,
  makeWorkDir
}
