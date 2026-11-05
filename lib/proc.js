'use strict'

// Spawning children the same way on macOS, Linux and Windows.
//
// On Windows npm, pnpm and every node_modules/.bin entry are `.cmd`
// shims, which Node refuses to spawn without a shell since the
// CVE-2024-27980 fix. So on win32 we go through `cmd.exe /d /s /c`
// with each argument escaped the way cross-spawn does it.

const childProcess = require('node:child_process')
const path = require('node:path')

const IS_WIN = process.platform === 'win32'

const META_CHARS = /([()\][%!^"`<>&|;, *?])/g

/**
 * Escape one argument for cmd.exe.
 *
 * @param {string} arg
 * @param {boolean} doubleEscape  true when the target is itself a .cmd
 *   shim, whose own `%*` expansion goes through cmd.exe a second time.
 * @returns {string}
 */
function escapeWinArg (arg, doubleEscape) {
  let out = String(arg)
  // Double the backslashes before a quote, then escape the quote.
  out = out.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  // Double trailing backslashes so they don't escape our closing quote.
  out = out.replace(/(?=(\\+?)?)\1$/, '$1$1')
  out = `"${out}"`
  out = out.replace(META_CHARS, '^$1')
  if (doubleEscape) out = out.replace(META_CHARS, '^$1')
  return out
}

/**
 * Escape the command (the program) for cmd.exe.
 *
 * @param {string} cmd
 * @returns {string}
 */
function escapeWinCommand (cmd) {
  return cmd.replace(META_CHARS, '^$1')
}

/**
 * The file, args and options that run `cmd args` on this platform.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @returns {{ file: string, args: string[], windowsVerbatimArguments: boolean }}
 */
function spawnArgs (cmd, args) {
  if (!IS_WIN) {
    return { file: cmd, args, windowsVerbatimArguments: false }
  }
  const isShim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(cmd)
  const program = path.isAbsolute(cmd) ? path.normalize(cmd) : cmd
  const line = [escapeWinCommand(program)]
    .concat(args.map((a) => escapeWinArg(a, isShim)))
    .join(' ')
  return {
    file: process.env.comspec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true
  }
}

/**
 * Spawn `cmd args` portably.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} options
 * @returns {import('node:child_process').ChildProcess}
 */
function spawn (cmd, args, options) {
  const s = spawnArgs(cmd, args)
  return childProcess.spawn(s.file, s.args, {
    ...options,
    windowsVerbatimArguments: s.windowsVerbatimArguments
  })
}

/**
 * Run a command to completion. stdout and stderr of the child go to our
 * stderr unless `stdio` says otherwise.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{
 *   cwd: string,
 *   env?: NodeJS.ProcessEnv,
 *   stdio?: import('node:child_process').StdioOptions
 * }} options
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null }>}
 */
function run (cmd, args, options) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: options.stdio || ['ignore', 2, 2]
    })
    proc.on('error', reject)
    proc.on('close', (code, signal) => resolve({ code, signal }))
  })
}

/**
 * The PATH key of an env object (`Path` on Windows, usually).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function pathKey (env) {
  if (!IS_WIN) return 'PATH'
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'Path'
}

module.exports = {
  IS_WIN,
  escapeWinArg,
  escapeWinCommand,
  spawnArgs,
  spawn,
  run,
  pathKey
}
