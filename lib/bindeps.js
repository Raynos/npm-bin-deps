'use strict'

// Keeping binDependenciesDir in step with binDependencies, and the
// install cache in step with binDependenciesDir.
//
// binDependenciesDir holds a generated package.json and the manager's
// native lockfile; both are committed. An install dir in the cache is
// keyed by a hash of those files and installed frozen from them.

const fs = require('node:fs')
const path = require('node:path')

const cache = require('./cache.js')
const { readPnpmSettings, pnpmWorkspaceYAML } = require('./config.js')
const log = require('./log.js')
const { UserError } = log
const managers = require('./manager.js')
const { withLock } = require('./lock.js')
const { generatedPackageJSON, writeBinDependencies } = require('./project.js')

/** @typedef {import('./project.js').Project} Project */
/** @typedef {import('./manager.js').Manager} Manager */

/**
 * @typedef {{
 *   project: Project,
 *   manager: Manager,
 *   env: NodeJS.ProcessEnv,
 *   root: string
 * }} Context
 */

/**
 * @param {Project} project
 * @param {Manager} manager
 * @param {NodeJS.ProcessEnv} env
 * @returns {Context}
 */
function makeContext (project, manager, env) {
  return { project, manager, env, root: cache.cacheRoot(env) }
}

/**
 * The files npr generates into binDependenciesDir (not the lockfile).
 *
 * @param {Context} ctx
 * @returns {Record<string, string>}
 */
function generatedFiles (ctx) {
  /** @type {Record<string, string>} */
  const files = {
    'package.json': generatedPackageJSON(ctx.project.binDependencies || {})
  }
  if (ctx.manager.name === 'pnpm') {
    // Always written: it carries the project's pnpm rules, and it makes
    // the dir its own workspace root so pnpm never walks above it.
    files['pnpm-workspace.yaml'] = pnpmWorkspaceYAML(
      readPnpmSettings(ctx.project.root, ctx.project.pkg)
    )
  }
  return files
}

/**
 * Files in binDependenciesDir that belong to the other manager.
 *
 * @param {Context} ctx
 * @returns {string[]}
 */
function otherManagerFiles (ctx) {
  if (ctx.manager.name === 'pnpm') return [managers.LOCKFILES.npm]
  return [managers.LOCKFILES.pnpm, 'pnpm-workspace.yaml']
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function readIfExists (file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Is binDependenciesDir up to date with binDependencies (and the
 * manager's settings), with a lockfile beside it?
 *
 * @param {Context} ctx
 * @returns {{ synced: boolean, reason: string }}
 */
function checkDir (ctx) {
  const want = generatedFiles(ctx)
  for (const name of Object.keys(want)) {
    const have = readIfExists(path.join(ctx.project.dir, name))
    if (have === null) return { synced: false, reason: `no ${name}` }
    if (have !== want[name]) {
      return { synced: false, reason: `${name} differs from binDependencies` }
    }
  }
  const lock = path.join(ctx.project.dir, ctx.manager.lockfile)
  if (!fs.existsSync(lock)) {
    return { synced: false, reason: `no ${ctx.manager.lockfile}` }
  }
  return { synced: true, reason: '' }
}

/**
 * binDependenciesDir relative to the project, for messages.
 *
 * @param {Context} ctx
 * @returns {string}
 */
function relDir (ctx) {
  return path.relative(ctx.project.root, ctx.project.dir) || '.'
}

/**
 * Run the manager; turn a failure into a UserError.
 *
 * @param {Context} ctx
 * @param {string[]} args
 * @param {string} cwd
 */
async function runOrThrow (ctx, args, cwd) {
  const res = await managers.runManager(ctx.manager, args, cwd)
  if (res.code !== 0) {
    const how = res.signal ? `was killed by ${res.signal}` : `exited ${res.code}`
    throw new UserError(`${managers.describe(ctx.manager, args)} ${how}`)
  }
}

/**
 * Regenerate binDependenciesDir: write the generated files into a work
 * dir with the current lockfile, let the manager update the lockfile
 * (and, for `add`, package.json), then copy the result back.
 *
 * @param {Context} ctx
 * @param {{ add?: string[] }} [op]
 */
async function resolveDir (ctx, op) {
  const work = cache.makeWorkDir(ctx.root)
  try {
    for (const [name, text] of Object.entries(generatedFiles(ctx))) {
      fs.writeFileSync(path.join(work, name), text)
    }
    const lockText = readIfExists(path.join(ctx.project.dir, ctx.manager.lockfile))
    if (lockText !== null) {
      fs.writeFileSync(path.join(work, ctx.manager.lockfile), lockText)
    }

    const args = op && op.add
      ? managers.addArgs(ctx.manager, op.add)
      : managers.resolveArgs(ctx.manager)
    log.info(`resolving bin deps with ${ctx.manager.name} (from ${ctx.manager.source}): ${managers.describe(ctx.manager, args)}`)
    await runOrThrow(ctx, args, work)

    if (op && op.add) {
      const added = JSON.parse(fs.readFileSync(path.join(work, 'package.json'), 'utf8'))
      writeBinDependencies(ctx.project, added.dependencies || {})
    }

    fs.mkdirSync(ctx.project.dir, { recursive: true })
    for (const [name, text] of Object.entries(generatedFiles(ctx))) {
      fs.writeFileSync(path.join(ctx.project.dir, name), text)
    }
    fs.copyFileSync(
      path.join(work, ctx.manager.lockfile),
      path.join(ctx.project.dir, ctx.manager.lockfile)
    )
    for (const name of otherManagerFiles(ctx)) {
      const file = path.join(ctx.project.dir, name)
      if (fs.existsSync(file)) {
        log.info(`removing ${relDir(ctx)}/${name}; ${ctx.manager.name} is the manager now`)
        fs.rmSync(file)
      }
    }
    log.info(`wrote ${relDir(ctx)}/package.json and ${relDir(ctx)}/${ctx.manager.lockfile}`)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

/**
 * The lock that serialises rewrites of one project's bin-deps dir.
 *
 * @param {Context} ctx
 * @returns {string}
 */
function dirLockPath (ctx) {
  return path.join(ctx.root, `dir-${cache.shortHash(ctx.project.dir)}.lock`)
}

/**
 * Bring binDependenciesDir up to date if binDependencies changed.
 * With `frozen`, a stale dir is an error instead.
 *
 * @param {Context} ctx
 * @param {{ frozen?: boolean }} opts
 */
async function syncDir (ctx, opts) {
  const state = checkDir(ctx)
  if (state.synced) return
  if (opts.frozen) {
    throw new UserError(
      `binDependencies and ${relDir(ctx)}/ are out of sync (${state.reason})`,
      [`Run \`npr install\` and commit ${relDir(ctx)}/`]
    )
  }
  fs.mkdirSync(ctx.root, { recursive: true })
  await withLock(dirLockPath(ctx), async () => {
    const again = checkDir(ctx)
    if (again.synced) return
    log.info(`binDependencies changed (${again.reason}); updating ${relDir(ctx)}/`)
    await resolveDir(ctx)
  })
}

/**
 * The bin-deps files as they are on disk: generated files + lockfile.
 *
 * @param {Context} ctx
 * @returns {Record<string, string>}
 */
function dirFiles (ctx) {
  /** @type {Record<string, string>} */
  const files = {}
  const names = Object.keys(generatedFiles(ctx)).concat(ctx.manager.lockfile)
  for (const name of names) {
    const text = readIfExists(path.join(ctx.project.dir, name))
    if (text !== null) files[name] = text
  }
  return files
}

/**
 * The cache install dir for the current bin-deps files.
 *
 * @param {Context} ctx
 * @returns {string}
 */
function installDirFor (ctx) {
  return path.join(ctx.root, cache.hashFiles(ctx.manager.name, dirFiles(ctx)))
}

/**
 * Make sure the cache holds a finished install of binDependenciesDir.
 * Returns the install dir.
 *
 * @param {Context} ctx
 * @param {{ frozen?: boolean }} opts
 * @returns {Promise<string>}
 */
async function ensureInstalled (ctx, opts) {
  await syncDir(ctx, opts)

  const files = dirFiles(ctx)
  const installDir = path.join(ctx.root, cache.hashFiles(ctx.manager.name, files))
  if (cache.isInstalled(installDir)) {
    cache.touch(installDir)
    return installDir
  }

  fs.mkdirSync(ctx.root, { recursive: true })
  await withLock(installDir + '.lock', async () => {
    if (cache.isInstalled(installDir)) return
    fs.rmSync(installDir, { recursive: true, force: true })
    fs.mkdirSync(installDir, { recursive: true })
    for (const [name, text] of Object.entries(files)) {
      fs.writeFileSync(path.join(installDir, name), text)
    }
    const args = managers.frozenArgs(ctx.manager)
    log.info(`installing bin deps: ${managers.describe(ctx.manager, args)}`)
    try {
      await runOrThrow(ctx, args, installDir)
    } catch (err) {
      fs.rmSync(installDir, { recursive: true, force: true })
      throw err
    }
    cache.markInstalled(installDir)
    log.info(`install finished in ${installDir}`)
  })
  return installDir
}

/**
 * `npr install <specs...>`: add packages to binDependencies.
 *
 * @param {Context} ctx
 * @param {string[]} specs
 * @returns {Promise<string>}
 */
async function addPackages (ctx, specs) {
  fs.mkdirSync(ctx.root, { recursive: true })
  await withLock(dirLockPath(ctx), async () => {
    await resolveDir(ctx, { add: specs })
  })
  return ensureInstalled(ctx, {})
}

/**
 * `npr rm <names...>`: drop packages from binDependencies.
 *
 * @param {Context} ctx
 * @param {string[]} names
 * @returns {Promise<string>}
 */
async function removePackages (ctx, names) {
  const deps = { ...(ctx.project.binDependencies || {}) }
  for (const name of names) {
    if (!(name in deps)) {
      log.info(`${name} is not in binDependencies`)
    }
    delete deps[name]
  }
  writeBinDependencies(ctx.project, deps)
  return ensureInstalled(ctx, {})
}

module.exports = {
  makeContext,
  checkDir,
  syncDir,
  dirFiles,
  installDirFor,
  ensureInstalled,
  addPackages,
  removePackages
}
