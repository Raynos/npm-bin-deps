'use strict'

// Running bins: what 2.x adds on top of the parity suite.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const h = require('./helpers.js')
const proc = require('../lib/proc.js')

/** @type {Record<string, string>} */
let fx = {}

test.before(async () => {
  fx = await h.buildFixtures()
})

test('a bin killed by a signal kills npr with the same signal', {
  skip: h.IS_WIN && 'POSIX signals'
}, async () => {
  const box = h.makeSandbox()
  h.writeProject(box, { binDependencies: { 'fx-tools': fx['fx-tools@1.0.0'] } })
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    const res = await h.npr(box, ['fx-signal', sig])
    assert.equal(res.signal, sig, h.dump(res))
  }
})

test('npr which on a cold cache prints only the path on stdout', async () => {
  const box = h.makeSandbox()
  h.writeProject(box, { binDependencies: { 'fx-echo': fx['fx-echo@1.0.0'] } })
  const res = await h.npr(box, ['which', 'fx-echo'])
  assert.equal(res.code, 0, h.dump(res))
  const lines = res.stdout.split(/\r?\n/).filter(Boolean)
  assert.equal(lines.length, 1, h.dump(res))
  assert.ok(fs.existsSync(lines[0]))
  assert.match(res.stderr, /installing bin deps/)
})

test('npr status lines carry no colour when stderr is not a TTY', async () => {
  const box = h.makeSandbox()
  h.writeProject(box, { binDependencies: { 'fx-echo': fx['fx-echo@1.0.0'] } })
  const env = { ...box.env }
  delete env.NO_COLOR
  const res = await h.run(process.execPath, [h.INDEX, 'fx-echo'], { cwd: box.project, env })
  assert.equal(res.code, 0, h.dump(res))
  assert.doesNotMatch(res.stderr, /\u001b\[/)
})

test('a failed install leaves no half-installed cache dir behind', async () => {
  const box = h.makeSandbox()
  h.writeProject(box, {
    binDependencies: { 'fx-missing': 'file:' + path.join(box.root, 'nope.tgz') }
  })
  const res = await h.npr(box, ['fx-missing'])
  assert.notEqual(res.code, 0, h.dump(res))
  const root = path.join(box.cacheHome, 'npm-bin-deps')
  const left = fs.existsSync(root)
    ? fs.readdirSync(root).filter((f) => !f.endsWith('.lock'))
    : []
  assert.deepEqual(left, [])
  assert.equal(fs.existsSync(path.join(box.project, 'package.json')), true, 'project package.json kept')
})

test('windows: arguments are escaped for cmd.exe like cross-spawn', () => {
  assert.equal(proc.escapeWinArg('foo', false), '^"foo^"')
  assert.equal(proc.escapeWinArg('a b', false), '^"a^ b^"')
  assert.equal(proc.escapeWinArg('a"b', false), '^"a\\^"b^"')
  assert.equal(proc.escapeWinArg('dir\\', false), '^"dir\\\\^"')
  assert.equal(proc.escapeWinArg('a\\"b', false), '^"a\\\\\\^"b^"')
  assert.equal(proc.escapeWinArg('a&b|c', false), '^"a^&b^|c^"')
  assert.equal(proc.escapeWinArg('%PATH%', false), '^"^%PATH^%^"')
  assert.equal(proc.escapeWinArg('a&b', true), '^^^"a^^^&b^^^"')
  assert.equal(proc.escapeWinArg('', false), '^"^"')
  assert.equal(proc.escapeWinCommand('C:\\Program Files\\x (86)\\npm'), 'C:\\Program^ Files\\x^ ^(86^)\\npm')
})

test('pathKey finds PATH', () => {
  if (h.IS_WIN) {
    assert.equal(proc.pathKey({ Path: 'x' }), 'Path')
    assert.equal(proc.pathKey({ PATH: 'x' }), 'PATH')
  } else {
    assert.equal(proc.pathKey({ Path: 'x' }), 'PATH')
  }
})
