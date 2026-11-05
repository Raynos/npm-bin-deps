#!/usr/bin/env node
'use strict'

// npr / nbd / npm-bin-deps: run the CLIs listed in "binDependencies"
// without installing them into the project's node_modules.

const { main } = require('./lib/cli.js')
const log = require('./lib/log.js')

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  }, (err) => {
    if (err instanceof log.UserError) {
      log.error(err.message)
      for (const hint of err.hints) log.info(hint)
    } else {
      process.stderr.write((err && err.stack) || String(err))
      process.stderr.write('\n')
    }
    process.exitCode = 1
  })
}

module.exports = { main }
