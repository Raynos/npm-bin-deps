'use strict'

// Reading the project's pnpm rules and overrides without a YAML or ini
// dependency.
//
// pnpm takes these settings from pnpm-workspace.yaml, from the "pnpm"
// field of package.json, or from .npmrc (kebab-case). We only need a
// handful of top-level keys and the one-level `overrides` map, so a
// tiny reader for top-level YAML scalars, lists and flat maps is
// enough.

const fs = require('node:fs')
const path = require('node:path')

/**
 * The pnpm settings npr carries from the project into the generated
 * bin-deps dir, in the order they are written out.
 */
const PNPM_SETTINGS = /** @type {const} */ ([
  'minimumReleaseAge',
  'minimumReleaseAgeExclude',
  'strictDepBuilds',
  'onlyBuiltDependencies',
  'ignoredOptionalDependencies'
])

/** @typedef {typeof PNPM_SETTINGS[number]} PnpmSettingName */
/** @typedef {string | number | boolean | string[]} SettingValue */
/** @typedef {Partial<Record<PnpmSettingName, SettingValue>>} PnpmSettings */

/**
 * Parse one YAML scalar: quoted strings, numbers, booleans, null.
 *
 * @param {string} raw
 * @returns {string | number | boolean | null}
 */
function parseScalar (raw) {
  const text = stripComment(raw).trim()
  if (text === '' || text === '~' || text === 'null') return null
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text)
    } catch (_err) {
      return text.slice(1, -1)
    }
  }
  if (text.startsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  return text
}

/**
 * Drop a trailing ` # comment`, leaving quoted `#` alone.
 *
 * @param {string} text
 * @returns {string}
 */
function stripComment (text) {
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i)
    }
  }
  return text
}

/**
 * Parse a flow list: `[a, "b", c]`.
 *
 * @param {string} text
 * @returns {string[]}
 */
function parseFlowList (text) {
  const inner = text.trim().replace(/^\[/, '').replace(/\]$/, '')
  if (inner.trim() === '') return []
  return inner.split(',').map((s) => String(parseScalar(s)))
}

/**
 * Read the top-level keys of a YAML document whose values are scalars
 * or lists of scalars. Nested maps are skipped.
 *
 * @param {string} text
 * @returns {Record<string, SettingValue | null>}
 */
function parseTopLevelYAML (text) {
  /** @type {Record<string, SettingValue | null>} */
  const out = {}
  /** @type {string | null} */
  let listKey = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).replace(/\s+$/, '')
    if (line.trim() === '' || line.trim() === '---') continue
    const indented = /^\s/.test(line)
    if (indented) {
      const item = /^\s+-\s+(.*)$/.exec(line)
      if (listKey && item) {
        const list = /** @type {string[]} */ (out[listKey])
        list.push(String(parseScalar(item[1])))
      }
      continue
    }
    listKey = null
    const m = /^("[^"]*"|'[^']*'|[^:]+):(?:\s+(.*))?$/.exec(line)
    if (!m) continue
    const key = String(parseScalar(m[1]))
    const rest = (m[2] || '').trim()
    if (rest === '') {
      out[key] = []
      listKey = key
    } else if (rest.startsWith('[')) {
      out[key] = parseFlowList(rest)
    } else {
      out[key] = parseScalar(rest)
    }
  }
  return out
}

/**
 * Read a top-level YAML key whose value is a flat map of scalars, such
 * as pnpm-workspace.yaml's `overrides`. Returns null when the key is
 * missing.
 *
 * @param {string} text
 * @param {string} key
 * @returns {Record<string, string> | null}
 */
function parseYAMLMap (text, key) {
  /** @type {Record<string, string> | null} */
  let out = null
  let inside = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).replace(/\s+$/, '')
    if (line.trim() === '' || line.trim() === '---') continue
    const indented = /^\s/.test(line)
    const m = /^\s*("[^"]*"|'[^']*'|[^:]+):(?:\s+(.*))?$/.exec(line)
    if (!indented) {
      inside = false
      if (m && String(parseScalar(m[1])) === key) {
        out = out || {}
        inside = (m[2] || '').trim() === ''
      }
      continue
    }
    if (!inside || !m || out === null) continue
    const value = parseScalar(m[2] || '')
    if (value !== null) out[String(parseScalar(m[1]))] = String(value)
  }
  return out
}

/**
 * Read a top-level YAML key whose value is a map of flat maps, such as
 * pnpm-workspace.yaml's `catalogs`. Returns null when the key is
 * missing.
 *
 * @param {string} text
 * @param {string} key
 * @returns {Record<string, Record<string, string>> | null}
 */
function parseYAMLNestedMap (text, key) {
  /** @type {Record<string, Record<string, string>> | null} */
  let out = null
  let inside = false
  let childIndent = -1
  /** @type {Record<string, string> | null} */
  let group = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).replace(/\s+$/, '')
    if (line.trim() === '' || line.trim() === '---') continue
    const indent = line.length - line.trimStart().length
    const m = /^\s*("[^"]*"|'[^']*'|[^:]+):(?:\s+(.*))?$/.exec(line)
    if (indent === 0) {
      inside = false
      if (m && String(parseScalar(m[1])) === key) {
        out = out || {}
        inside = (m[2] || '').trim() === ''
        childIndent = -1
        group = null
      }
      continue
    }
    if (!inside || !m || out === null) continue
    if (childIndent === -1) childIndent = indent
    const name = String(parseScalar(m[1]))
    if (indent === childIndent) {
      group = out[name] = out[name] || {}
      continue
    }
    const value = parseScalar(m[2] || '')
    if (group && value !== null) group[name] = String(value)
  }
  return out
}

/** @typedef {Record<string, Record<string, string>>} Catalogs */

/**
 * The project's pnpm catalogs from pnpm-workspace.yaml: `catalog` is
 * the one named "default", `catalogs` holds the named ones.
 *
 * @param {string} projectRoot
 * @returns {Catalogs}
 */
function readCatalogs (projectRoot) {
  const text = readIfExists(path.join(projectRoot, 'pnpm-workspace.yaml'))
  if (text === null) return {}
  const out = parseYAMLNestedMap(text, 'catalogs') || {}
  const flat = parseYAMLMap(text, 'catalog')
  if (flat) out.default = { ...out.default, ...flat }
  return out
}

/**
 * Replace a `catalog:` or `catalog:<name>` spec with the version the
 * catalog gives `name`. The bin-deps dir is its own workspace, so the
 * reference would not resolve there. Other specs, and references the
 * catalogs do not cover, are returned as they are.
 *
 * @param {string} name
 * @param {string} spec
 * @param {Catalogs} catalogs
 * @returns {string}
 */
function resolveCatalog (name, spec, catalogs) {
  if (!spec.startsWith('catalog:')) return spec
  const catalog = catalogs[spec.slice('catalog:'.length).trim() || 'default']
  return (catalog && Object.hasOwn(catalog, name)) ? catalog[name] : spec
}

/**
 * The package an override key targets: `a>b@<2` overrides `b`.
 *
 * @param {string} key
 * @returns {string}
 */
function overrideTarget (key) {
  const last = key.split('>').pop() || key
  const at = last.lastIndexOf('@')
  return at > 0 ? last.slice(0, at) : last
}

/**
 * Read key=value lines from an .npmrc.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseNpmrc (text) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

/** Top-level .npmrc keys that are auth for the default registry. */
const AUTH_KEYS = new Set([
  '_auth', '_authToken', '_password', 'username', 'email', 'always-auth'
])

/**
 * Is an .npmrc key a registry or auth setting? `registry`,
 * `@scope:registry`, anything scoped to a registry host
 * (`//host/:_authToken`, `//host/:_auth`, ...) and the top-level auth
 * keys.
 *
 * @param {string} key
 * @returns {boolean}
 */
function isRegistryKey (key) {
  return key === 'registry' ||
    /^@[^:\s]+:registry$/.test(key) ||
    key.startsWith('//') ||
    AUTH_KEYS.has(key)
}

/**
 * The registry and auth lines of the project's .npmrc, verbatim (so
 * `${ENV}` references still expand when the manager reads them).
 * These hold secrets: never log them or write them into
 * binDependenciesDir.
 *
 * @param {string} projectRoot
 * @returns {string[]}
 */
function readNpmrcRegistryLines (projectRoot) {
  const text = readIfExists(path.join(projectRoot, '.npmrc'))
  if (text === null) return []
  /** @type {string[]} */
  const out = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    if (isRegistryKey(line.slice(0, eq).trim())) out.push(line)
  }
  return out
}

/**
 * @param {string} name
 * @returns {string}
 */
function kebab (name) {
  return name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function readIfExists (file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Normalise one setting value: lists stay lists of strings, numbers
 * and booleans keep their type.
 *
 * @param {PnpmSettingName} name
 * @param {unknown} value
 * @returns {SettingValue | undefined}
 */
function normalise (name, value) {
  if (value === null || value === undefined) return undefined
  const isList = name === 'onlyBuiltDependencies' ||
    name === 'ignoredOptionalDependencies' ||
    name === 'minimumReleaseAgeExclude'
  if (isList) {
    if (Array.isArray(value)) return value.map(String)
    return String(value).split(',').map((s) => s.trim()).filter(Boolean)
  }
  if (name === 'strictDepBuilds') {
    return value === true || value === 'true'
  }
  if (name === 'minimumReleaseAge') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/**
 * The project's pnpm rules that npr carries into the bin-deps dir.
 * pnpm-workspace.yaml wins over package.json's "pnpm" field, which
 * wins over .npmrc.
 *
 * @param {string} projectRoot
 * @param {Record<string, any>} pkg
 * @returns {PnpmSettings}
 */
function readPnpmSettings (projectRoot, pkg) {
  const yamlText = readIfExists(path.join(projectRoot, 'pnpm-workspace.yaml'))
  const yaml = yamlText ? parseTopLevelYAML(yamlText) : {}
  const field = pkg.pnpm && typeof pkg.pnpm === 'object' ? pkg.pnpm : {}
  const npmrcText = readIfExists(path.join(projectRoot, '.npmrc'))
  const npmrc = npmrcText ? parseNpmrc(npmrcText) : {}

  /** @type {PnpmSettings} */
  const out = {}
  for (const name of PNPM_SETTINGS) {
    const candidates = [yaml[name], field[name], npmrc[kebab(name)], npmrc[name]]
    for (const candidate of candidates) {
      const value = normalise(name, candidate)
      if (value !== undefined) {
        out[name] = value
        break
      }
    }
  }
  return out
}

/** @typedef {{ [name: string]: string | Overrides }} Overrides */

/**
 * The project's direct dependency specs, for `$name` references in
 * overrides.
 *
 * @param {Record<string, any>} pkg
 * @returns {Record<string, string>}
 */
function directSpecs (pkg) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const field of ['peerDependencies', 'optionalDependencies', 'devDependencies', 'dependencies']) {
    const deps = pkg[field]
    if (!deps || typeof deps !== 'object') continue
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === 'string') out[name] = spec
    }
  }
  return out
}

/**
 * Copy an overrides object, keeping only string and object values,
 * replacing `$name` references with the project's spec for `name` and
 * `catalog:` references with the catalog's version (the generated
 * package.json has only the bin deps and is its own workspace, so
 * neither would resolve there). `workspace:` overrides are dropped:
 * they point at the project's own packages, which the bin-deps install
 * cannot see.
 *
 * @param {unknown} value
 * @param {Record<string, string>} specs
 * @param {Catalogs} catalogs
 * @returns {Overrides}
 */
function copyOverrides (value, specs, catalogs) {
  /** @type {Overrides} */
  const out = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec === 'string') {
      if (spec.startsWith('workspace:')) continue
      const ref = spec.startsWith('$') ? specs[spec.slice(1)] : undefined
      out[name] = resolveCatalog(overrideTarget(name), ref === undefined ? spec : ref, catalogs)
    } else if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
      out[name] = copyOverrides(spec, specs, catalogs)
    }
  }
  return out
}

/**
 * The project's overrides for one manager, to carry into the
 * generated package.json: npm's `overrides` field, or for pnpm the
 * `"pnpm".overrides` field merged under pnpm-workspace.yaml's
 * `overrides` (the yaml wins, as in pnpm). Null when there are none.
 *
 * @param {string} projectRoot
 * @param {Record<string, any>} pkg
 * @param {'npm' | 'pnpm'} manager
 * @returns {Overrides | null}
 */
function readOverrides (projectRoot, pkg, manager) {
  const specs = directSpecs(pkg)
  const catalogs = readCatalogs(projectRoot)
  /** @type {Overrides} */
  let out
  if (manager === 'npm') {
    out = copyOverrides(pkg.overrides, specs, catalogs)
  } else {
    const field = pkg.pnpm && typeof pkg.pnpm === 'object' ? pkg.pnpm.overrides : undefined
    const yamlText = readIfExists(path.join(projectRoot, 'pnpm-workspace.yaml'))
    const yaml = yamlText ? parseYAMLMap(yamlText, 'overrides') : null
    out = { ...copyOverrides(field, specs, catalogs), ...copyOverrides(yaml, specs, catalogs) }
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Write pnpm settings as a pnpm-workspace.yaml.
 *
 * @param {PnpmSettings} settings
 * @returns {string}
 */
function pnpmWorkspaceYAML (settings) {
  const lines = [
    '# Generated by npm-bin-deps from the project\'s pnpm settings.',
    '# Do not edit; it is rewritten from ../package.json.'
  ]
  for (const name of PNPM_SETTINGS) {
    const value = settings[name]
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${name}: []`)
        continue
      }
      lines.push(`${name}:`)
      for (const item of value) lines.push(`  - ${JSON.stringify(item)}`)
    } else {
      lines.push(`${name}: ${JSON.stringify(value)}`)
    }
  }
  return lines.join('\n') + '\n'
}

module.exports = {
  PNPM_SETTINGS,
  parseTopLevelYAML,
  parseYAMLMap,
  parseYAMLNestedMap,
  readCatalogs,
  resolveCatalog,
  parseNpmrc,
  readNpmrcRegistryLines,
  readPnpmSettings,
  readOverrides,
  pnpmWorkspaceYAML
}
