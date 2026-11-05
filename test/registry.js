'use strict'

// A minimal npm registry on 127.0.0.1 for tests that need version
// ranges or publish times (lockfile pinning, minimumReleaseAge), which
// `file:` tarballs can't express. It serves tarballs built by
// `npm pack`; nothing leaves the machine.

const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')

/** @typedef {import('./helpers.js').FixtureSpec} FixtureSpec */

/**
 * @typedef {{
 *   url: string,
 *   publish: (spec: FixtureSpec, tarball: string, time?: Date) => void,
 *   close: () => Promise<void>,
 *   requests: string[],
 *   authorizations: string[]
 * }} Registry
 */

/**
 * The manifest npm-pack'd fixtures carry, as the registry reports it.
 *
 * @param {FixtureSpec} spec
 * @returns {Record<string, unknown>}
 */
function manifestFor (spec) {
  /** @type {Record<string, string> | undefined} */
  let bin
  if (spec.bin) {
    bin = {}
    for (const name of Object.keys(spec.bin)) bin[name] = `bin/${name}.js`
  }
  return {
    name: spec.name,
    version: spec.version,
    bin,
    scripts: spec.scripts,
    dependencies: spec.dependencies,
    optionalDependencies: spec.optionalDependencies,
    hasInstallScript: Boolean(spec.scripts && (
      spec.scripts.preinstall || spec.scripts.install || spec.scripts.postinstall
    )) || undefined
  }
}

/**
 * Compare two x.y.z versions.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVersions (a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

/**
 * @returns {Promise<Registry>}
 */
async function startRegistry () {
  /**
   * @type {Map<string, Map<string, {
   *   manifest: Record<string, unknown>, tarball: string, time: Date
   * }>>}
   */
  const packages = new Map()
  /** @type {string[]} */
  const requests = []
  /** @type {string[]} the authorization header of each request, or '' */
  const authorizations = []
  let base = ''

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
    requests.push(urlPath)
    authorizations.push(req.headers.authorization || '')

    const tarballMatch = /^\/(.+)\/-\/[^/]+-(\d+\.\d+\.\d+)\.tgz$/.exec(urlPath)
    if (tarballMatch) {
      const versions = packages.get(tarballMatch[1])
      const entry = versions && versions.get(tarballMatch[2])
      if (!entry) return notFound(res)
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(fs.readFileSync(entry.tarball))
      return
    }

    const name = urlPath.slice(1)
    const versions = packages.get(name)
    if (!versions) return notFound(res)

    /** @type {Record<string, unknown>} */
    const docVersions = {}
    /** @type {Record<string, string>} */
    const time = {}
    let latest = '0.0.0'
    let created = new Date(8640000000000000)
    let modified = new Date(0)
    for (const [version, entry] of versions) {
      const data = fs.readFileSync(entry.tarball)
      const base64 = crypto.createHash('sha512').update(data).digest('base64')
      const shasum = crypto.createHash('sha1').update(data).digest('hex')
      const file = name.replace(/^@/, '').replace('/', '-')
      docVersions[version] = {
        ...entry.manifest,
        dist: {
          tarball: `${base}/${name}/-/${file}-${version}.tgz`,
          integrity: `sha512-${base64}`,
          shasum
        }
      }
      time[version] = entry.time.toISOString()
      if (compareVersions(version, latest) > 0) latest = version
      if (entry.time < created) created = entry.time
      if (entry.time > modified) modified = entry.time
    }
    time.created = created.toISOString()
    time.modified = modified.toISOString()

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      name,
      'dist-tags': { latest },
      versions: docVersions,
      time,
      modified: time.modified
    }))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(null)))
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address())
  base = `http://127.0.0.1:${addr.port}`

  return {
    url: base + '/',
    requests,
    authorizations,
    publish (spec, tarball, time) {
      let versions = packages.get(spec.name)
      if (!versions) {
        versions = new Map()
        packages.set(spec.name, versions)
      }
      versions.set(spec.version, {
        manifest: manifestFor(spec),
        tarball,
        time: time || new Date(Date.now() - 365 * 24 * 3600 * 1000)
      })
    },
    close () {
      return new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    }
  }
}

/**
 * @param {http.ServerResponse} res
 */
function notFound (res) {
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"error":"not found"}')
}

module.exports = { startRegistry, manifestFor }
