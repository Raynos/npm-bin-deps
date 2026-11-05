'use strict'

// Row: sibling binaries.
//
// A bin runs with its install's node_modules/.bin first on PATH, and
// with OXLINT_TSGOLINT_PATH pointing at tsgolint when oxlint-tsgolint
// is a bin dependency, so `npr oxlint --type-aware` works with no
// oxlint in the project's node_modules.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const h = require('./helpers.js')

const HAS_PNPM = h.hasCommand('pnpm')

/** Stands in for oxlint: calls tsgolint via the env var, and a sibling via PATH. */
const FAKE_OXLINT = `#!/usr/bin/env node
'use strict'
const cp = require('child_process')
const shell = process.platform === 'win32'
const tsgolintPath = process.env.OXLINT_TSGOLINT_PATH || null
const ts = tsgolintPath
  ? cp.spawnSync(tsgolintPath, process.argv.slice(2), { encoding: 'utf8', shell })
  : null
const sib = cp.spawnSync('fx-echo', ['from-sibling'], { encoding: 'utf8', shell })
console.log(JSON.stringify({
  tsgolintPath,
  tsgolint: ts ? ts.stdout.trim() : null,
  sibling: sib.status === 0 ? JSON.parse(sib.stdout.trim()).args : null
}))
`

/** Stands in for tsgolint. */
const FAKE_TSGOLINT = `#!/usr/bin/env node
'use strict'
console.log('tsgolint-fixture ' + process.argv.slice(2).join(' '))
`

/** @type {h.FixtureSpec} */
const OXLINT = { name: 'fx-oxlint', version: '1.0.0', bin: { 'fx-oxlint': FAKE_OXLINT } }
/** @type {h.FixtureSpec} */
const TSGOLINT = { name: 'oxlint-tsgolint', version: '1.0.0', bin: { tsgolint: FAKE_TSGOLINT } }

/** @type {Record<string, string>} */
let fx = {}

test.before(async () => {
  fx = await h.buildFixtures([OXLINT, TSGOLINT])
})

for (const manager of ['npm', 'pnpm']) {
  test(`${manager}: the fake oxlint finds tsgolint and its siblings`, {
    skip: manager === 'pnpm' && !HAS_PNPM && 'pnpm not found'
  }, async () => {
    const box = h.makeSandbox()
    h.writeProject(box, {
      packageManager: `${manager}@1.0.0`,
      binDependencies: {
        'fx-oxlint': fx['fx-oxlint@1.0.0'],
        'oxlint-tsgolint': fx['oxlint-tsgolint@1.0.0'],
        'fx-echo': fx['fx-echo@1.0.0']
      }
    })
    const res = await h.npr(box, ['fx-oxlint', '--type-aware'])
    assert.equal(res.code, 0, h.dump(res))
    const out = h.lastJSONLine(res.stdout)
    assert.equal(out.tsgolint, 'tsgolint-fixture --type-aware')
    const suffix = path.join('node_modules', '.bin', 'tsgolint') + (h.IS_WIN ? '.cmd' : '')
    assert.ok(out.tsgolintPath.endsWith(suffix), out.tsgolintPath)
    assert.ok(out.tsgolintPath.startsWith(box.cacheHome), out.tsgolintPath)
    assert.deepEqual(out.sibling, ['from-sibling'])
    assert.equal(fs.existsSync(path.join(box.project, 'node_modules')), false)
  })
}

test('PATH puts the install\'s .bin first', async () => {
  const box = h.makeSandbox()
  h.writeProject(box, { binDependencies: { 'fx-tools': fx['fx-tools@1.0.0'] } })
  const res = await h.npr(box, ['fx-env'])
  assert.equal(res.code, 0, h.dump(res))
  const out = h.lastJSONLine(res.stdout)
  const first = out.PATH.split(path.delimiter)[0]
  assert.ok(first.startsWith(box.cacheHome), first)
  assert.equal(path.basename(first), '.bin')
  assert.ok(out.PATH.endsWith(String(box.env.PATH || box.env.Path)), 'the rest of PATH is kept')
  assert.equal(out.OXLINT_TSGOLINT_PATH, null, 'not set without oxlint-tsgolint')
})

test('a user-set OXLINT_TSGOLINT_PATH is kept', async () => {
  const box = h.makeSandbox()
  h.writeProject(box, {
    binDependencies: {
      'fx-tools': fx['fx-tools@1.0.0'],
      'oxlint-tsgolint': fx['oxlint-tsgolint@1.0.0']
    }
  })
  let res = await h.npr(box, ['fx-env'])
  assert.equal(res.code, 0, h.dump(res))
  assert.match(h.lastJSONLine(res.stdout).OXLINT_TSGOLINT_PATH, /tsgolint/)

  res = await h.npr(box, ['fx-env'], { env: { OXLINT_TSGOLINT_PATH: '/my/tsgolint' } })
  assert.equal(res.code, 0, h.dump(res))
  assert.equal(h.lastJSONLine(res.stdout).OXLINT_TSGOLINT_PATH, '/my/tsgolint')
})

// The real thing, against the npm registry. Off by default (tests stay
// offline); run with NPR_TEST_NETWORK=1.
test('network: npr oxlint --type-aware with real oxlint and tsgolint', {
  skip: !process.env.NPR_TEST_NETWORK && 'set NPR_TEST_NETWORK=1 to run'
}, async () => {
  const box = h.makeSandbox({ npm_config_registry: 'https://registry.npmjs.org/' })
  h.writeProject(box, {
    binDependencies: {
      oxlint: '1.89.0',
      'oxlint-tsgolint': '7.0.2004'
    }
  })
  h.writeJSON(path.join(box.project, 'tsconfig.json'), {
    compilerOptions: { strict: true, noEmit: true, module: 'nodenext' },
    include: ['src']
  })
  fs.mkdirSync(path.join(box.project, 'src'))
  fs.writeFileSync(path.join(box.project, 'src', 'a.ts'),
    'export async function f (): Promise<number> { return 1 }\n' +
    'export function g (): void { f() }\n')
  const res = await h.npr(box, [
    'oxlint', '--type-aware', '-D', 'typescript/no-floating-promises', 'src'
  ])
  assert.equal(fs.existsSync(path.join(box.project, 'node_modules')), false)
  // The floating promise is reported, which only tsgolint can do.
  assert.match(res.stdout + res.stderr, /no-floating-promises/, h.dump(res))
  assert.equal(res.code, 1, h.dump(res))
})
