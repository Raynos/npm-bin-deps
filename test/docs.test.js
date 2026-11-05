'use strict'

// Row: docs. The README's examples match what npr does and what the
// other tests exercise.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const h = require('./helpers.js')
const config = require('../lib/config.js')

const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')

/**
 * Fenced code blocks of one language.
 *
 * @param {string} lang
 * @returns {string[]}
 */
function blocks (lang) {
  const re = new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g')
  return Array.from(README.matchAll(re), (m) => m[1])
}

const FIELDS = ['binDependencies', 'binDependenciesDir', 'binDependenciesInstaller']

test('the README help block is `npr --help`, verbatim', async () => {
  const block = blocks('sh').find((b) => b.startsWith('$ npr --help\n'))
  assert.ok(block, 'README has a `$ npr --help` block')
  const res = await h.npr(h.makeSandbox(), ['--help'])
  assert.equal(res.code, 0, h.dump(res))
  assert.equal(block.slice('$ npr --help\n'.length), res.stdout)
})

test('the README json examples parse and use real fields', () => {
  const json = blocks('json')
  assert.ok(json.length >= 2)
  const parsed = json.map((b) => JSON.parse(b))
  const example = parsed[0]
  assert.deepEqual(Object.keys(example).filter((k) => k.startsWith('bin')), [
    'binDependencies', 'binDependenciesDir'
  ])
  // The same dir the lockfile tests use.
  assert.equal(example.binDependenciesDir, 'src/bin-deps')
  assert.equal(example.scripts.prepare, 'npr install --frozen')
})

test('the README field table lists the fields npr reads', () => {
  for (const field of FIELDS) {
    assert.match(README, new RegExp('\\| `' + field + '` \\|'), field)
  }
})

test('the README pnpm-workspace.yaml example reads as the settings it names', () => {
  const [yaml] = blocks('yaml')
  assert.deepEqual(config.readPnpmSettings(writeTmp('pnpm-workspace.yaml', yaml), {}), {
    minimumReleaseAge: 1440,
    onlyBuiltDependencies: ['esbuild']
  })
  for (const name of config.PNPM_SETTINGS) {
    assert.ok(README.includes('`' + name + '`'), `README names ${name}`)
  }
})

test('every `$ npr` line in the README is a real command', () => {
  const known = new Set(['install', 'rm', 'which', 'ls', 'exec', 'cache', '--help', 'oxfmt'])
  const lines = blocks('sh').join('\n').split('\n').filter((l) => l.startsWith('$ npr '))
  assert.ok(lines.length >= 3)
  for (const line of lines) {
    assert.ok(known.has(line.split(' ')[2]), line)
  }
})

/**
 * @param {string} name
 * @param {string} text
 * @returns {string} the dir
 */
function writeTmp (name, text) {
  const dir = h.makeTmp()
  fs.writeFileSync(path.join(dir, name), text)
  return dir
}
