'use strict'

// Row: the project's .npmrc applies. Its registry and auth lines reach
// the bin-deps install (which runs in the cache, outside the project),
// and the token never shows up in npr's output or in
// binDependenciesDir.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const h = require('./helpers.js')
const { startRegistry } = require('./registry.js')
const config = require('../lib/config.js')

const HAS_PNPM = h.hasCommand('pnpm')
const needsPnpm = { skip: !HAS_PNPM && 'pnpm not found' }

const TOKEN = 'npr-fake-token-5f3c9e1a7d'

/** @type {h.FixtureSpec} */
const ECHO = { name: 'fx-echo', version: '1.0.0', bin: { 'fx-echo': h.ECHO_BIN } }

/** @type {import('./registry.js').Registry} */
let reg

test.before(async () => {
  const fx = await h.buildFixtures()
  reg = await startRegistry()
  reg.publish(ECHO, fx['fx-echo@1.0.0'].replace(/^file:/, ''))
})

test.after(async () => {
  await reg.close()
})

/**
 * Every file under `dir` whose contents include `needle`.
 *
 * @param {string} dir
 * @param {string} needle
 * @returns {string[]}
 */
function filesContaining (dir, needle) {
  if (!fs.existsSync(dir)) return []
  /** @type {string[]} */
  const hits = []
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    if (fs.readFileSync(file).includes(needle)) hits.push(file)
  }
  return hits
}

/**
 * A sandbox whose user ~/.npmrc points at a dead registry (and no
 * npm_config_registry), so only the project .npmrc can make an install
 * work.
 *
 * @param {Record<string, unknown>} pkg
 * @param {string | null} projectNpmrc
 * @returns {h.Sandbox}
 */
function setup (pkg, projectNpmrc) {
  const box = h.makeSandbox({ npm_config_registry: undefined })
  fs.writeFileSync(path.join(box.home, '.npmrc'), `registry=${h.DEAD_REGISTRY}\n`)
  h.writeProject(box, { binDependencies: { 'fx-echo': '1.0.0' }, ...pkg })
  if (projectNpmrc !== null) {
    fs.writeFileSync(path.join(box.project, '.npmrc'), projectNpmrc)
  }
  return box
}

/**
 * The project .npmrc: registry plus a token for its host, and a line
 * that is neither (which must not be carried).
 *
 * @returns {string}
 */
function projectNpmrc () {
  const host = reg.url.replace(/^http:/, '')
  return [
    '# project config',
    `registry=${reg.url}`,
    `${host}:_authToken=${TOKEN}`,
    'save-exact=true'
  ].join('\n') + '\n'
}

/**
 * Run the install twice (resolve, then frozen from a wiped cache) and
 * check the registry was used with the token, which leaks nowhere.
 *
 * @param {Record<string, unknown>} pkg
 * @param {string} lockfile
 */
async function checkInstall (pkg, lockfile) {
  // Control: without the project .npmrc, the dead user registry fails.
  const control = setup(pkg, null)
  let res = await h.npr(control, ['fx-echo'])
  assert.notEqual(res.code, 0, h.dump(res))

  const box = setup(pkg, projectNpmrc())
  const before = reg.requests.length
  res = await h.npr(box, ['fx-echo'])
  assert.equal(res.code, 0, h.dump(res))
  assert.equal(h.lastJSONLine(res.stdout).version, '1.0.0')
  assert.ok(reg.requests.length > before, 'the install used the .npmrc registry')
  assert.ok(
    reg.authorizations.slice(before).includes(`Bearer ${TOKEN}`),
    'the install sent the .npmrc token'
  )
  /** @type {string[]} */
  const outputs = [res.stdout, res.stderr]

  // A fresh frozen install from the committed dir uses it too (with
  // npm's cache and pnpm's store gone, so it has to download).
  for (const dir of [box.cacheHome, path.join(box.root, 'npm-cache'), path.join(box.root, 'pnpm-store')]) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  const frozenFrom = reg.requests.length
  res = await h.npr(box, ['install', '--frozen'])
  assert.equal(res.code, 0, h.dump(res))
  assert.ok(reg.requests.length > frozenFrom, 'the frozen install used the .npmrc registry')
  assert.ok(
    reg.authorizations.slice(frozenFrom).includes(`Bearer ${TOKEN}`),
    'the frozen install sent the .npmrc token'
  )
  outputs.push(res.stdout, res.stderr)

  const dir = path.join(box.project, '.bin-deps')
  assert.ok(fs.existsSync(path.join(dir, lockfile)))
  assert.equal(fs.existsSync(path.join(dir, '.npmrc')), false)
  for (const out of outputs) assert.ok(!out.includes(TOKEN), 'token in npr output')
  assert.deepEqual(filesContaining(dir, TOKEN), [], 'token in binDependenciesDir')
  assert.deepEqual(filesContaining(box.cacheHome, TOKEN), [], 'token left in the cache')
}

test('npm: the project .npmrc registry and token apply; the token leaks nowhere', async () => {
  await checkInstall({}, 'package-lock.json')
})

test('pnpm: the project .npmrc registry and token apply; the token leaks nowhere', needsPnpm, async () => {
  await checkInstall({ packageManager: 'pnpm@10.33.0' }, 'pnpm-lock.yaml')
})

test('config: only registry and auth lines are carried, verbatim', () => {
  const root = h.makeTmp()
  assert.deepEqual(config.readNpmrcRegistryLines(root), [])
  fs.writeFileSync(path.join(root, '.npmrc'), [
    '; comment',
    '# comment',
    'registry=https://registry.example.com/',
    '@acme:registry = https://npm.acme.dev/',
    '//npm.acme.dev/:_authToken=${ACME_TOKEN}',
    '//registry.example.com/:_auth=dXNlcjpwYXNz',
    '_authToken=abc',
    'always-auth=true',
    'save-exact=true',
    'minimum-release-age=1440',
    'strict-ssl=false'
  ].join('\r\n'))
  assert.deepEqual(config.readNpmrcRegistryLines(root), [
    'registry=https://registry.example.com/',
    '@acme:registry = https://npm.acme.dev/',
    '//npm.acme.dev/:_authToken=${ACME_TOKEN}',
    '//registry.example.com/:_auth=dXNlcjpwYXNz',
    '_authToken=abc',
    'always-auth=true'
  ])
})
