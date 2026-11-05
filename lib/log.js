'use strict'

// npr's own messages. They go to stderr so a tool's stdout (and the
// output of `npr which`) stays clean for pipes and $(...).

/**
 * @returns {boolean}
 */
function useColor () {
  if (process.env.NO_COLOR) return false
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true
  return Boolean(process.stderr.isTTY)
}

/**
 * @param {string} text
 * @returns {string}
 */
function green (text) {
  return useColor() ? '\u001b[32m' + text + '\u001b[39m' : text
}

/**
 * @param {string} text
 * @returns {string}
 */
function red (text) {
  return useColor() ? '\u001b[31m' + text + '\u001b[39m' : text
}

/**
 * A status line: `npr: <msg>` on stderr.
 *
 * @param {string} msg
 */
function info (msg) {
  process.stderr.write(green('npr: ' + msg) + '\n')
}

/**
 * An error line: `npr: ERROR <msg>` on stderr.
 *
 * @param {string} msg
 */
function error (msg) {
  process.stderr.write(red('npr: ERROR ' + msg) + '\n')
}

/**
 * An error the cli reports and exits 1 on, without a stack trace.
 */
class UserError extends Error {
  /**
   * @param {string} message
   * @param {string[]} [hints]  extra lines printed after the message
   */
  constructor (message, hints) {
    super(message)
    this.name = 'UserError'
    this.hints = hints || []
  }
}

module.exports = { info, error, green, red, UserError }
