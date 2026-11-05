'use strict'

// v1 parity: every 1.x behaviour of `npr`, run as a child process
// against fixture packages installed from local tarballs.
//
// These were written against 1.10.2 before any refactor, and assert on
// what a user sees (exit codes, the tool's output, package.json), not
// on where 1.x kept its cache, so they keep passing on 2.x.

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

/**
 * @param {h.RunResult} res
 * @returns {string}
 */
function both (res) {
  return h.plain(res.stdout + '\n' + res.stderr)
}

/**
 * A sandbox whose project lists fx-echo@1 and fx-tools as bin deps.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {h.Sandbox}
 */
function standardBox (env) {
  const box = h.makeSandbox(env)
  h.writeProject(box, {
    binDependencies: {
      'fx-echo': fx['fx-echo@1.0.0'],
      'fx-tools': fx['fx-tools@1.0.0']
    }
  })
  return box
}

// The commands 1.x's help listed. 2.x must still list every one.
const V1_HELP_COMMANDS = [
  'npr [bindep]',
  'npr exec [bindep]',
  'npr install [bindep]',
  'npr rm [bindep]',
  'npr cache clean',
  'npr which [bindep]',
  'npr ls'
]

test('help: --help, help and no args print the full help', async () => {
  const box = h.makeSandbox()
  for (const args of [['--help'], ['help'], []]) {
    const res = await h.npr(box, args)
    assert.equal(res.code, 0, h.dump(res))
    const out = h.plain(res.stdout)
    assert.match(out, /^usage: npr \[bindep\] \[\.\.\.args\]/m)
    const lines = out.split(/\r?\n/).map((l) => l.trim())
    for (const cmd of V1_HELP_COMMANDS) {
      assert.ok(
        lines.some((l) => l.startsWith(cmd + ' ')),
        `help for ${JSON.stringify(args)} lists "${cmd}"\n${out}`
      )
    }
  }
})

test('help: -h prints the short help', async () => {
  const box = h.makeSandbox()
  const res = await h.npr(box, ['-h'])
  assert.equal(res.code, 0, h.dump(res))
  assert.match(h.plain(res.stdout), /^usage: npr \[bindep\] \[\.\.\.args\]/m)
  assert.match(h.plain(res.stdout), /npr --help/)
})

test('bin aliases: npr, nbd and npm-bin-deps all run the cli', async () => {
  const root = h.makeTmp()
  const env = h.isolatedEnv(root, path.join(root, 'home'), path.join(root, 'cache'))
  const npm = h.IS_WIN ? 'npm.cmd' : 'npm'
  const repo = path.join(__dirname, '..')

  const packed = await h.run(npm, ['pack', '--pack-destination', root, '--loglevel', 'error'], {
    cwd: repo, env, shell: h.IS_WIN
  })
  assert.equal(packed.code, 0, h.dump(packed))
  const tarball = fs.readdirSync(root).find((f) => f.endsWith('.tgz'))
  assert.ok(tarball, 'npm pack wrote a tarball')

  const prefix = path.join(root, 'prefix')
  const installed = await h.run(npm, [
    'install', '--global', '--prefix', prefix, path.join(root, tarball)
  ], { cwd: root, env, shell: h.IS_WIN })
  assert.equal(installed.code, 0, h.dump(installed))

  for (const name of ['npr', 'nbd', 'npm-bin-deps']) {
    const bin = h.IS_WIN
      ? path.join(prefix, name + '.cmd')
      : path.join(prefix, 'bin', name)
    const res = await h.run(bin, ['--help'], { cwd: root, env, shell: h.IS_WIN })
    assert.equal(res.code, 0, `${name}\n${h.dump(res)}`)
    assert.match(h.plain(res.stdout), /^usage: npr /m, name)
  }
})

test('errors: no package.json in cwd', async () => {
  const box = h.makeSandbox()
  const res = await h.npr(box, ['fx-echo'])
  assert.notEqual(res.code, 0, h.dump(res))
  assert.match(both(res), /package\.json/)
})

test('errors: package.json without binDependencies', async () => {
  const box = h.makeSandbox()
  h.writeProject(box, {})
  const res = await h.npr(box, ['fx-echo'])
  assert.equal(res.code, 1, h.dump(res))
  assert.match(both(res), /"binDependencies" field/)
})

test('run: installs on first use, then runs the bin', async (t) => {
  const box = standardBox()

  await t.test('npr <bin> [args] runs the bin in the project cwd', async () => {
    const res = await h.npr(box, ['fx-echo', 'a', '--b', 'c d'])
    assert.equal(res.code, 0, h.dump(res))
    const out = h.lastJSONLine(res.stdout)
    assert.equal(out.name, 'fx-echo')
    assert.equal(out.version, '1.0.0')
    assert.deepEqual(out.args, ['a', '--b', 'c d'])
    assert.equal(fs.realpathSync(out.cwd), box.project)
  })

  await t.test('a second run does not reinstall', async () => {
    const log = path.join(box.root, 'installs.log')
    const res = await h.npr(box, ['fx-echo', 'again'], {
      env: { FX_INSTALL_LOG: log }
    })
    assert.equal(res.code, 0, h.dump(res))
    assert.deepEqual(h.lastJSONLine(res.stdout).args, ['again'])
    assert.equal(fs.existsSync(log), false, 'no install ran')
  })

  await t.test('args after -- reach the bin, -- included', async () => {
    const res = await h.npr(box, ['fx-echo', '--', '--flag'])
    assert.equal(res.code, 0, h.dump(res))
    assert.deepEqual(h.lastJSONLine(res.stdout).args, ['--', '--flag'])
  })

  await t.test('npr exec <bin> [args]', async () => {
    const res = await h.npr(box, ['exec', 'fx-echo', 'x', 'y'])
    assert.equal(res.code, 0, h.dump(res))
    const out = h.lastJSONLine(res.stdout)
    assert.equal(out.name, 'fx-echo')
    assert.deepEqual(out.args, ['x', 'y'])
  })

  await t.test('the exit code passes through', async () => {
    for (const code of [0, 1, 3, 42]) {
      const res = await h.npr(box, ['fx-exit', String(code)])
      assert.equal(res.code, code, h.dump(res))
    }
    const viaExec = await h.npr(box, ['exec', 'fx-exit', '7'])
    assert.equal(viaExec.code, 7, h.dump(viaExec))
  })

  await t.test('npr which <bin> prints a runnable path', async () => {
    const res = await h.npr(box, ['which', 'fx-echo'])
    assert.equal(res.code, 0, h.dump(res))
    const lines = h.plain(res.stdout).trim().split(/\r?\n/)
    const bin = lines[lines.length - 1].trim()
    const suffix = path.join('node_modules', '.bin', 'fx-echo') + (h.IS_WIN ? '.cmd' : '')
    assert.ok(bin.endsWith(suffix), bin)
    assert.ok(fs.existsSync(bin), bin)
    assert.ok(bin.startsWith(box.root), `${bin} is inside the sandbox`)

    const direct = await h.run(bin, ['direct'], {
      cwd: box.project, env: box.env, shell: h.IS_WIN
    })
    assert.equal(direct.code, 0, h.dump(direct))
    assert.deepEqual(h.lastJSONLine(direct.stdout).args, ['direct'])
  })

  await t.test('npr ls lists the installed bin deps', async () => {
    const res = await h.npr(box, ['ls'])
    assert.equal(res.code, 0, h.dump(res))
    assert.match(h.plain(res.stdout), /fx-echo@?\s?1\.0\.0/)
    assert.match(h.plain(res.stdout), /fx-tools@?\s?1\.0\.0/)
  })

  await t.test('an unknown command lists the commands that DO exist', async () => {
    const res = await h.npr(box, ['fx-nope'])
    assert.equal(res.code, 1, h.dump(res))
    const out = both(res)
    assert.match(out, /Could not find command: fx-nope/)
    assert.match(out, /The following commands DO exist/)
    const listing = out.split(/\r?\n/).filter((l) => l.startsWith('--  '))
    assert.ok(listing.length > 0, out)
    const names = listing.join(' ')
    for (const bin of ['fx-echo', 'fx-exit', 'fx-env']) {
      assert.match(names, new RegExp(`\\b${bin}\\b`), out)
    }
  })
})

test('reinstall when binDependencies change', async () => {
  const box = standardBox()

  let res = await h.npr(box, ['fx-echo'])
  assert.equal(res.code, 0, h.dump(res))
  assert.equal(h.lastJSONLine(res.stdout).version, '1.0.0')

  // A new version of an existing dep.
  const pkg = h.readProject(box)
  pkg.binDependencies['fx-echo'] = fx['fx-echo@2.0.0']
  h.writeProject(box, pkg)
  res = await h.npr(box, ['fx-echo'])
  assert.equal(res.code, 0, h.dump(res))
  assert.equal(h.lastJSONLine(res.stdout).version, '2.0.0')

  // A removed dep is gone.
  delete pkg.binDependencies['fx-tools']
  h.writeProject(box, pkg)
  res = await h.npr(box, ['fx-exit', '0'])
  assert.equal(res.code, 1, h.dump(res))
  assert.match(both(res), /Could not find command: fx-exit/)

  // An added dep appears.
  pkg.binDependencies['fx-tools'] = fx['fx-tools@1.0.0']
  h.writeProject(box, pkg)
  res = await h.npr(box, ['fx-exit', '5'])
  assert.equal(res.code, 5, h.dump(res))
})

test('npr install <pkg> adds a bin dep; npr rm <pkg> removes it', async () => {
  const box = h.makeSandbox()
  // install works even before the project has a binDependencies field
  h.writeProject(box, { scripts: { keep: 'me' } })

  let res = await h.npr(box, ['install', fx['fx-echo@1.0.0']])
  assert.equal(res.code, 0, h.dump(res))
  let pkg = h.readProject(box)
  assert.ok(pkg.binDependencies, 'binDependencies written')
  assert.ok(pkg.binDependencies['fx-echo'], JSON.stringify(pkg))
  assert.deepEqual(pkg.scripts, { keep: 'me' }, 'the rest of package.json is kept')
  assert.ok(fs.readFileSync(path.join(box.project, 'package.json'), 'utf8').endsWith('}\n'))

  res = await h.npr(box, ['fx-echo', 'hi'])
  assert.equal(res.code, 0, h.dump(res))
  assert.deepEqual(h.lastJSONLine(res.stdout).args, ['hi'])

  res = await h.npr(box, ['install', fx['fx-tools@1.0.0']])
  assert.equal(res.code, 0, h.dump(res))
  pkg = h.readProject(box)
  assert.deepEqual(Object.keys(pkg.binDependencies).sort(), ['fx-echo', 'fx-tools'])

  res = await h.npr(box, ['rm', 'fx-echo'])
  assert.equal(res.code, 0, h.dump(res))
  pkg = h.readProject(box)
  assert.deepEqual(Object.keys(pkg.binDependencies), ['fx-tools'])

  res = await h.npr(box, ['fx-echo'])
  assert.equal(res.code, 1, h.dump(res))
  assert.match(both(res), /Could not find command: fx-echo/)
  res = await h.npr(box, ['fx-exit', '0'])
  assert.equal(res.code, 0, h.dump(res))
})

test('npr cache clean: the next run installs again', async () => {
  const log = path.join(h.makeTmp(), 'installs.log')
  const box = standardBox({ FX_INSTALL_LOG: log })

  let res = await h.npr(box, ['fx-exit', '0'])
  assert.equal(res.code, 0, h.dump(res))
  assert.equal(fs.readFileSync(log, 'utf8'), 'fx-tools@1.0.0\n')

  res = await h.npr(box, ['cache', 'clean'])
  assert.equal(res.code, 0, h.dump(res))

  res = await h.npr(box, ['fx-exit', '0'])
  assert.equal(res.code, 0, h.dump(res))
  assert.equal(fs.readFileSync(log, 'utf8'), 'fx-tools@1.0.0\nfx-tools@1.0.0\n')
})

test('lock: concurrent first runs install once and all succeed', async () => {
  const log = path.join(h.makeTmp(), 'installs.log')
  const box = standardBox({ FX_INSTALL_LOG: log })

  const runs = await Promise.all([1, 2, 3, 4, 5].map((n) =>
    h.npr(box, ['fx-exit', String(n)])
  ))
  runs.forEach((res, i) => {
    assert.equal(res.code, i + 1, h.dump(res))
  })
  assert.equal(fs.readFileSync(log, 'utf8'), 'fx-tools@1.0.0\n', 'one install')
})
