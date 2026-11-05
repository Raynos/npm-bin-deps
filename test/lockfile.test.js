'use strict'

// Row: lockfile in binDependenciesDir.
//
// `npr install` / `npr rm` keep binDependencies, <dir>/package.json
// and the native lockfile in step; the committed dir pins every
// version, transitive ones included; `npr install --frozen` installs
// from it without changing it.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const h = require('./helpers.js')
const { startRegistry } = require('./registry.js')

const APP_BIN = `#!/usr/bin/env node
'use strict'
const pkg = require('./package.json')
const lib = require('fx-lib/package.json')
console.log(JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  lib: lib.version,
  args: process.argv.slice(2)
}))
`

/** @type {h.FixtureSpec} */
const LIB_1 = { name: 'fx-lib', version: '1.0.0', files: { 'index.js': '' } }
/** @type {h.FixtureSpec} */
const LIB_1_1 = { name: 'fx-lib', version: '1.1.0', files: { 'index.js': '' } }
/** @type {h.FixtureSpec} */
const APP = {
  name: 'fx-app',
  version: '1.0.0',
  bin: { 'fx-app': APP_BIN },
  dependencies: { 'fx-lib': '^1.0.0' }
}

/** @type {Record<string, string>} */
let fx = {}
/** @type {Record<string, string>} */
let tarballs = {}

test.before(async () => {
  fx = await h.buildFixtures([LIB_1, LIB_1_1, APP])
  for (const [key, spec] of Object.entries(fx)) {
    tarballs[key] = spec.replace(/^file:/, '')
  }
})

/**
 * @param {string} file
 * @returns {string}
 */
function read (file) {
  return fs.readFileSync(file, 'utf8')
}

/**
 * Git in a sandbox, with an identity and no global config.
 *
 * @param {h.Sandbox} box
 * @param {string} cwd
 * @param {string[]} args
 */
async function git (box, cwd, args) {
  const res = await h.run('git', args, {
    cwd,
    env: {
      ...box.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_NOSYSTEM: '1'
    }
  })
  assert.equal(res.code, 0, `git ${args.join(' ')}\n${h.dump(res)}`)
  return res.stdout
}

test('commit the dir, wipe the cache, a fresh run installs the same versions', {
  skip: !h.hasCommand('git') && 'git not found'
}, async () => {
  const reg = await startRegistry()
  try {
    reg.publish(LIB_1, tarballs['fx-lib@1.0.0'])
    reg.publish(APP, tarballs['fx-app@1.0.0'])

    const box = h.makeSandbox({ npm_config_registry: reg.url })
    h.writeProject(box, {})

    let res = await h.npr(box, ['install', 'fx-app'])
    assert.equal(res.code, 0, h.dump(res))
    assert.deepEqual(h.readProject(box).binDependencies, { 'fx-app': '1.0.0' })

    const dir = path.join(box.project, '.bin-deps')
    const dirPkg = h.readJSON(path.join(dir, 'package.json'))
    assert.deepEqual(dirPkg.dependencies, { 'fx-app': '1.0.0' })
    const lock = read(path.join(dir, 'package-lock.json'))
    assert.equal(JSON.parse(lock).packages['node_modules/fx-lib'].version, '1.0.0')

    res = await h.npr(box, ['fx-app'])
    assert.equal(res.code, 0, h.dump(res))
    assert.equal(h.lastJSONLine(res.stdout).lib, '1.0.0')

    await git(box, box.project, ['init', '-q'])
    await git(box, box.project, ['add', '-A'])
    await git(box, box.project, ['commit', '-q', '-m', 'bin deps'])

    // A newer fx-lib now satisfies fx-app's ^1.0.0.
    reg.publish(LIB_1_1, tarballs['fx-lib@1.1.0'])

    // Without the lockfile, a resolve would pick it up...
    const control = h.makeSandbox({ npm_config_registry: reg.url })
    h.writeProject(control, { binDependencies: { 'fx-app': '1.0.0' } })
    res = await h.npr(control, ['fx-app'])
    assert.equal(res.code, 0, h.dump(res))
    assert.equal(h.lastJSONLine(res.stdout).lib, '1.1.0', 'control run resolves fresh')

    // ...but a clone on a machine with an empty cache gets the pinned one.
    const fresh = h.makeSandbox({ npm_config_registry: reg.url })
    const clone = path.join(fresh.root, 'clone')
    await git(fresh, fresh.root, ['clone', '-q', box.project, clone])
    res = await h.npr(fresh, ['fx-app'], { cwd: clone })
    assert.equal(res.code, 0, h.dump(res))
    assert.equal(h.lastJSONLine(res.stdout).lib, '1.0.0')
    assert.equal(read(path.join(clone, '.bin-deps', 'package-lock.json')), lock, 'lockfile byte for byte')
    assert.equal(await git(fresh, clone, ['status', '--porcelain']), '', 'clone untouched')

    // Wiping the original's cache does the same.
    fs.rmSync(box.cacheHome, { recursive: true, force: true })
    res = await h.npr(box, ['install', '--frozen'])
    assert.equal(res.code, 0, h.dump(res))
    res = await h.npr(box, ['fx-app'])
    assert.equal(h.lastJSONLine(res.stdout).lib, '1.0.0')
    assert.equal(read(path.join(dir, 'package-lock.json')), lock)
    assert.equal(await git(box, box.project, ['status', '--porcelain']), '')

    // Hand-adding another bin dep re-resolves, keeping existing pins.
    const pkg = h.readProject(box)
    pkg.binDependencies['fx-echo'] = fx['fx-echo@1.0.0']
    h.writeProject(box, pkg)
    res = await h.npr(box, ['fx-app'])
    assert.equal(res.code, 0, h.dump(res))
    assert.equal(h.lastJSONLine(res.stdout).lib, '1.0.0', 'fx-lib stays pinned')
    const newLock = JSON.parse(read(path.join(dir, 'package-lock.json')))
    assert.ok(newLock.packages['node_modules/fx-echo'], 'fx-echo locked')
    assert.deepEqual(
      Object.keys(h.readJSON(path.join(dir, 'package.json')).dependencies),
      ['fx-app', 'fx-echo']
    )
  } finally {
    await reg.close()
  }
})

test('npr install --frozen: installs from the dir and never rewrites it', async () => {
  const box = h.makeSandbox()
  h.writeProject(box, { binDependencies: { 'fx-echo': fx['fx-echo@1.0.0'] } })

  // No dir yet: frozen refuses rather than resolving.
  let res = await h.npr(box, ['install', '--frozen'])
  assert.equal(res.code, 1, h.dump(res))
  assert.match(res.stderr, /out of sync/)
  assert.equal(fs.existsSync(path.join(box.project, '.bin-deps')), false)

  res = await h.npr(box, ['install'])
  assert.equal(res.code, 0, h.dump(res))
  const dir = path.join(box.project, '.bin-deps')
  const before = {
    pkg: read(path.join(dir, 'package.json')),
    lock: read(path.join(dir, 'package-lock.json'))
  }

  fs.rmSync(box.cacheHome, { recursive: true, force: true })
  res = await h.npr(box, ['install', '--frozen'])
  assert.equal(res.code, 0, h.dump(res))
  res = await h.npr(box, ['fx-echo', 'ok'])
  assert.equal(res.code, 0, h.dump(res))
  assert.deepEqual(h.lastJSONLine(res.stdout).args, ['ok'])
  assert.equal(read(path.join(dir, 'package.json')), before.pkg)
  assert.equal(read(path.join(dir, 'package-lock.json')), before.lock)

  // binDependencies edited but the dir not regenerated: frozen fails.
  h.writeProject(box, { binDependencies: { 'fx-echo': fx['fx-echo@2.0.0'] } })
  res = await h.npr(box, ['install', '--frozen'])
  assert.equal(res.code, 1, h.dump(res))
  assert.match(res.stderr, /out of sync/)
  assert.match(res.stderr, /npr install/)
  assert.equal(read(path.join(dir, 'package.json')), before.pkg)
  assert.equal(read(path.join(dir, 'package-lock.json')), before.lock)

  // A missing lockfile fails too.
  h.writeProject(box, { binDependencies: { 'fx-echo': fx['fx-echo@1.0.0'] } })
  fs.rmSync(path.join(dir, 'package-lock.json'))
  res = await h.npr(box, ['install', '--frozen'])
  assert.equal(res.code, 1, h.dump(res))
  assert.match(res.stderr, /package-lock\.json/)

  res = await h.npr(box, ['install', '--frozen', 'fx-echo'])
  assert.equal(res.code, 1, h.dump(res))
  assert.match(res.stderr, /takes no packages/)
})

test('npr install <pkg> and npr rm <pkg> rewrite the dir', async () => {
  const box = h.makeSandbox()
  h.writeProject(box, {})
  const dir = path.join(box.project, '.bin-deps')

  let res = await h.npr(box, ['install', fx['fx-echo@1.0.0'], fx['fx-tools@1.0.0']])
  assert.equal(res.code, 0, h.dump(res))
  const deps = h.readProject(box).binDependencies
  assert.deepEqual(Object.keys(deps).sort(), ['fx-echo', 'fx-tools'])
  assert.deepEqual(h.readJSON(path.join(dir, 'package.json')).dependencies, deps)
  let lock = h.readJSON(path.join(dir, 'package-lock.json'))
  assert.ok(lock.packages['node_modules/fx-echo'])
  assert.ok(lock.packages['node_modules/fx-tools'])

  res = await h.npr(box, ['rm', 'fx-echo'])
  assert.equal(res.code, 0, h.dump(res))
  assert.deepEqual(Object.keys(h.readProject(box).binDependencies), ['fx-tools'])
  assert.deepEqual(Object.keys(h.readJSON(path.join(dir, 'package.json')).dependencies), ['fx-tools'])
  lock = h.readJSON(path.join(dir, 'package-lock.json'))
  assert.equal(lock.packages['node_modules/fx-echo'], undefined)
  assert.ok(lock.packages['node_modules/fx-tools'])
})

test('a run with the dir in sync leaves it alone', async () => {
  const box = h.makeSandbox()
  h.writeProject(box, { binDependencies: { 'fx-echo': fx['fx-echo@1.0.0'] } })
  let res = await h.npr(box, ['fx-echo'])
  assert.equal(res.code, 0, h.dump(res))

  const dir = path.join(box.project, '.bin-deps')
  const files = ['package.json', 'package-lock.json'].map((f) => path.join(dir, f))
  const before = files.map((f) => [read(f), fs.statSync(f).mtimeMs])
  res = await h.npr(box, ['fx-echo'])
  assert.equal(res.code, 0, h.dump(res))
  assert.doesNotMatch(res.stderr, /resolving|installing/)
  assert.deepEqual(files.map((f) => [read(f), fs.statSync(f).mtimeMs]), before)
})

test('binDependenciesDir moves the generated files', async () => {
  const box = h.makeSandbox()
  h.writeProject(box, {
    binDependenciesDir: 'src/bin-deps',
    binDependencies: { 'fx-echo': fx['fx-echo@1.0.0'] }
  })
  const res = await h.npr(box, ['fx-echo'])
  assert.equal(res.code, 0, h.dump(res))
  const dir = path.join(box.project, 'src', 'bin-deps')
  assert.ok(fs.existsSync(path.join(dir, 'package.json')))
  assert.ok(fs.existsSync(path.join(dir, 'package-lock.json')))
  assert.equal(fs.existsSync(path.join(box.project, '.bin-deps')), false)
  assert.equal(fs.existsSync(path.join(box.project, 'node_modules')), false, 'no project node_modules')
})
