'use strict'

// Row: content-addressed cache.
//
// Install dirs live under $XDG_CACHE_HOME/npm-bin-deps (or
// ~/.cache/npm-bin-deps, or %LOCALAPPDATA%\npm-bin-deps) keyed by a
// hash of the bin-deps files, so two projects with the same name but
// different deps never share or thrash one dir.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const h = require('./helpers.js')

const MARKER = '.npr-installed'
const DAY = 24 * 60 * 60 * 1000

/** @type {Record<string, string>} */
let fx = {}

test.before(async () => {
  fx = await h.buildFixtures()
})

/**
 * A second project dir inside the same sandbox (same home and cache).
 *
 * @param {h.Sandbox} box
 * @param {string} name  dir name
 * @param {Record<string, unknown>} pkg
 * @returns {string}
 */
function addProject (box, name, pkg) {
  const dir = path.join(box.root, name)
  h.writeJSON(path.join(dir, 'package.json'), pkg)
  return dir
}

/**
 * @param {h.Sandbox} box
 * @param {string} cwd
 * @returns {Promise<string>} the install dir behind `npr which fx-echo`
 */
async function installDirOf (box, cwd) {
  const res = await h.npr(box, ['which', 'fx-echo'], { cwd })
  assert.equal(res.code, 0, h.dump(res))
  const bin = res.stdout.trim()
  return path.dirname(path.dirname(path.dirname(bin)))
}

/**
 * @param {string} dir
 * @param {number} ageMs
 */
function age (dir, ageMs) {
  const then = new Date(Date.now() - ageMs)
  fs.utimesSync(dir, then, then)
}

test('two projects with the same name and different versions run side by side', async () => {
  const box = h.makeSandbox()
  const a = addProject(box, 'a', {
    name: 'same-name',
    binDependencies: { 'fx-echo': fx['fx-echo@1.0.0'] }
  })
  const b = addProject(box, 'b', {
    name: 'same-name',
    binDependencies: { 'fx-echo': fx['fx-echo@2.0.0'] }
  })

  for (let round = 0; round < 2; round++) {
    const [ra, rb] = await Promise.all([
      h.npr(box, ['fx-echo'], { cwd: a }),
      h.npr(box, ['fx-echo'], { cwd: b })
    ])
    assert.equal(ra.code, 0, h.dump(ra))
    assert.equal(rb.code, 0, h.dump(rb))
    assert.equal(h.lastJSONLine(ra.stdout).version, '1.0.0')
    assert.equal(h.lastJSONLine(rb.stdout).version, '2.0.0')
    if (round > 0) {
      assert.doesNotMatch(ra.stderr + rb.stderr, /installing|resolving/, 'no reinstall')
    }
  }

  const dirA = await installDirOf(box, a)
  const dirB = await installDirOf(box, b)
  assert.notEqual(dirA, dirB)
  const root = path.join(box.cacheHome, 'npm-bin-deps')
  assert.equal(path.dirname(dirA), root)
  assert.equal(path.dirname(dirB), root)
  assert.match(path.basename(dirA), /^[0-9a-f]{32}$/)
})

test('projects with the same bin deps share one install', async () => {
  const box = h.makeSandbox()
  const deps = { binDependencies: { 'fx-echo': fx['fx-echo@1.0.0'] } }
  const c = addProject(box, 'c', { name: 'c', ...deps })
  const d = addProject(box, 'd', { name: 'd', ...deps })
  const dirC = await installDirOf(box, c)
  const res = await h.npr(box, ['which', 'fx-echo'], { cwd: d })
  assert.doesNotMatch(res.stderr, /installing/)
  assert.equal(await installDirOf(box, d), dirC)
})

test('cache root: XDG_CACHE_HOME, else ~/.cache (or %LOCALAPPDATA%)', async () => {
  const box = h.makeSandbox()
  h.writeProject(box, { binDependencies: { 'fx-echo': fx['fx-echo@1.0.0'] } })
  let dir = await installDirOf(box, box.project)
  assert.equal(path.dirname(dir), path.join(box.cacheHome, 'npm-bin-deps'))

  const noXdg = { ...box.env }
  delete noXdg.XDG_CACHE_HOME
  const res = await h.run(process.execPath, [h.INDEX, 'which', 'fx-echo'], {
    cwd: box.project, env: noXdg
  })
  assert.equal(res.code, 0, h.dump(res))
  dir = path.dirname(path.dirname(path.dirname(res.stdout.trim())))
  const expected = h.IS_WIN
    ? path.join(String(box.env.LOCALAPPDATA), 'npm-bin-deps')
    : path.join(box.home, '.cache', 'npm-bin-deps')
  assert.equal(path.dirname(dir), expected)
})

test('each run stamps the install dir it used', async () => {
  const box = h.makeSandbox()
  h.writeProject(box, { binDependencies: { 'fx-echo': fx['fx-echo@1.0.0'] } })
  const dir = await installDirOf(box, box.project)
  const marker = path.join(dir, MARKER)
  age(marker, 40 * DAY)
  const res = await h.npr(box, ['fx-echo'])
  assert.equal(res.code, 0, h.dump(res))
  assert.ok(Date.now() - fs.statSync(marker).mtimeMs < DAY, 'stamp refreshed')
})

test('npr cache prune removes installs unused for 30 days and crash leftovers', async () => {
  const box = h.makeSandbox()
  const oldProject = addProject(box, 'old', {
    name: 'old', binDependencies: { 'fx-echo': fx['fx-echo@1.0.0'] }
  })
  const newProject = addProject(box, 'new', {
    name: 'new', binDependencies: { 'fx-echo': fx['fx-echo@2.0.0'] }
  })
  const oldDir = await installDirOf(box, oldProject)
  const newDir = await installDirOf(box, newProject)
  age(path.join(oldDir, MARKER), 31 * DAY)
  age(path.join(newDir, MARKER), 29 * DAY)

  const root = path.dirname(oldDir)
  const work = path.join(root, '.work-crashed')
  const unfinished = path.join(root, '0123456789abcdef0123456789abcdef')
  const fresh = path.join(root, '.work-in-progress')
  for (const dir of [work, unfinished, fresh]) fs.mkdirSync(dir)
  age(work, 2 * DAY)
  age(unfinished, 2 * DAY)

  // prune needs no project: run it from a dir without package.json
  const res = await h.npr(box, ['cache', 'prune'], { cwd: box.root })
  assert.equal(res.code, 0, h.dump(res))
  assert.match(res.stderr, /removed 3, kept 2/)
  assert.equal(fs.existsSync(oldDir), false)
  assert.equal(fs.existsSync(work), false)
  assert.equal(fs.existsSync(unfinished), false)
  assert.ok(fs.existsSync(newDir))
  assert.ok(fs.existsSync(fresh))

  // the pruned project just installs again
  const again = await h.npr(box, ['fx-echo'], { cwd: oldProject })
  assert.equal(again.code, 0, h.dump(again))
  assert.equal(h.lastJSONLine(again.stdout).version, '1.0.0')
})

test('npr cache prune with no cache yet', async () => {
  const box = h.makeSandbox()
  const res = await h.npr(box, ['cache', 'prune'], { cwd: box.root })
  assert.equal(res.code, 0, h.dump(res))
  assert.match(res.stderr, /removed 0, kept 0/)
})

test('npr cache clean removes only this project\'s current install', async () => {
  const box = h.makeSandbox()
  const a = addProject(box, 'a', { name: 'a', binDependencies: { 'fx-echo': fx['fx-echo@1.0.0'] } })
  const b = addProject(box, 'b', { name: 'b', binDependencies: { 'fx-echo': fx['fx-echo@2.0.0'] } })
  const dirA = await installDirOf(box, a)
  const dirB = await installDirOf(box, b)

  const res = await h.npr(box, ['cache', 'clean'], { cwd: a })
  assert.equal(res.code, 0, h.dump(res))
  assert.equal(fs.existsSync(dirA), false)
  assert.ok(fs.existsSync(path.join(dirB, MARKER)))

  const bad = await h.npr(box, ['cache', 'nope'], { cwd: a })
  assert.equal(bad.code, 1, h.dump(bad))
  assert.match(bad.stderr, /unknown cache command/)
})
