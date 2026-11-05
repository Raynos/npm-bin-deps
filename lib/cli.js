'use strict'

// The `npr` command line.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const bindeps = require('./bindeps.js')
const { cacheRoot, prune } = require('./cache.js')
const log = require('./log.js')
const { UserError } = log
const managers = require('./manager.js')
const proc = require('./proc.js')
const { readProject } = require('./project.js')

/** @typedef {import('./bindeps.js').Context} Context */

/** `npr cache prune` removes installs unused for this many days. */
const PRUNE_DAYS = 30

const SHORT_HELP = [
  'usage: npr [bindep] [...args]',
  '`npr` will execute your binary dependency',
  '',
  'For other commands see npr --help'
]

const HELP = [
  'usage: npr [bindep] [...args]',
  '`npr` will execute your binary dependency',
  '',
  '`npr` respects the dependencies listed in "binDependencies" in package.json',
  'These are the `npr` commands used in various situations:',
  '',
  'Run a binary command',
  '    npr [bindep]       Run a command; e.g. npr standard or npr tap',
  '    npr exec [bindep]  Run a command; e.g. npr exec standard or npr exec tap',
  '',
  'Install or remove a binary dependency',
  '    npr install [bindep]  Install a new binary dependency',
  '    npr rm [bindep]       Remove a binary dependency',
  '    npr install           Update the lockfile from binDependencies and install',
  '    npr install --frozen  Install exactly what the lockfile says; fail if stale',
  '',
  'Clean the cache; if corrupted or broken',
  '    npr cache clean       Clean the npr install cache.',
  '    npr cache prune       Remove cached installs unused for 30 days.',
  '',
  'Inspect existing bin dependencies',
  '    npr which [bindep]  Return the binary location for bindep',
  '    npr ls              List all binary deps installed.',
  '',
  'When running `npr`; you can hand-edit "binDependencies" in package.json and',
  'the `npr exec [bindep]` command will make sure to download the new version',
  'before executing the binary dependency.',
  '',
  'package.json fields',
  '    binDependencies     The bin deps; { "name": "version" }',
  '    binDependenciesDir  Where npr keeps the generated package.json and',
  '                        lockfile; commit it. Default ".bin-deps".',
  '    binDependenciesInstaller  The install command, e.g. "pnpm" or',
  '                        "socket pnpm". Default: detected from',
  '                        "packageManager", the lockfile, then npm.',
  ''
]

/**
 * @param {string[]} lines
 */
function print (lines) {
  process.stdout.write(lines.join('\n') + '\n')
}

/**
 * Load the project in cwd and make a context for it.
 *
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {Context}
 */
function loadContext (cwd, env) {
  const project = readProject(cwd)
  const manager = managers.detectManager(project, env)
  return bindeps.makeContext(project, manager, env)
}

/**
 * Fail like 1.x when the project has no binDependencies.
 *
 * @param {Context} ctx
 */
function requireBinDependencies (ctx) {
  if (!ctx.project.binDependencies) {
    throw new UserError('The "binDependencies" field is missing from package.json.', [
      'This is required for use with `npr`'
    ])
  }
}

/**
 * The bin's file in an install dir.
 *
 * @param {string} installDir
 * @param {string} name
 * @returns {string}
 */
function binPath (installDir, name) {
  const file = path.join(installDir, 'node_modules', '.bin', name)
  return proc.IS_WIN ? file + '.cmd' : file
}

/**
 * Tell the user a bin is missing and list the ones that exist.
 *
 * @param {string} name
 * @param {string} binary
 */
function reportMissingBin (name, binary) {
  log.error(`Could not find command: ${name}`)
  log.error(`The file ${binary} does not exist.`)

  /** @type {string[]} */
  let files = []
  try {
    files = fs.readdirSync(path.dirname(binary))
  } catch (_err) {
    return
  }
  if (proc.IS_WIN) {
    files = Array.from(new Set(files.map((f) => f.replace(/\.(cmd|ps1)$/i, ''))))
  }
  files.sort()
  log.info('The following commands DO exist.')

  /** @type {string[][]} */
  const lines = [[]]
  for (const file of files) {
    let line = lines[lines.length - 1]
    if (line.length > 0 && (line.join(' ').length + file.length + 1) >= 80) {
      line = []
      lines.push(line)
    }
    line.push(file)
  }
  for (const line of lines) {
    if (line.length > 0) process.stderr.write('--  ' + line.join(' ') + '\n')
  }
}

/**
 * Run a bin from an install dir with stdio inherited; resolve with the
 * exit code to use. If the bin dies of a signal, npr dies of it too.
 *
 * @param {string} installDir
 * @param {string} name
 * @param {string[]} args
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
function runBin (installDir, name, args, cwd, env) {
  const binary = binPath(installDir, name)
  if (!fs.existsSync(binary)) {
    reportMissingBin(name, binary)
    return Promise.resolve(1)
  }

  return new Promise((resolve, reject) => {
    const child = proc.spawn(binary, args, { cwd, env, stdio: 'inherit' })

    /** @type {NodeJS.Signals[]} */
    const forwarded = ['SIGTERM', 'SIGHUP']
    /** @type {Array<[NodeJS.Signals, () => void]>} */
    const handlers = []
    for (const sig of forwarded) {
      const handler = () => { child.kill(sig) }
      handlers.push([sig, handler])
      process.on(sig, handler)
    }
    // Ctrl-C reaches the bin through the terminal's process group; npr
    // waits for the bin to finish instead of dying first.
    const onInt = () => {}
    process.on('SIGINT', onInt)

    const cleanup = () => {
      for (const [sig, handler] of handlers) process.removeListener(sig, handler)
      process.removeListener('SIGINT', onInt)
    }

    child.on('error', (err) => {
      cleanup()
      reject(err)
    })
    child.on('close', (code, signal) => {
      cleanup()
      if (signal) {
        process.kill(process.pid, signal)
        const num = os.constants.signals[signal] || 0
        resolve(128 + num)
        return
      }
      resolve(code === null ? 1 : code)
    })
  })
}

/**
 * @param {string[]} argv  arguments after `npr`
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<number>} the exit code
 */
async function main (argv, opts) {
  const cwd = (opts && opts.cwd) || process.cwd()
  const env = (opts && opts.env) || process.env

  const first = argv[0]
  if (first === '-h') {
    print(SHORT_HELP)
    return 0
  }
  if (!first || first === '--help' || first === 'help') {
    print(HELP)
    return 0
  }

  if (first === 'cache' && argv[1] === 'prune') {
    const root = cacheRoot(env)
    const { removed, kept } = prune(root, { days: PRUNE_DAYS })
    for (const dir of removed) log.info(`removed ${dir}`)
    log.info(`cache prune: removed ${removed.length}, kept ${kept.length} in ${root}`)
    return 0
  }

  const ctx = loadContext(cwd, env)

  if (first === 'install') {
    const rest = argv.slice(1)
    if (rest.includes('--frozen')) {
      if (rest.length > 1) {
        throw new UserError('`npr install --frozen` takes no packages')
      }
      requireBinDependencies(ctx)
      const dir = await bindeps.ensureInstalled(ctx, { frozen: true })
      log.info(`bin deps installed in ${dir}`)
      return 0
    }
    if (rest.length === 0) {
      requireBinDependencies(ctx)
      const dir = await bindeps.ensureInstalled(ctx, {})
      log.info(`bin deps installed in ${dir}`)
      return 0
    }
    log.info('Installing new bin dependency')
    await bindeps.addPackages(ctx, rest)
    return 0
  }

  requireBinDependencies(ctx)

  if (first === 'rm') {
    log.info('Removing a bin dependency')
    await bindeps.removePackages(ctx, argv.slice(1))
    return 0
  }

  if (first === 'cache') {
    const sub = argv[1]
    if (sub === 'clean') {
      const dir = bindeps.installDirFor(ctx)
      log.info(`cache clean: ${dir}`)
      fs.rmSync(dir, { recursive: true, force: true })
      return 0
    }
    throw new UserError(`unknown cache command: ${sub || '(none)'}`, [
      'Use `npr cache clean` or `npr cache prune`'
    ])
  }

  const installDir = await bindeps.ensureInstalled(ctx, {})

  if (first === 'ls') {
    const res = await managers.runManager(
      ctx.manager, ['ls', ...argv.slice(1)], installDir, 'inherit'
    )
    return res.code === null ? 1 : res.code
  }

  if (first === 'which') {
    process.stdout.write(binPath(installDir, argv[1] || '') + '\n')
    return 0
  }

  let name = first
  let args = argv.slice(1)
  if (first === 'exec') {
    name = argv[1]
    args = argv.slice(2)
    if (!name) throw new UserError('usage: npr exec [bindep] [...args]')
  }
  return runBin(installDir, name, args, cwd, env)
}

module.exports = { main, HELP, SHORT_HELP }
