'use strict'

// Row: built-ins over vendored code — the lock.
//
// fs.openSync(path, 'wx') with stale detection (dead owner pid, or no
// heartbeat), released by exit and signal handlers.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const h = require('./helpers.js')
const { acquire, withLock } = require('../lib/lock.js')

const LOCK_JS = path.join(__dirname, '..', 'lib', 'lock.js')

/**
 * Write a script that takes the lock and then does `body`.
 *
 * @param {string} dir
 * @param {string} body  code run while holding `release`
 * @returns {string}
 */
function lockScript (dir, body) {
  const file = path.join(dir, `script-${Math.random().toString(16).slice(2)}.js`)
  fs.writeFileSync(file, `'use strict'
const fs = require('fs')
const { acquire } = require(${JSON.stringify(LOCK_JS)})
const lockPath = process.argv[2]
const out = process.argv[3]
acquire(lockPath, { pollMs: 10 }).then(async (release) => {
  ${body}
})
`)
  return file
}

test('withLock creates the lock file and removes it after', async () => {
  const dir = h.makeTmp()
  const lockPath = path.join(dir, 'x.lock')
  const result = await withLock(lockPath, async () => {
    const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    assert.equal(owner.pid, process.pid)
    assert.equal(owner.host, os.hostname())
    return 42
  })
  assert.equal(result, 42)
  assert.equal(fs.existsSync(lockPath), false)

  await assert.rejects(withLock(lockPath, async () => { throw new Error('boom') }), /boom/)
  assert.equal(fs.existsSync(lockPath), false, 'released on throw')
})

test('processes holding the lock never overlap', async () => {
  const dir = h.makeTmp()
  const lockPath = path.join(dir, 'x.lock')
  const out = path.join(dir, 'out.log')
  const script = lockScript(dir, `
  fs.appendFileSync(out, 'start ' + process.pid + '\\n')
  await new Promise((r) => setTimeout(r, 50))
  fs.appendFileSync(out, 'end ' + process.pid + '\\n')
  release()
`)
  const runs = await Promise.all([1, 2, 3, 4, 5, 6].map(() =>
    h.run(process.execPath, [script, lockPath, out])
  ))
  for (const res of runs) assert.equal(res.code, 0, h.dump(res))
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n')
  assert.equal(lines.length, 12)
  for (let i = 0; i < lines.length; i += 2) {
    const [a, pidA] = lines[i].split(' ')
    const [b, pidB] = lines[i + 1].split(' ')
    assert.equal(a, 'start')
    assert.equal(b, 'end')
    assert.equal(pidA, pidB, 'each start is followed by its own end')
  }
  assert.equal(fs.existsSync(lockPath), false)
})

test('a lock left by a dead process on this host is broken at once', async () => {
  const dir = h.makeTmp()
  const lockPath = path.join(dir, 'x.lock')
  const gone = await new Promise((resolve) => {
    const child = require('node:child_process').spawn(process.execPath, ['-e', ''])
    child.on('exit', () => resolve(child.pid))
  })
  fs.writeFileSync(lockPath, JSON.stringify({ pid: gone, host: os.hostname(), time: new Date().toISOString() }))
  const start = Date.now()
  await withLock(lockPath, async () => {}, { waitMs: 5000 })
  assert.ok(Date.now() - start < 2000)
})

test('a lock not touched for staleMs is broken; garbage too', async () => {
  const dir = h.makeTmp()
  const lockPath = path.join(dir, 'x.lock')
  const old = new Date(Date.now() - 60 * 1000)

  // Owner looks alive (it's us, on another "host"), but no heartbeat.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: 'elsewhere' }))
  fs.utimesSync(lockPath, old, old)
  await withLock(lockPath, async () => {}, { waitMs: 2000, staleMs: 30000 })

  fs.writeFileSync(lockPath, 'not json')
  fs.utimesSync(lockPath, old, old)
  await withLock(lockPath, async () => {}, { waitMs: 2000, staleMs: 30000 })
})

test('a live, fresh lock makes others wait, then time out', async () => {
  const dir = h.makeTmp()
  const lockPath = path.join(dir, 'x.lock')
  const release = await acquire(lockPath)
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: 'elsewhere' }))
    await assert.rejects(
      withLock(lockPath, async () => {}, { waitMs: 300, pollMs: 20 }),
      /Could not acquire lock for concurrent npr/
    )
  } finally {
    release()
  }
})

test('the holder keeps a long-held lock fresh', async () => {
  const dir = h.makeTmp()
  const lockPath = path.join(dir, 'x.lock')
  const release = await acquire(lockPath, { heartbeatMs: 20 })
  try {
    const old = new Date(Date.now() - 60 * 1000)
    fs.utimesSync(lockPath, old, old)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(Date.now() - fs.statSync(lockPath).mtimeMs < 1000)
  } finally {
    release()
  }
})

test('a holder killed by a signal releases its lock', {
  skip: h.IS_WIN && 'POSIX signals'
}, async () => {
  const dir = h.makeTmp()
  const lockPath = path.join(dir, 'x.lock')
  const script = lockScript(dir, `
  fs.writeFileSync(out, 'held')
  setInterval(() => {}, 1000)
`)
  const ready = path.join(dir, 'ready')
  const child = require('node:child_process').spawn(process.execPath, [script, lockPath, ready])
  for (let i = 0; i < 100 && !fs.existsSync(ready); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(fs.existsSync(lockPath), 'child holds the lock')
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal)))
  child.kill('SIGTERM')
  assert.equal(await exited, 'SIGTERM', 'dies of the same signal')
  assert.equal(fs.existsSync(lockPath), false)
})

test('a holder killed with SIGKILL leaves a lock the next run breaks', {
  skip: h.IS_WIN && 'POSIX signals'
}, async () => {
  const dir = h.makeTmp()
  const lockPath = path.join(dir, 'x.lock')
  const ready = path.join(dir, 'ready')
  const script = lockScript(dir, `
  fs.writeFileSync(out, 'held')
  setInterval(() => {}, 1000)
`)
  const child = require('node:child_process').spawn(process.execPath, [script, lockPath, ready])
  for (let i = 0; i < 100 && !fs.existsSync(ready); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const exited = new Promise((resolve) => child.on('exit', resolve))
  child.kill('SIGKILL')
  await exited
  assert.ok(fs.existsSync(lockPath), 'SIGKILL cannot clean up')
  await withLock(lockPath, async () => {}, { waitMs: 2000 })
})
