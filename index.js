#!/usr/bin/env node
'use strict'

const spawn = require('child_process').spawn
const os = require('os')
const path = require('path')
const fs = require('fs')
const util = require('util')

const lockfile = require('./lockfile.js')
const rimraf = require('./rimraf.js')

const SECOND = 1000
const MINUTE = 60 * SECOND
const WHITELIST_COMMANDS = [
  'cache', 'help', 'exec', 'ls', 'install', 'rm', 'which'
]

class NpmBinDeps {
  constructor () {
    this.argv = process.argv.slice(2)
  }

  cacheClean (targetDir) {
    console.log(green('npr: cache clean'))

    rimraf.sync(targetDir)
  }

  async installBinDependency (currPkg, targetDir) {
    console.log(green('npr: Installing new bin dependency'))

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
    if (
      !argv[0] ||
      argv[0] === '-h' ||
      argv[0] === '--help' ||
      argv[0] === 'help'
    ) {
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

  async writePackageAndInstall (pkg, targetDir) {
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

    return this.npmInstall(targetDir)
  }

  async npmInstall (targetDir, args) {
    let cmd = ['install', '--loglevel', 'http']
    if (args && Array.isArray(args) && args.length > 0) {
      cmd = cmd.concat(args)
    }

    return this.npmCommand(targetDir, cmd, true)
  }

  async npmCommand (targetDir, cmd, prefixStdout) {
    const command = cmd[0]
    const npmProc = spawn(
      'npm', cmd, { cwd: targetDir }
    )

    const stdoutLines = []
    npmProc.stdout.on('data', (buf) => {
      const lines = buf.toString('utf8').trim().split('\n')
      for (const l of lines) {
        stdoutLines.push(l)
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

    await util.promisify((cb) => {
      npmProc.on('close', (code) => {
        if (code !== 0) {
          console.log(green(`npm ${command} exited non-zero ${code}`))
          fs.unlinkSync(path.join(targetDir, 'package.json'))
          return cb(null)
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

function printHelp () {
  console.log('npr [module] [...args]')
  console.log('NPR will run npm package binaries')
  console.log()
  console.log('This tool is similar to `npx` except it respects')
  console.log('The binDependencies listed in your package.json')
  console.log('')
  console.log('It will use the version of the module listed')
  console.log('in binDependencies to run the package binary.')
  console.log('')
  console.log('If you want to install new bin dependencies you can')
  console.log('  run `npr install x`.')
  console.log('This runs `npr` and updates binDependencies.')
  console.log('')
  console.log('Sometimes the cache can be corrupted.')
  console.log('  You can run `npr cache clean` to clean the cache.')
  console.log('')
  console.log('Sometimes you want to know where the actual binary is.')
  console.log('  You can run `npr which browserify` and it will print')
  console.log('  the path to the browserify binary, like the which cmd')
  process.exit(0)
}

function green (text) {
  return '\u001b[32m' + text + '\u001b[39m'
}
