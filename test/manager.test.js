'use strict'

// Row: manager detection and installer.
//
// Detection order: binDependenciesInstaller, packageManager, the
// lockfile beside package.json, $npm_config_user_agent, npm. With pnpm
// the project's minimumReleaseAge, strictDepBuilds,
// onlyBuiltDependencies and ignoredOptionalDependencies carry over.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const h = require('./helpers.js')
const { startRegistry } = require('./registry.js')
const config = require('../lib/config.js')

const HAS_PNPM = h.hasCommand('pnpm')
const needsPnpm = { skip: !HAS_PNPM && 'pnpm not found' }

/** @type {h.FixtureSpec} */
const BUILT = {
  name: 'fx-built',
  version: '1.0.0',
  bin: { 'fx-built': h.ECHO_BIN },
  files: { 'count.js': h.COUNT_SCRIPT },
  scripts: { postinstall: 'node count.js' }
}
/** @type {h.FixtureSpec} */
const FRESH_OLD = { name: 'fx-fresh', version: '0.9.0', bin: { 'fx-fresh': h.ECHO_BIN } }
/** @type {h.FixtureSpec} */
const FRESH_NEW = { name: 'fx-fresh', version: '1.0.0', bin: { 'fx-fresh': h.ECHO_BIN } }
/** @type {h.FixtureSpec} */
const OPTDEP = { name: 'fx-optdep', version: '1.0.0', files: { 'index.js': '' } }
/** @type {h.FixtureSpec} */
const OPT = {
  name: 'fx-opt',
  version: '1.0.0',
  bin: { 'fx-opt': h.ECHO_BIN },
  optionalDependencies: { 'fx-optdep': '1.0.0' }
}

/** @type {Record<string, string>} */
let fx = {}

test.before(async () => {
  fx = await h.buildFixtures([BUILT, FRESH_OLD, FRESH_NEW, OPTDEP, OPT])
})

/**
 * @param {string} spec  a `file:` spec from buildFixtures
 * @returns {string}
 */
function tarball (spec) {
  return spec.replace(/^file:/, '')
}

/**
 * Which lockfiles npr wrote into .bin-deps.
 *
 * @param {h.Sandbox} box
 * @returns {string[]}
 */
function dirLockfiles (box) {
  const dir = path.join(box.project, '.bin-deps')
  return ['package-lock.json', 'pnpm-lock.yaml'].filter((f) => fs.existsSync(path.join(dir, f)))
}

/**
 * Set up a project, run `npr fx-echo` and return the lockfiles written.
 *
 * @param {Record<string, unknown>} pkg
 * @param {{ env?: Record<string, string>, files?: Record<string, string> }} [opts]
 * @returns {Promise<string[]>}
 */
async function detect (pkg, opts) {
  const o = opts || {}
  const box = h.makeSandbox(o.env)
  h.writeProject(box, { binDependencies: { 'fx-echo': fx['fx-echo@1.0.0'] }, ...pkg })
  for (const [name, text] of Object.entries(o.files || {})) {
    fs.writeFileSync(path.join(box.project, name), text)
  }
  const res = await h.npr(box, ['fx-echo'])
  assert.equal(res.code, 0, h.dump(res))
  assert.equal(h.lastJSONLine(res.stdout).name, 'fx-echo')
  return dirLockfiles(box)
}

const PNPM_UA = 'pnpm/10.33.0 npm/? node/v24.0.0 darwin arm64'
const NPM_UA = 'npm/11.0.0 node/v24.0.0 darwin arm64 workspaces/false'

test('detect: npm when nothing says otherwise', async () => {
  assert.deepEqual(await detect({}), ['package-lock.json'])
})

test('detect: packageManager', needsPnpm, async () => {
  assert.deepEqual(await detect({ packageManager: 'pnpm@10.33.0' }), ['pnpm-lock.yaml'])
  // packageManager beats a lockfile and the user agent
  assert.deepEqual(await detect({ packageManager: 'npm@11.0.0' }, {
    files: { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" },
    env: { npm_config_user_agent: PNPM_UA }
  }), ['package-lock.json'])
  // an unsupported manager falls through to the next source
  assert.deepEqual(await detect({ packageManager: 'yarn@4.0.0' }, {
    env: { npm_config_user_agent: PNPM_UA }
  }), ['pnpm-lock.yaml'])
})

test('detect: the lockfile beside package.json', needsPnpm, async () => {
  assert.deepEqual(await detect({}, {
    files: { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" },
    env: { npm_config_user_agent: NPM_UA }
  }), ['pnpm-lock.yaml'])
  assert.deepEqual(await detect({}, {
    files: { 'package-lock.json': '{}\n' },
    env: { npm_config_user_agent: PNPM_UA }
  }), ['package-lock.json'])
})

test('detect: npm_config_user_agent', needsPnpm, async () => {
  assert.deepEqual(await detect({}, { env: { npm_config_user_agent: PNPM_UA } }), ['pnpm-lock.yaml'])
  assert.deepEqual(await detect({}, { env: { npm_config_user_agent: NPM_UA } }), ['package-lock.json'])
})

test('binDependenciesInstaller overrides detection', needsPnpm, async () => {
  assert.deepEqual(await detect({
    packageManager: 'npm@11.0.0',
    binDependenciesInstaller: 'pnpm'
  }), ['pnpm-lock.yaml'])
  assert.deepEqual(await detect({ binDependenciesInstaller: 'npm' }, {
    files: { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" }
  }), ['package-lock.json'])
})

test('binDependenciesInstaller runs through a wrapper like `socket pnpm`', needsPnpm, async () => {
  const box = h.makeSandbox()
  const wrapLog = path.join(box.root, 'wrap.log')
  const wrap = path.join(box.root, 'wrap.js')
  fs.writeFileSync(wrap, `'use strict'
const fs = require('fs')
const cp = require('child_process')
fs.appendFileSync(${JSON.stringify(wrapLog)}, JSON.stringify(process.argv.slice(2)) + '\\n')
const [cmd, ...args] = process.argv.slice(2)
const r = cp.spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(r.status === null ? 1 : r.status)
`)
  h.writeProject(box, {
    binDependenciesInstaller: `node ${wrap} pnpm`,
    binDependencies: { 'fx-echo': fx['fx-echo@1.0.0'] }
  })
  const res = await h.npr(box, ['fx-echo', 'wrapped'])
  assert.equal(res.code, 0, h.dump(res))
  assert.deepEqual(h.lastJSONLine(res.stdout).args, ['wrapped'])
  assert.deepEqual(dirLockfiles(box), ['pnpm-lock.yaml'])

  const calls = fs.readFileSync(wrapLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [
    ['pnpm', 'install'], // --lockfile-only
    ['pnpm', 'install'] // --frozen-lockfile
  ])
  assert.ok(calls[0].includes('--lockfile-only'))
  assert.ok(calls[1].includes('--frozen-lockfile'))
})

test('binDependenciesInstaller must name npm or pnpm', async () => {
  const box = h.makeSandbox()
  h.writeProject(box, {
    binDependenciesInstaller: 'yarn',
    binDependencies: { 'fx-echo': fx['fx-echo@1.0.0'] }
  })
  const res = await h.npr(box, ['fx-echo'])
  assert.equal(res.code, 1, h.dump(res))
  assert.match(res.stderr, /binDependenciesInstaller" must run npm or pnpm/)
})

test('switching manager replaces the other lockfile', needsPnpm, async () => {
  const box = h.makeSandbox()
  h.writeProject(box, { binDependencies: { 'fx-echo': fx['fx-echo@1.0.0'] } })
  let res = await h.npr(box, ['fx-echo'])
  assert.equal(res.code, 0, h.dump(res))
  assert.deepEqual(dirLockfiles(box), ['package-lock.json'])

  h.writeProject(box, {
    packageManager: 'pnpm@10.33.0',
    binDependencies: { 'fx-echo': fx['fx-echo@1.0.0'] }
  })
  res = await h.npr(box, ['fx-echo'])
  assert.equal(res.code, 0, h.dump(res))
  assert.deepEqual(dirLockfiles(box), ['pnpm-lock.yaml'])
})

// --- pnpm rules -----------------------------------------------------

test('pnpm: an install script runs only when onlyBuiltDependencies lists it', needsPnpm, async () => {
  const log = path.join(h.makeTmp(), 'installs.log')
  const box = h.makeSandbox({ FX_INSTALL_LOG: log })
  h.writeProject(box, {
    packageManager: 'pnpm@10.33.0',
    pnpm: { onlyBuiltDependencies: ['fx-built'] },
    binDependencies: {
      'fx-built': fx['fx-built@1.0.0'],
      'fx-tools': fx['fx-tools@1.0.0']
    }
  })
  let res = await h.npr(box, ['fx-exit', '0'])
  assert.equal(res.code, 0, h.dump(res))
  assert.equal(fs.readFileSync(log, 'utf8'), 'fx-built@1.0.0\n', 'only the listed script ran')
  const yaml = fs.readFileSync(path.join(box.project, '.bin-deps', 'pnpm-workspace.yaml'), 'utf8')
  assert.deepEqual(config.parseTopLevelYAML(yaml), { onlyBuiltDependencies: ['fx-built'] })

  // Allowing fx-tools later re-resolves and installs again, running it.
  fs.writeFileSync(path.join(box.project, 'pnpm-workspace.yaml'),
    'onlyBuiltDependencies:\n  - fx-built\n  - fx-tools\n')
  res = await h.npr(box, ['fx-exit', '0'])
  assert.equal(res.code, 0, h.dump(res))
  // (pnpm may replay fx-built's build from its side-effects cache.)
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n')
  assert.equal(lines[0], 'fx-built@1.0.0')
  assert.ok(lines.slice(1).includes('fx-tools@1.0.0'), lines.join(', '))
})

test('pnpm: strictDepBuilds fails on an unlisted install script', needsPnpm, async () => {
  const box = h.makeSandbox()
  h.writeProject(box, {
    packageManager: 'pnpm@10.33.0',
    binDependencies: { 'fx-tools': fx['fx-tools@1.0.0'] }
  })
  fs.writeFileSync(path.join(box.project, 'pnpm-workspace.yaml'), 'strictDepBuilds: true\n')
  const res = await h.npr(box, ['fx-exit', '0'])
  assert.notEqual(res.code, 0, h.dump(res))
  assert.match(res.stderr, /fx-tools/)
})

test('npm: no extra guard; install scripts run', async () => {
  const log = path.join(h.makeTmp(), 'installs.log')
  const box = h.makeSandbox({ FX_INSTALL_LOG: log })
  h.writeProject(box, {
    pnpm: { onlyBuiltDependencies: [], strictDepBuilds: true },
    binDependencies: { 'fx-tools': fx['fx-tools@1.0.0'] }
  })
  const res = await h.npr(box, ['fx-exit', '0'])
  assert.equal(res.code, 0, h.dump(res))
  assert.equal(fs.readFileSync(log, 'utf8'), 'fx-tools@1.0.0\n')
  assert.equal(fs.existsSync(path.join(box.project, '.bin-deps', 'pnpm-workspace.yaml')), false)
})

test('pnpm: minimumReleaseAge refuses a too-new package', needsPnpm, async () => {
  const reg = await startRegistry()
  try {
    const yearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000)
    reg.publish(FRESH_OLD, tarball(fx['fx-fresh@0.9.0']), yearAgo)
    reg.publish(FRESH_NEW, tarball(fx['fx-fresh@1.0.0']), new Date())

    /**
     * @param {string} spec
     * @param {string | null} yaml
     */
    const setup = (spec, yaml) => {
      const box = h.makeSandbox({ npm_config_registry: reg.url })
      h.writeProject(box, {
        packageManager: 'pnpm@10.33.0',
        binDependencies: { 'fx-fresh': spec }
      })
      if (yaml) fs.writeFileSync(path.join(box.project, 'pnpm-workspace.yaml'), yaml)
      return box
    }

    // Control: without the rule, the newest version wins.
    let box = setup('*', null)
    let res = await h.npr(box, ['fx-fresh'])
    assert.equal(res.code, 0, h.dump(res))
    assert.equal(h.lastJSONLine(res.stdout).version, '1.0.0')

    // A week's minimum age: a range settles on the mature version...
    box = setup('*', 'minimumReleaseAge: 10080\n')
    res = await h.npr(box, ['fx-fresh'])
    assert.equal(res.code, 0, h.dump(res))
    assert.equal(h.lastJSONLine(res.stdout).version, '0.9.0')

    // ...and pinning the new one is refused.
    box = setup('1.0.0', 'minimumReleaseAge: 10080\n')
    res = await h.npr(box, ['fx-fresh'])
    assert.notEqual(res.code, 0, h.dump(res))
    assert.match(res.stderr, /fx-fresh/)
    assert.deepEqual(dirLockfiles(box), [], 'no lockfile written')
  } finally {
    await reg.close()
  }
})

test('pnpm: ignoredOptionalDependencies carries over', needsPnpm, async () => {
  const reg = await startRegistry()
  try {
    reg.publish(OPTDEP, tarball(fx['fx-optdep@1.0.0']))
    reg.publish(OPT, tarball(fx['fx-opt@1.0.0']))

    /**
     * @param {Record<string, unknown>} extra
     * @returns {Promise<string>}
     */
    const lockFor = async (extra) => {
      const box = h.makeSandbox({ npm_config_registry: reg.url })
      h.writeProject(box, {
        packageManager: 'pnpm@10.33.0',
        binDependencies: { 'fx-opt': '1.0.0' },
        ...extra
      })
      const res = await h.npr(box, ['fx-opt'])
      assert.equal(res.code, 0, h.dump(res))
      return fs.readFileSync(path.join(box.project, '.bin-deps', 'pnpm-lock.yaml'), 'utf8')
    }

    assert.match(await lockFor({}), /fx-optdep@1\.0\.0/)
    assert.doesNotMatch(
      await lockFor({ pnpm: { ignoredOptionalDependencies: ['fx-optdep'] } }),
      /fx-optdep@1\.0\.0/
    )
  } finally {
    await reg.close()
  }
})

// --- reading the settings --------------------------------------------

test('config: reads pnpm settings from yaml, package.json and .npmrc', () => {
  const root = h.makeTmp()

  assert.deepEqual(config.readPnpmSettings(root, {}), {})

  fs.writeFileSync(path.join(root, '.npmrc'), [
    'save-exact=true',
    'minimum-release-age=60',
    'strict-dep-builds=true'
  ].join('\n'))
  assert.deepEqual(config.readPnpmSettings(root, {}), {
    minimumReleaseAge: 60,
    strictDepBuilds: true
  })

  const pkg = {
    pnpm: {
      onlyBuiltDependencies: ['esbuild'],
      ignoredOptionalDependencies: ['@esbuild/aix-ppc64'],
      minimumReleaseAge: 120,
      overrides: { not: 'carried' }
    }
  }
  assert.deepEqual(config.readPnpmSettings(root, pkg), {
    minimumReleaseAge: 120,
    strictDepBuilds: true,
    onlyBuiltDependencies: ['esbuild'],
    ignoredOptionalDependencies: ['@esbuild/aix-ppc64']
  })

  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), [
    '# comment',
    'packages:',
    '  - "packages/*"',
    'catalog:',
    '  react: ^18',
    'minimumReleaseAge: 1440 # one day',
    'minimumReleaseAgeExclude: [ "@types/node", typescript ]',
    'strictDepBuilds: false',
    'onlyBuiltDependencies:',
    "  - 'esbuild'",
    '  - "@swc/core"',
    'ignoredOptionalDependencies: []'
  ].join('\n'))
  assert.deepEqual(config.readPnpmSettings(root, pkg), {
    minimumReleaseAge: 1440,
    minimumReleaseAgeExclude: ['@types/node', 'typescript'],
    strictDepBuilds: false,
    onlyBuiltDependencies: ['esbuild', '@swc/core'],
    ignoredOptionalDependencies: []
  })
})

test('config: the written pnpm-workspace.yaml reads back the same', () => {
  /** @type {config.PnpmSettings} */
  const settings = {
    minimumReleaseAge: 1440,
    minimumReleaseAgeExclude: ['@types/node'],
    strictDepBuilds: true,
    onlyBuiltDependencies: ['esbuild', "it's"],
    ignoredOptionalDependencies: []
  }
  const yaml = config.pnpmWorkspaceYAML(settings)
  assert.deepEqual(config.parseTopLevelYAML(yaml), settings)
})
