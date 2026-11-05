'use strict'

// Row: release prep. The package ships only the cli, its docs and the
// LICENSE, with no runtime dependencies.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const h = require('./helpers.js')

const REPO = path.join(__dirname, '..')

test('npm pack ships only the cli, lib, docs and LICENSE', async () => {
  const root = h.makeTmp()
  const env = h.isolatedEnv(root, path.join(root, 'home'), path.join(root, 'cache'))
  const res = await h.run(h.IS_WIN ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO, env, shell: h.IS_WIN
  })
  assert.equal(res.code, 0, h.dump(res))
  const [info] = JSON.parse(res.stdout)
  const files = info.files.map((/** @type {{ path: string }} */ f) => f.path).sort()
  assert.deepEqual(files, [
    'CHANGELOG.md',
    'LICENSE',
    'README.md',
    'index.js',
    'lib/bindeps.js',
    'lib/cache.js',
    'lib/cli.js',
    'lib/config.js',
    'lib/lock.js',
    'lib/log.js',
    'lib/manager.js',
    'lib/proc.js',
    'lib/project.js',
    'package.json'
  ])
})

test('package.json: the top CHANGELOG version, Node 20+, three bin names, no runtime deps', () => {
  const pkg = h.readJSON(path.join(REPO, 'package.json'))
  const changelog = fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8')
  assert.equal(pkg.version, (changelog.match(/^## (\S+)/m) || [])[1])
  assert.deepEqual(pkg.engines, { node: '>=20' })
  assert.deepEqual(pkg.bin, { npr: 'index.js', nbd: 'index.js', 'npm-bin-deps': 'index.js' })
  assert.equal(pkg.dependencies, undefined)
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['@types/node', 'typescript'])
})
