#!/usr/bin/env node
'use strict'

// TEST PULL REQUEST.

const spawn = require('child_process').spawn
const os = require('os')
const path = require('path')
const fs = require('fs')
const util = require('util')

const lockfile = require('./lockfile.js')
const rimraf = require('./rimraf.js')

const SECOND = 1000
const MINUTE = 60 * SECOND

class NpmBinDeps {
  constructor () {
    this.argv = process.argv.slice(2)
  }

  cacheClean (targetDir) {
    console.log(green('npr: cache clean'))

    rimraf.sync(targetDir, { disableGlob: true })
  }

  async installBinDependency (currPkg, targetDir) {
    console.log(green('npr: Installing new bin dependency'))

    /**
     * Fresh installation
     */
    if (!fs.existsSync(path.join(targetDir, 'package.json'))) {
      await this.writePackage(currPkg, targetDir)
    }

    const packageJSONFile = path.join(process.cwd(), 'package.json')
    const args = this.argv.slice(1)
    args.push('--save-exact')
    args.push('--save-prod')

    await this.npmInstall(targetDir, args)

    const packageJSON = fs.readFileSync(
      path.join(targetDir, 'package.json'), 'utf8'
    )
    const existingPkg = JSON.parse(packageJSON)

    currPkg.binDependencies = existingPkg.dependencies
    fs.writeFileSync(
      packageJSONFile,
      JSON.stringify(currPkg, null, 2) + '\n',
      'utf8'
    )
  }

  async rmBinDependency (currPkg, targetDir) {
    console.log(green('npr: Removing a bin dependency'))

    const packageJSONFile = path.join(process.cwd(), 'package.json')
    const args = this.argv.slice(1)
    args.push('--save-exact')
    args.push('--save-prod')
    args.push('--loglevel')
    args.push('http')

    await this.npmCommand(targetDir, ['rm', ...args])

    const packageJSON = fs.readFileSync(
      path.join(targetDir, 'package.json'), 'utf8'
    )
    const existingPkg = JSON.parse(packageJSON)
    currPkg.binDependencies = existingPkg.dependencies
    fs.writeFileSync(
      packageJSONFile,
      JSON.stringify(currPkg, null, 2) + '\n',
      'utf8'
    )
  }

  async main () {
    const argv = this.argv
    if (argv[0] === '-h') {
      return printShortHelp()
    }
    if (!argv[0] || argv[0] === '--help' || argv[0] === 'help') {
      return printHelp()
    }

    const packageJSONFile = path.join(process.cwd(), 'package.json')
    let pkg
    try {
      const packageJSON = fs.readFileSync(
        packageJSONFile, 'utf8'
      )
      pkg = JSON.parse(packageJSON)
    } catch (err) {
      console.error(green(
        'npr: Could not ready your application package.json'
      ))
      console.error(green(
        `npr: Expected valid package.json at ${packageJSONFile}`
      ))
      throw err
    }
    if (!pkg.binDependencies && argv[0] !== 'install') {
      console.error(green(
        'npr: The "binDependencies" fields is missing ' +
        'from package.json.'
      ))
      console.error(green('npr: This is required for use with `npr`'))
      return process.exit(1)
    }

    const targetDir = path.join(
      os.homedir(), '.config', 'npm-bin-deps', pkg.name
    )
    fs.mkdirSync(targetDir, { recursive: true })

    if (argv[0] === 'install') {
      return this.installBinDependency(pkg, targetDir)
    }
    if (argv[0] === 'rm') {
      return this.rmBinDependency(pkg, targetDir)
    }
    if (argv[0] === 'ls') {
      const cmd = ['ls']
      if (argv.length > 1) {
        cmd.push(...argv.slice(1))
      }
      return this.npmCommand(targetDir, cmd)
    }
    // TODO: argv[0] rebuild
    // TODO: argv[0] update
    if (argv[0] === 'cache' && argv[1] === 'clean') {
      return this.cacheClean(targetDir)
    }

    let command = argv[0]
    let args = argv.slice(1)

    const lockPath = path.join(targetDir, 'npm-bin-deps.lock')
    await util.promisify((cb) => {
      lockfile.lock(lockPath, {
        wait: 1 * MINUTE,
        pollPeriod: 500,
        stale: 5 * MINUTE
      }, (err) => {
        if (err) {
          console.error(green(
            'npr: Could not acquire lock for concurrent NPR'
          ))
        }
        cb(err)
      })
    })()

    /**
     * Fresh installation
     */
    if (!fs.existsSync(path.join(targetDir, 'package.json'))) {
      console.log(green('npr: first time npm install'))
      await this.writePackageAndInstall(pkg, targetDir)
      console.log(green(`npr: install finished, running ${command}`))
    } else {
      /**
       * Check to see if deps changed.
       */
      const packageJSON = fs.readFileSync(
        path.join(targetDir, 'package.json'), 'utf8'
      )
      const existingPkg = JSON.parse(packageJSON)
      const changed = haveDependenciesChanged(pkg, existingPkg)
      if (changed) {
        console.log(
          green('npr: binDependencies changed => npm installs')
        )
        await this.writePackageAndInstall(pkg, targetDir)
        console.log(green(`npr: install finished, running ${command}`))
      }
    }

    lockfile.unlockSync(lockPath)

    if (command === 'which') {
      let binary = path.join(
        targetDir, 'node_modules', '.bin', argv[1]
      )
      if (process.platform === 'win32') {
        binary += '.cmd'
      }
      console.log(binary)
      process.exit(0)
    }

    if (command === 'exec') {
      command = argv[1]
      args = args.slice(1)
    }

    let binary = path.join(
      targetDir, 'node_modules', '.bin', command
    )
    if (process.platform === 'win32') {
      binary += '.cmd'
    }

    try {
      fs.statSync(binary)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err

      console.error(green(`npr: ERROR Could not find command: ${command}`))
      console.error(green(`npr: ERROR The file ${binary} does not exist.`))

      console.error(green('npr: Checking node_modules integrity with npm ls'))
      const out = await this.npmCommand(targetDir, ['ls'], false, true)
      if (out && typeof out.exitCode === 'number') {
        console.error(green('npr: npm ls failed; deleting cached node_modules'))
      }

      let files
      try {
        files = fs.readdirSync(path.dirname(binary))
      } catch (_err) {
        // Ignore; best effort
      }

      if (files) {
        console.error(green('npr: The following commands DO exist.'))

        const lines = []
        for (const file of files) {
          let line = lines[lines.length - 1]
          if (!line) {
            line = []
            lines.push(line)
          }

          if ((line.join(' ').length + file.length + 1) >= 80) {
            line = []
            lines.push(line)
          }

          line.push(file)
        }
        for (const line of lines) {
          console.log('--  ' + line.join(' '))
        }
      }
      return process.exit(1)
    }

    const proc = spawn(binary, args, {
      cwd: process.cwd(),
      stdio: 'inherit'
    })

    proc.on('close', (code) => {
      process.exit(code)
    })
  }

  async writePackage (pkg, targetDir) {
    const pkgCopy = { ...pkg }
    pkgCopy.dependencies = pkgCopy.binDependencies
    pkgCopy.devDependencies = {}
    pkgCopy.peerDependencies = {}
    pkgCopy.scripts = {}

    const packageJSONFile = path.join(targetDir, 'package.json')
    try {
      fs.writeFileSync(
        packageJSONFile,
        JSON.stringify(pkgCopy, null, 2),
        'utf8'
      )
    } catch (err) {
      console.error(green('npr: Could not write temporary package.json'))
      console.error(green(`npr: Attempted to write ${packageJSONFile}`))
      throw err
    }
  }

  async writePackageAndInstall (pkg, targetDir) {
    await this.writePackage(pkg, targetDir)
    return this.npmInstall(targetDir)
  }

  async npmInstall (targetDir, args) {
    let cmd = ['install', '--loglevel', 'http']
    if (args && Array.isArray(args) && args.length > 0) {
      cmd = cmd.concat(args)
    }

    return this.npmCommand(targetDir, cmd, true)
  }

  async npmCommand (targetDir, cmd, prefixStdout, silent) {
    const command = cmd[0]
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const npmProc = spawn(npmCmd, cmd, { cwd: targetDir })

    const stdoutLines = []
    npmProc.stdout.on('data', (buf) => {
      const lines = buf.toString('utf8').trim().split('\n')
      for (const l of lines) {
        stdoutLines.push(l)

        if (silent) continue
        if (l === '') {
          console.log('')
          continue
        }
        if (prefixStdout) {
          console.log(green(`npm ${command} STDOUT: `) + l)
        } else {
          console.log(l)
        }
      }
    })
    npmProc.stderr.on('data', (buf) => {
      const lines = buf.toString('utf8').trim().split('\n')

      if (silent) return
      for (const l of lines) {
        if (l === '') {
          console.error('')
          continue
        }
        if (prefixStdout) {
          console.error(green(`npm ${command} STDERR: `) + l)
        } else {
          console.error(l)
        }
      }
    })

    return await util.promisify((cb) => {
      npmProc.on('close', (code) => {
        if (code !== 0) {
          console.log(green(`npm ${command} exited non-zero ${code}`))
          fs.unlinkSync(path.join(targetDir, 'package.json'))
          return cb(null, { exitCode: code })
        }
        cb(null, stdoutLines)
      })
    })()
  }
}

if (require.main === module) {
  const binDeps = new NpmBinDeps()
  binDeps.main().then(null, (err) => {
    process.nextTick(() => { throw err })
  })
}

function haveDependenciesChanged (userPkg, existingPkg) {
  let hasChanged = false
  for (const key of Object.keys(userPkg.binDependencies)) {
    const current = userPkg.binDependencies[key]
    const existing = existingPkg.dependencies[key]
    if (current !== existing) {
      hasChanged = true
      break
    }
  }

  if (
    Object.keys(userPkg.binDependencies).length !==
    Object.keys(existingPkg.dependencies).length
  ) {
    hasChanged = true
  }

  return hasChanged
}

function printShortHelp () {
  console.log('usage: npr [bindep] [...args]')
  console.log('`npr` will execute your binary dependency')
  console.log('')
  console.log('For other commands see npr --help')
}

function printHelp () {
  const l = console.log
  l('usage: npr [bindep] [...args]')
  l('`npr` will execute your binary dependency')
  l('')
  l('`npr` respects the dependencies listed in "binDependencies" in package.json')
  l('These are command `npr` commands used in various situations:')
  l('')
  l('Run a binary command')
  l('    npr [bindep]       Run a command; e.g. npr standard or npr tap')
  l('    npr exec [bindep]  Run a command; e.g. npr exec standard or npr exec tap')
  l('')
  l('Install or remove a binary dependency')
  l('    npr install [bindep]  Install a new binary dependency')
  l('    npr rm [bindep]       Remove a binary dependency')
  l('')
  l('Clean the cache; if corrupted or broken')
  l('    npr cache clean       Clean the npr install cache.')
  l('')
  l('Inspect existing bin dependencies')
  l('    npr which [bindep]  Return the binary location for bindep')
  l('    npr ls              List all binary deps installed.')
  l('')
  l('When running `npr`; you can hand-edit "binDependencies" in package.json and')
  l('the `npr exec [bindep]` command will make sure to download the new version')
  l('before executing the binary dependency.')
  l('')
  process.exit(0)
}

function green (text) {
  return '\u001b[32m' + text + '\u001b[39m'
}
