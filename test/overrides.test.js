'use strict'

// Row: overrides carry over. The project's `overrides` (npm) and
// `pnpm.overrides` / pnpm-workspace.yaml `overrides` (pnpm) reach the
// generated package.json, so the bin-deps install resolves the
// overridden version.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const h = require('./helpers.js')
const { startRegistry } = require('./registry.js')
const config = require('../lib/config.js')

const HAS_PNPM = h.hasCommand('pnpm')
const needsPnpm = { skip: !HAS_PNPM && 'pnpm not found' }

/** Print the version of fx-child that fx-parent got. */
const CHILD_BIN = `#!/usr/bin/env node
'use strict'
console.log(JSON.stringify({ child: require('fx-child/package.json').version }))
`

/** @type {h.FixtureSpec} */
const CHILD_1 = { name: 'fx-child', version: '1.0.0', files: { 'index.js': '' } }
/** @type {h.FixtureSpec} */
const CHILD_2 = { name: 'fx-child', version: '2.0.0', files: { 'index.js': '' } }
/** @type {h.FixtureSpec} */
const PARENT = {
  name: 'fx-parent',
  version: '1.0.0',
  bin: { 'fx-parent': CHILD_BIN },
  dependencies: { 'fx-child': '1.0.0' }
}

/** @type {import('./registry.js').Registry} */
let reg

test.before(async () => {
  const fx = await h.buildFixtures([CHILD_1, CHILD_2, PARENT])
  reg = await startRegistry()
  for (const spec of [CHILD_1, CHILD_2, PARENT]) {
    reg.publish(spec, fx[`${spec.name}@${spec.version}`].replace(/^file:/, ''))
  }
})

test.after(async () => {
  await reg.close()
})

/**
 * Run `npr fx-parent` in a fresh project and return the child version
 * it saw, plus the generated package.json.
 *
 * @param {Record<string, unknown>} pkg
 * @param {Record<string, string>} [files]
 * @returns {Promise<{ child: string, generated: any }>}
 */
async function childVersion (pkg, files) {
  const box = h.makeSandbox({ npm_config_registry: reg.url })
  h.writeProject(box, { binDependencies: { 'fx-parent': '1.0.0' }, ...pkg })
  for (const [name, text] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(box.project, name), text)
  }
  const res = await h.npr(box, ['fx-parent'])
  assert.equal(res.code, 0, h.dump(res))
  return {
    child: h.lastJSONLine(res.stdout).child,
    generated: h.readJSON(path.join(box.project, '.bin-deps', 'package.json'))
  }
}

test('npm: the project\'s overrides reach the bin-deps install', async () => {
  const plain = await childVersion({})
  assert.equal(plain.child, '1.0.0')
  assert.equal(plain.generated.overrides, undefined)

  const over = await childVersion({ overrides: { 'fx-child': '2.0.0' } })
  assert.equal(over.child, '2.0.0')
  assert.deepEqual(over.generated.overrides, { 'fx-child': '2.0.0' })

  // A `$name` reference resolves against the project's own deps.
  const ref = await childVersion({
    devDependencies: { 'fx-child': '2.0.0' },
    overrides: { 'fx-child': '$fx-child' }
  })
  assert.equal(ref.child, '2.0.0')
  assert.deepEqual(ref.generated.overrides, { 'fx-child': '2.0.0' })

  // pnpm's overrides are not npm's.
  const pnpmOnly = await childVersion({ pnpm: { overrides: { 'fx-child': '2.0.0' } } })
  assert.equal(pnpmOnly.child, '1.0.0')
})

test('pnpm: pnpm.overrides and pnpm-workspace.yaml overrides reach the install', needsPnpm, async () => {
  const base = { packageManager: 'pnpm@10.33.0' }

  const plain = await childVersion(base)
  assert.equal(plain.child, '1.0.0')

  const field = await childVersion({ ...base, pnpm: { overrides: { 'fx-child': '2.0.0' } } })
  assert.equal(field.child, '2.0.0')
  assert.deepEqual(field.generated.pnpm, { overrides: { 'fx-child': '2.0.0' } })
  assert.equal(field.generated.overrides, undefined)

  const yaml = await childVersion(base, {
    'pnpm-workspace.yaml': 'overrides:\n  "fx-child": 2.0.0\nminimumReleaseAge: 0\n'
  })
  assert.equal(yaml.child, '2.0.0')

  // npm's overrides are not pnpm's.
  const npmOnly = await childVersion({ ...base, overrides: { 'fx-child': '2.0.0' } })
  assert.equal(npmOnly.child, '1.0.0')
})

test('config: readOverrides per manager, yaml over the pnpm field', () => {
  const root = h.makeTmp()
  const pkg = {
    dependencies: { react: '^18.3.0' },
    overrides: { foo: '1.0.0', bar: { baz: '$react' }, bad: 3 },
    pnpm: { overrides: { foo: '2.0.0', qux: '1.0.0' } }
  }
  assert.deepEqual(config.readOverrides(root, {}, 'npm'), null)
  assert.deepEqual(config.readOverrides(root, pkg, 'npm'), {
    foo: '1.0.0',
    bar: { baz: '^18.3.0' }
  })
  assert.deepEqual(config.readOverrides(root, pkg, 'pnpm'), { foo: '2.0.0', qux: '1.0.0' })

  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), [
    'packages:',
    '  - "packages/*"',
    'overrides:',
    '  foo: 3.0.0 # pinned',
    '  "@scope/x@<2": ^2',
    "  'react': $react",
    'minimumReleaseAge: 1440'
  ].join('\n'))
  assert.deepEqual(config.readOverrides(root, pkg, 'pnpm'), {
    foo: '3.0.0',
    qux: '1.0.0',
    '@scope/x@<2': '^2',
    react: '^18.3.0'
  })
  // The flat map does not leak into the other pnpm settings.
  assert.deepEqual(config.readPnpmSettings(root, {}), { minimumReleaseAge: 1440 })
})

test('config: catalog: overrides take the catalog version; workspace: ones are dropped', () => {
  const root = h.makeTmp()
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), [
    'packages:',
    '  - "packages/*"',
    'catalog:',
    '  react: ^18.3.0',
    'catalogs:',
    '  default:',
    '    typescript: =7.0.2 # pinned',
    '  legacy:',
    "    '@scope/x': ^1",
    'overrides:',
    '  typescript: catalog:default',
    '  react: "catalog:"',
    '  "a>@scope/x@<2": catalog:legacy',
    '  missing: catalog:nope',
    '  "@my/pkg": workspace:*',
    'minimumReleaseAge: 1440'
  ].join('\n'))
  assert.deepEqual(config.readCatalogs(root), {
    default: { typescript: '=7.0.2', react: '^18.3.0' },
    legacy: { '@scope/x': '^1' }
  })
  assert.deepEqual(config.readOverrides(root, {}, 'pnpm'), {
    typescript: '=7.0.2',
    react: '^18.3.0',
    'a>@scope/x@<2': '^1',
    missing: 'catalog:nope'
  })
  assert.deepEqual(config.readPnpmSettings(root, {}), { minimumReleaseAge: 1440 })
})
