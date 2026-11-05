'use strict'

// The package manager npr installs bin deps with, and the arguments it
// passes to each one.

const fs = require('node:fs')
const path = require('node:path')

const { UserError } = require('./log.js')
const proc = require('./proc.js')

/**
 * @typedef {'npm' | 'pnpm'} ManagerName
 */

/**
 * @typedef {{
 *   name: ManagerName,
 *   command: string[],
 *   source: string,
 *   lockfile: string
 * }} Manager
 */

/** @type {Record<ManagerName, string>} */
const LOCKFILES = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml'
}

/**
 * @param {ManagerName} name
 * @param {string[]} command
 * @param {string} source
 * @returns {Manager}
 */
function makeManager (name, command, source) {
  return { name, command, source, lockfile: LOCKFILES[name] }
}

/**
 * The manager a command word names: `pnpm`, `/usr/bin/npm`,
 * `pnpm.cmd` and so on.
 *
 * @param {string} word
 * @returns {ManagerName | null}
 */
function managerWord (word) {
  const base = path.basename(word).replace(/\.(cmd|exe|bat|ps1)$/i, '')
  return base === 'npm' || base === 'pnpm' ? base : null
}

/**
 * Pick the package manager for a project, in this order:
 *
 * 1. "binDependenciesInstaller" in package.json, a command line such
 *    as "pnpm" or "socket pnpm"; its last npm/pnpm word names the
 *    manager.
 * 2. "packageManager" in package.json.
 * 3. A lockfile beside package.json (pnpm-lock.yaml, package-lock.json).
 * 4. $npm_config_user_agent (set by `npm run` / `pnpm run`).
 * 5. npm.
 *
 * @param {import('./project.js').Project} project
 * @param {NodeJS.ProcessEnv} env
 * @returns {Manager}
 */
function detectManager (project, env) {
  const installer = project.pkg.binDependenciesInstaller
  if (installer !== undefined) {
    const command = typeof installer === 'string'
      ? installer.trim().split(/\s+/).filter(Boolean)
      : []
    const name = command.slice().reverse().map(managerWord).find(Boolean)
    if (!name) {
      throw new UserError(
        `"binDependenciesInstaller" must run npm or pnpm; got ${JSON.stringify(installer)}`,
        ['e.g. "pnpm", "npm" or "socket pnpm"']
      )
    }
    return makeManager(name, command, 'binDependenciesInstaller')
  }

  const pm = project.pkg.packageManager
  if (typeof pm === 'string') {
    const m = /^(npm|pnpm)@/.exec(pm.trim())
    if (m) {
      const name = /** @type {ManagerName} */ (m[1])
      return makeManager(name, [name], 'packageManager')
    }
  }

  if (fs.existsSync(path.join(project.root, 'pnpm-lock.yaml'))) {
    return makeManager('pnpm', ['pnpm'], 'pnpm-lock.yaml')
  }
  for (const file of ['package-lock.json', 'npm-shrinkwrap.json']) {
    if (fs.existsSync(path.join(project.root, file))) {
      return makeManager('npm', ['npm'], file)
    }
  }

  const agent = env.npm_config_user_agent || ''
  const m = /^(npm|pnpm)\//.exec(agent)
  if (m) {
    const name = /** @type {ManagerName} */ (m[1])
    return makeManager(name, [name], 'npm_config_user_agent')
  }

  return makeManager('npm', ['npm'], 'default')
}

/**
 * Arguments that (re)write the lockfile without installing.
 *
 * @param {Manager} m
 * @returns {string[]}
 */
function resolveArgs (m) {
  if (m.name === 'pnpm') {
    return ['install', '--lockfile-only', '--no-frozen-lockfile']
  }
  return ['install', '--package-lock-only', '--no-audit', '--no-fund']
}

/**
 * Arguments that add packages to package.json and the lockfile,
 * without installing.
 *
 * @param {Manager} m
 * @param {string[]} specs
 * @returns {string[]}
 */
function addArgs (m, specs) {
  if (m.name === 'pnpm') {
    return ['add', '--lockfile-only', '--save-exact', '--save-prod', ...specs]
  }
  return [
    'install', '--package-lock-only', '--save-exact', '--save-prod',
    '--no-audit', '--no-fund', ...specs
  ]
}

/**
 * Arguments that install exactly what the lockfile says.
 *
 * @param {Manager} m
 * @returns {string[]}
 */
function frozenArgs (m) {
  if (m.name === 'pnpm') return ['install', '--frozen-lockfile']
  return ['ci', '--no-audit', '--no-fund']
}

/**
 * Run the manager with `args` in `cwd`.
 *
 * @param {Manager} m
 * @param {string[]} args
 * @param {string} cwd
 * @param {import('node:child_process').StdioOptions} [stdio]
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null }>}
 */
function runManager (m, args, cwd, stdio) {
  return proc.run(m.command[0], m.command.slice(1).concat(args), { cwd, stdio })
}

/**
 * How to show a manager command in messages.
 *
 * @param {Manager} m
 * @param {string[]} args
 * @returns {string}
 */
function describe (m, args) {
  return m.command.concat(args).map((a) => path.isAbsolute(a) ? path.basename(a) : a).join(' ')
}

module.exports = {
  LOCKFILES,
  makeManager,
  managerWord,
  detectManager,
  resolveArgs,
  addArgs,
  frozenArgs,
  runManager,
  describe
}
