#!/usr/bin/env node
'use strict'

const execSync = require('child_process').execSync
const spawn = require('child_process').spawn
const os = require('os')
const path = require('path')
const fs = require('fs')

const mkdirp = require('./mkdirp.js').sync

class NpmBinDeps {
  constructor () {
    this.argv = process.argv.slice(2)
  }

  async main () {
    const argv = this.argv
    if (!argv[0] || argv[0] === '-h' || argv[0] === '--help') {
      return printHelp()
    }

    const packageJSON = fs.readFileSync(
      path.join(process.cwd(), 'package.json'), 'utf8'
    )
    const pkg = JSON.parse(packageJSON)
    if (!pkg.binDependencies) {
      console.error(`
The "binDependencies" fields is missing from package.json.
This is required for use with \`npr\``
      )
      return process.exit(1)
    }

    const targetDir = path.join(
      os.homedir(), '.config', 'npm-bin-deps', pkg.name
    )
    mkdirp(targetDir)

    /**
     * Fresh installation
     */
    if (!fs.existsSync(path.join(targetDir, 'package.json'))) {
      console.log(green(`npr: first time npm install`))
      this.writePackageAndInstall(pkg, targetDir)
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
          green(`npr: binDependencies changed => npm installs`)
        )
        this.writePackageAndInstall(pkg, targetDir)
      }
    }

    const command = argv[0]
    const args = argv.slice(1)

    if (command === 'which') {
      const binary = path.join(
        targetDir, 'node_modules', '.bin', argv[1]
      )
      console.log(binary)
      process.exit(0)
    }

    let binary = path.join(
      targetDir, 'node_modules', '.bin', command
    )
    if (process.platform === 'win32') {
      binary += '.cmd'
    }
    const proc = spawn(binary, args, {
      cwd: process.cwd(),
      stdio: 'inherit'
    })

    proc.on('close', (code) => {
      process.exit(code)
    })
  }

  writePackageAndInstall (pkg, targetDir) {
    const pkgCopy = { ...pkg }
    pkgCopy.dependencies = pkgCopy.binDependencies
    pkgCopy.devDependencies = {}
    pkgCopy.peerDependencies = {}
    pkgCopy.scripts = {}

    fs.writeFileSync(
      path.join(targetDir, 'package.json'),
      JSON.stringify(pkgCopy, null, 2),
      'utf8'
    )
    execSync(`npm install --loglevel notice`, {
      cwd: targetDir
    })
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
  console.log(`npr [module] [...args]`)
  console.log('NPR will run npm package binaries')
  console.log()
  console.log('This tool is similar to `npx` except it respects')
  console.log('The binDependencies listed in your package.json')
  console.log('')
  console.log('It will use the version of the module listed')
  console.log('in binDependencies to run the package binary.')
  process.exit(0)
}

function green (text) {
  return '\u001b[32m' + text + '\u001b[39m'
}
