'use strict'

// Reading the project's pnpm rules without a YAML or ini dependency.
//
// pnpm takes these settings from pnpm-workspace.yaml, from the "pnpm"
// field of package.json, or from .npmrc (kebab-case). We only need a
// handful of top-level keys, so a tiny reader for top-level YAML
// scalars and lists is enough.

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
  parseNpmrc,
  readPnpmSettings,
  pnpmWorkspaceYAML
}
