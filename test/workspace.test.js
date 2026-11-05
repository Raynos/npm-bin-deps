'use strict'

// Workspaces: npr run inside a monorepo package uses the bin deps of
// the nearest package.json above it that has binDependencies.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const h = require('./helpers.js')

/** @type {Record<string, string>} */
let fx = {}

test.before(async () => {
  fx = await h.buildFixtures()
})

test('a workspace package without binDependencies uses the root ones', async () => {
  const box = h.makeSandbox()
  h.writeProject(box, { binDependencies: { 'fx-echo': fx['fx-echo@1.0.0'] } })
  const pkgDir = path.join(box.project, 'packages', 'a')
  h.writeJSON(path.join(pkgDir, 'package.json'), { name: 'a', version: '1.0.0' })

  const res = await h.npr(box, ['fx-echo', 'hi'], { cwd: pkgDir })
  assert.equal(res.code, 0, h.dump(res))
  const out = h.lastJSONLine(res.stdout)
  assert.equal(out.version, '1.0.0')
  assert.deepEqual(out.args, ['hi'])
  assert.equal(fs.realpathSync(out.cwd), fs.realpathSync(pkgDir), 'the bin runs in the workspace')

  assert.ok(fs.existsSync(path.join(box.project, '.bin-deps', 'package.json')), 'root dir written')
  assert.equal(fs.existsSync(path.join(pkgDir, '.bin-deps')), false, 'no dir in the workspace')
})

test('a dir with no package.json uses the one above it', async () => {
  const box = h.makeSandbox()
  h.writeProject(box, { binDependencies: { 'fx-echo': fx['fx-echo@1.0.0'] } })
  const sub = path.join(box.project, 'tools', 'deep')
  fs.mkdirSync(sub, { recursive: true })

  const res = await h.npr(box, ['which', 'fx-echo'], { cwd: sub })
  assert.equal(res.code, 0, h.dump(res))
  assert.ok(fs.existsSync(res.stdout.trim()), h.dump(res))
})

test('the nearest binDependencies win over the root ones', async () => {
  const box = h.makeSandbox()
  h.writeProject(box, { binDependencies: { 'fx-echo': fx['fx-echo@1.0.0'] } })
  const pkgDir = path.join(box.project, 'packages', 'b')
  h.writeJSON(path.join(pkgDir, 'package.json'), {
    name: 'b',
    version: '1.0.0',
    binDependencies: { 'fx-echo': fx['fx-echo@2.0.0'] }
  })

  const res = await h.npr(box, ['fx-echo'], { cwd: pkgDir })
  assert.equal(res.code, 0, h.dump(res))
  assert.equal(h.lastJSONLine(res.stdout).version, '2.0.0')
  assert.ok(fs.existsSync(path.join(pkgDir, '.bin-deps', 'package.json')))
})

test('npr install <pkg> in a workspace package adds to the root', async () => {
  const box = h.makeSandbox()
  h.writeProject(box, { binDependencies: {} })
  const pkgDir = path.join(box.project, 'packages', 'c')
  h.writeJSON(path.join(pkgDir, 'package.json'), { name: 'c', version: '1.0.0' })

  const res = await h.npr(box, ['install', fx['fx-echo@1.0.0']], { cwd: pkgDir })
  assert.equal(res.code, 0, h.dump(res))
  assert.deepEqual(Object.keys(h.readProject(box).binDependencies), ['fx-echo'])
  assert.equal(h.readJSON(path.join(pkgDir, 'package.json')).binDependencies, undefined)
})

test('with no binDependencies anywhere, npr still names the missing field', async () => {
  const box = h.makeSandbox()
  h.writeProject(box, {})
  const pkgDir = path.join(box.project, 'packages', 'd')
  h.writeJSON(path.join(pkgDir, 'package.json'), { name: 'd', version: '1.0.0' })

  const res = await h.npr(box, ['fx-echo'], { cwd: pkgDir })
  assert.notEqual(res.code, 0, h.dump(res))
  assert.match(res.stderr, /"binDependencies" field is missing/)
})

test('a catalog: bin dependency takes the version from the catalog', async () => {
  const box = h.makeSandbox()
  const catalog = (/** @type {string} */ spec) => fs.writeFileSync(
    path.join(box.project, 'pnpm-workspace.yaml'),
    `packages:\n  - "packages/*"\ncatalog:\n  fx-echo: ${JSON.stringify(spec)}\n`
  )
  catalog(fx['fx-echo@1.0.0'])
  h.writeProject(box, { binDependencies: { 'fx-echo': 'catalog:' } })

  const first = await h.npr(box, ['fx-echo'])
  assert.equal(first.code, 0, h.dump(first))
  assert.equal(h.lastJSONLine(first.stdout).version, '1.0.0')
  const generated = h.readJSON(path.join(box.project, '.bin-deps', 'package.json'))
  assert.equal(generated.dependencies['fx-echo'], fx['fx-echo@1.0.0'])
  assert.equal(h.readProject(box).binDependencies['fx-echo'], 'catalog:')

  catalog(fx['fx-echo@2.0.0'])
  const bumped = await h.npr(box, ['fx-echo'])
  assert.equal(bumped.code, 0, h.dump(bumped))
  assert.equal(h.lastJSONLine(bumped.stdout).version, '2.0.0')
})
