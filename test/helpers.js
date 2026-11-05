'use strict'

// Shared test helpers: temp dirs, an isolated environment, fixture
// packages built with `npm pack`, and a way to run `npr` as a child.
//
// Every child process gets HOME, XDG_* and LOCALAPPDATA pointed into a
// temp dir, and npm/pnpm get a registry that cannot answer
// (127.0.0.1:9), so a test that reaches for the network fails loudly
// instead of quietly downloading.

const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const INDEX = path.join(__dirname, '..', 'index.js')
const IS_WIN = process.platform === 'win32'
const DEAD_REGISTRY = 'http://127.0.0.1:9/'

/**
 * @typedef {{
 *   code: number | null,
 *   signal: NodeJS.Signals | null,
 *   stdout: string,
 *   stderr: string
 * }} RunResult
 */

/**
 * @typedef {{
 *   cwd?: string,
 *   env?: Record<string, string | undefined>,
 *   shell?: boolean,
 *   input?: string
 * }} RunOptions
 */

/**
 * Make a fresh temp dir; removed when the process exits.
 *
 * @param {string} [prefix]
 * @returns {string}
 */
function makeTmp (prefix) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'npr-test-'))
  )
  TMP_DIRS.push(dir)
  return dir
}

/** @type {string[]} */
const TMP_DIRS = []
process.on('exit', () => {
  if (process.env.NPR_TEST_KEEP_TMP) return
  for (const dir of TMP_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (_err) {
      // best effort
    }
  }
})

/**
 * A sandbox: a temp root with a home, a cache and a project dir.
 *
 * @typedef {{
 *   root: string,
 *   home: string,
 *   cacheHome: string,
 *   project: string,
 *   env: Record<string, string | undefined>
 * }} Sandbox
 */

/**
 * @param {Record<string, string | undefined>} [extraEnv]
 * @returns {Sandbox}
 */
function makeSandbox (extraEnv) {
  const root = makeTmp()
  const home = path.join(root, 'home')
  const cacheHome = path.join(root, 'xdg-cache')
  const project = path.join(root, 'project')
  for (const dir of [home, cacheHome, project]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const env = isolatedEnv(root, home, cacheHome)
  Object.assign(env, extraEnv || {})
  return { root, home, cacheHome, project, env }
}

/**
 * The parent env minus anything npm/pnpm/node:test leak into it, with
 * every home-ish dir pointed into `root`.
 *
 * @param {string} root
 * @param {string} home
 * @param {string} cacheHome
 * @returns {Record<string, string | undefined>}
 */
function isolatedEnv (root, home, cacheHome) {
  /** @type {Record<string, string | undefined>} */
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    const lower = key.toLowerCase()
    if (lower.startsWith('npm_')) continue
    if (lower.startsWith('pnpm_')) continue
    if (lower.startsWith('xdg_')) continue
    if (lower === 'init_cwd') continue
    if (lower === 'node_test_context') continue
    if (lower === 'node_options') continue
    if (lower === 'oxlint_tsgolint_path') continue
    env[key] = value
  }
  env.HOME = home
  env.USERPROFILE = home
  env.XDG_CACHE_HOME = cacheHome
  env.XDG_CONFIG_HOME = path.join(root, 'xdg-config')
  env.XDG_DATA_HOME = path.join(root, 'xdg-data')
  env.XDG_STATE_HOME = path.join(root, 'xdg-state')
  if (IS_WIN) {
    env.LOCALAPPDATA = path.join(root, 'localappdata')
    env.APPDATA = path.join(root, 'appdata')
  }
  env.npm_config_registry = DEAD_REGISTRY
  env.npm_config_audit = 'false'
  env.npm_config_fund = 'false'
  env.npm_config_update_notifier = 'false'
  env.npm_config_fetch_retries = '0'
  env.npm_config_cache = path.join(root, 'npm-cache')
  env.npm_config_store_dir = path.join(root, 'pnpm-store')
  env.NO_COLOR = '1'
  return env
}

/**
 * Run a command and collect its output.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {RunOptions} [opts]
 * @returns {Promise<RunResult>}
 */
function run (cmd, args, opts) {
  const o = opts || {}
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(cmd, args, {
      cwd: o.cwd,
      env: /** @type {NodeJS.ProcessEnv} */ (o.env || process.env),
      shell: o.shell,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (d) => { stdout += d })
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('error', reject)
    proc.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr })
    })
    proc.stdin.end(o.input || '')
  })
}

/**
 * Run `node index.js ...args` inside a sandbox's project.
 *
 * @param {Sandbox} box
 * @param {string[]} args
 * @param {RunOptions} [opts]
 * @returns {Promise<RunResult>}
 */
function npr (box, args, opts) {
  const o = opts || {}
  return run(process.execPath, [INDEX, ...args], {
    cwd: o.cwd || box.project,
    env: { ...box.env, ...(o.env || {}) }
  })
}

/**
 * Assert-friendly dump of a run, for failure messages.
 *
 * @param {RunResult} res
 * @returns {string}
 */
function dump (res) {
  return `exit ${res.code} signal ${res.signal}\n` +
    `--- stdout\n${res.stdout}\n--- stderr\n${res.stderr}`
}

/**
 * Strip ANSI colour codes.
 *
 * @param {string} text
 * @returns {string}
 */
function plain (text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

/**
 * @param {string} file
 * @returns {any}
 */
function readJSON (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * @param {string} file
 * @param {unknown} value
 */
function writeJSON (file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

/**
 * Write the sandbox project's package.json.
 *
 * @param {Sandbox} box
 * @param {Record<string, unknown>} pkg
 */
function writeProject (box, pkg) {
  writeJSON(path.join(box.project, 'package.json'), {
    name: 'fixture-project',
    version: '1.0.0',
    ...pkg
  })
}

/**
 * @param {Sandbox} box
 * @returns {any}
 */
function readProject (box) {
  return readJSON(path.join(box.project, 'package.json'))
}

// --- fixture packages -------------------------------------------------

/**
 * A bin that prints who it is, its args and its cwd as JSON.
 */
const ECHO_BIN = `#!/usr/bin/env node
'use strict'
const pkg = require('./package.json')
console.log(JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  args: process.argv.slice(2),
  cwd: process.cwd()
}))
`

/** Exit with the code in argv[2]. */
const EXIT_BIN = `#!/usr/bin/env node
'use strict'
process.exitCode = Number(process.argv[2] || 0)
`

/** Kill itself with the signal in argv[2]. */
const SIGNAL_BIN = `#!/usr/bin/env node
'use strict'
process.kill(process.pid, process.argv[2] || 'SIGTERM')
setTimeout(() => {}, 10000)
`

/** Print the env vars npr is expected to set. */
const ENV_BIN = `#!/usr/bin/env node
'use strict'
console.log(JSON.stringify({
  PATH: process.env.PATH || process.env.Path || '',
  OXLINT_TSGOLINT_PATH: process.env.OXLINT_TSGOLINT_PATH || null
}))
`

/**
 * An install script that appends one line to $FX_INSTALL_LOG (if set),
 * so tests can count installs.
 */
const COUNT_SCRIPT = `'use strict'
const fs = require('fs')
const pkg = require('./package.json')
if (process.env.FX_INSTALL_LOG) {
  fs.appendFileSync(process.env.FX_INSTALL_LOG, pkg.name + '@' + pkg.version + '\\n')
}
`

/**
 * @typedef {{
 *   name: string,
 *   version: string,
 *   bin?: Record<string, string>,
 *   files?: Record<string, string>,
 *   scripts?: Record<string, string>,
 *   dependencies?: Record<string, string>,
 *   optionalDependencies?: Record<string, string>
 * }} FixtureSpec
 */

/**
 * Build a package dir from a spec and `npm pack` it into `outDir`.
 * Returns the absolute tarball path.
 *
 * @param {FixtureSpec} spec
 * @param {string} outDir
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<string>}
 */
async function packFixture (spec, outDir, env) {
  const srcDir = path.join(outDir, 'src', `${spec.name.replace('/', '+')}@${spec.version}`)
  fs.mkdirSync(srcDir, { recursive: true })
  /** @type {Record<string, string>} */
  const binMap = {}
  for (const [binName, source] of Object.entries(spec.bin || {})) {
    const file = `bin/${binName}.js`
    binMap[binName] = file
    fs.mkdirSync(path.join(srcDir, 'bin'), { recursive: true })
    // bins require('./package.json') relative to the package root
    fs.writeFileSync(
      path.join(srcDir, file),
      source.replace("require('./package.json')", "require('../package.json')"),
      { mode: 0o755 }
    )
  }
  for (const [file, source] of Object.entries(spec.files || {})) {
    fs.mkdirSync(path.dirname(path.join(srcDir, file)), { recursive: true })
    fs.writeFileSync(path.join(srcDir, file), source)
  }
  writeJSON(path.join(srcDir, 'package.json'), {
    name: spec.name,
    version: spec.version,
    license: 'MIT',
    bin: spec.bin ? binMap : undefined,
    scripts: spec.scripts,
    dependencies: spec.dependencies,
    optionalDependencies: spec.optionalDependencies
  })
  const res = await run(
    IS_WIN ? 'npm.cmd' : 'npm',
    ['pack', '--pack-destination', outDir, '--loglevel', 'error'],
    { cwd: srcDir, env, shell: IS_WIN }
  )
  if (res.code !== 0) {
    throw new Error(`npm pack ${spec.name} failed\n${dump(res)}`)
  }
  const base = spec.name.replace(/^@/, '').replace('/', '-')
  const tarball = path.join(outDir, `${base}-${spec.version}.tgz`)
  if (!fs.existsSync(tarball)) {
    throw new Error(`npm pack did not write ${tarball}\n${dump(res)}`)
  }
  return tarball
}

/** @type {FixtureSpec[]} */
const STANDARD_FIXTURES = [
  {
    name: 'fx-echo',
    version: '1.0.0',
    bin: { 'fx-echo': ECHO_BIN }
  },
  {
    name: 'fx-echo',
    version: '2.0.0',
    bin: { 'fx-echo': ECHO_BIN }
  },
  {
    name: 'fx-tools',
    version: '1.0.0',
    bin: {
      'fx-exit': EXIT_BIN,
      'fx-signal': SIGNAL_BIN,
      'fx-env': ENV_BIN
    },
    files: { 'count.js': COUNT_SCRIPT },
    scripts: { postinstall: 'node count.js' }
  }
]

/**
 * Pack the standard fixtures once into a temp dir. Returns a map of
 * `name@version` to a `file:` spec usable in binDependencies.
 *
 * @param {FixtureSpec[]} [extra]
 * @returns {Promise<Record<string, string>>}
 */
async function buildFixtures (extra) {
  const outDir = makeTmp('npr-fixtures-')
  const env = isolatedEnv(outDir, path.join(outDir, 'home'), path.join(outDir, 'cache'))
  /** @type {Record<string, string>} */
  const specs = {}
  const all = STANDARD_FIXTURES.concat(extra || [])
  const tarballs = await Promise.all(
    all.map((spec) => packFixture(spec, outDir, env))
  )
  all.forEach((spec, i) => {
    specs[`${spec.name}@${spec.version}`] = 'file:' + tarballs[i]
  })
  return specs
}

/**
 * Is a command on PATH?
 *
 * @param {string} cmd
 * @returns {boolean}
 */
function hasCommand (cmd) {
  const res = childProcess.spawnSync(cmd, ['--version'], {
    shell: IS_WIN,
    stdio: 'ignore'
  })
  return res.status === 0
}

/**
 * Parse the JSON line printed by the fx-echo / fx-env bins.
 *
 * @param {string} stdout
 * @returns {any}
 */
function lastJSONLine (stdout) {
  const lines = stdout.trim().split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line.startsWith('{')) return JSON.parse(line)
  }
  throw new Error('no JSON line in output:\n' + stdout)
}

module.exports = {
  INDEX,
  IS_WIN,
  DEAD_REGISTRY,
  ECHO_BIN,
  EXIT_BIN,
  ENV_BIN,
  COUNT_SCRIPT,
  makeTmp,
  makeSandbox,
  isolatedEnv,
  run,
  npr,
  dump,
  plain,
  readJSON,
  writeJSON,
  writeProject,
  readProject,
  packFixture,
  buildFixtures,
  hasCommand,
  lastJSONLine
}
