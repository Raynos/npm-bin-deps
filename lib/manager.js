'use strict'

// The package manager npr installs bin deps with, and the arguments it
// passes to each one.

const path = require('node:path')

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
 * Pick the package manager for a project.
 *
 * @param {import('./project.js').Project} _project
 * @param {NodeJS.ProcessEnv} _env
 * @returns {Manager}
 */
function detectManager (_project, _env) {
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
  detectManager,
  resolveArgs,
  addArgs,
  frozenArgs,
  runManager,
  describe
}
