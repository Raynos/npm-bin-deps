# npm-bin-deps

`npr` runs your project's CLI dev tools (linters, compilers, test
runners) without installing them into the project's `node_modules`.

You list the tools under `binDependencies` in package.json. `npr`
locks them in a small committed dir, installs them into a shared
cache outside the project, and runs them from there.

## Goal

Keep `node_modules`, `npm ls` and the project lockfile about the code
you ship. CLI tools bring hundreds of transitive packages that your
code never imports; they don't need to sit next to it.

`npm-bin-deps` solves half the problem, look at the sister project
[`pre-bundled`][pre-bundled] to solve the other half.

## Example

```json
{
  "scripts": {
    "prepare": "npr install --frozen",
    "lint": "npr oxlint --type-aware",
    "typecheck": "npr tsc -p ."
  },
  "devDependencies": {
    "npm-bin-deps": "2.1.0"
  },
  "binDependencies": {
    "oxlint": "1.89.0",
    "oxlint-tsgolint": "7.0.2004",
    "typescript": "7.0.2"
  },
  "binDependenciesDir": "src/bin-deps"
}
```

Add a tool with `npr install`:

```sh
$ npr install oxfmt
```

That saves the exact version into `binDependencies`, writes
`src/bin-deps/package.json` and the lockfile beside it, and installs.
Commit both files. Then:

```sh
$ npr oxfmt --check src
```

## Docs

```sh
$ npr --help
usage: npr [bindep] [...args]
`npr` will execute your binary dependency

`npr` respects the dependencies listed in "binDependencies" in package.json
These are the `npr` commands used in various situations:

Run a binary command
    npr [bindep]       Run a command; e.g. npr standard or npr tap
    npr exec [bindep]  Run a command; e.g. npr exec standard or npr exec tap

Install or remove a binary dependency
    npr install [bindep]  Install a new binary dependency
    npr rm [bindep]       Remove a binary dependency
    npr install           Update the lockfile from binDependencies and install
    npr install --frozen  Install exactly what the lockfile says; fail if stale

Clean the cache; if corrupted or broken
    npr cache clean       Clean the npr install cache for this project.
    npr cache prune       Remove cached installs unused for 30 days.

Inspect existing bin dependencies
    npr which [bindep]  Return the binary location for bindep
    npr ls              List all binary deps installed.

When running `npr`; you can hand-edit "binDependencies" in package.json and
the `npr exec [bindep]` command will make sure to download the new version
before executing the binary dependency.

package.json fields
    binDependencies           The bin deps: { "name": "version" }
    binDependenciesDir        Where npr writes their package.json and
                              lockfile; commit it. Default ".bin-deps"
    binDependenciesInstaller  Install command, e.g. "pnpm" or "socket pnpm".
                              Default: from "packageManager", then the
                              lockfile beside package.json, then npm
```

`npr` uses the nearest package.json, in or above the current directory,
that has `binDependencies`. In a monorepo, list the tools once in the
root package.json: `npr` run from a workspace package (where `npm run`
and `pnpm run` start scripts) uses them, and the tool still runs in
that package's directory. A package that lists its own
`binDependencies` uses those instead. `npr install <pkg>` adds to the
same package.json `npr` would run from.

`npr`'s own messages go to stderr; a tool's stdout is left alone, so
`$(npr which tsc)` gives just the path.

### package.json fields

| Field | Meaning |
| --- | --- |
| `binDependencies` | The tools, `{ "name": "version" }`, like `dependencies`. A `catalog:` version takes the version from your `pnpm-workspace.yaml` catalogs. |
| `binDependenciesDir` | Where npr writes the generated `package.json` and lockfile. Default `.bin-deps`. Commit it. |
| `binDependenciesInstaller` | The install command: `"npm"`, `"pnpm"`, or a wrapper such as `"socket pnpm"`. Default: detected. |

### The committed dir

`binDependenciesDir` holds two generated files (three with pnpm):

- `package.json`: `binDependencies` as plain `dependencies`, plus
  your project's overrides: `overrides` with npm; with pnpm,
  `"pnpm".overrides` and the `overrides` map of your
  `pnpm-workspace.yaml`. `catalog:` versions, in both
  `binDependencies` and overrides, are written as the catalog's
  version; `workspace:` overrides are left out.
- The manager's own lockfile: `package-lock.json` or `pnpm-lock.yaml`.
- With pnpm, `pnpm-workspace.yaml` carrying your pnpm rules (below).

Commit them. They pin every version, transitive ones included, so a
fresh clone runs the same tools you did.

When you change `binDependencies` (by hand, `npr install <pkg>` or
`npr rm <pkg>`), the next `npr` run re-resolves: it updates the
lockfile, keeping the pins of everything that didn't change.
`npr install --frozen` never rewrites the dir; it fails if
`binDependencies` and the dir disagree. Use it in `prepare` and CI.

### The cache

Installs live in `~/.cache/npm-bin-deps/<hash>/`, keyed by a sha256 of
the committed files. `$XDG_CACHE_HOME` moves it; on Windows it is
`%LOCALAPPDATA%\npm-bin-deps` unless `XDG_CACHE_HOME` is set.

- Two projects with the same tools share one install; two with
  different versions get two, and never reinstall over each other.
- An install is frozen (`npm ci` / `pnpm install --frozen-lockfile`).
  If a run finds no install for its lockfile, it installs then.
- Each run stamps the install it used. `npr cache prune` removes
  installs unused for 30 days. `npr cache clean` removes this
  project's current install.
- A lock file per install stops concurrent `npr` runs racing.

### npm or pnpm

npr picks the manager in this order:

1. `binDependenciesInstaller` in package.json.
2. `packageManager` in package.json (`pnpm@…` or `npm@…`).
3. A lockfile beside package.json: `pnpm-lock.yaml` or
   `package-lock.json`.
4. A lockfile already in `binDependenciesDir`, so the manager that
   wrote it keeps it.
5. `npm_config_user_agent`, set by `npm run` / `pnpm run`.
6. npm.

With **pnpm**, npr copies these settings from your project into the
committed `pnpm-workspace.yaml`, reading them from your
`pnpm-workspace.yaml`, the `"pnpm"` field of package.json, or `.npmrc`:
`minimumReleaseAge`, `minimumReleaseAgeExclude`, `strictDepBuilds`,
`onlyBuiltDependencies` and `ignoredOptionalDependencies`. So a tool
newer than your minimum release age is refused, and install scripts
run only for packages you allowed.

```yaml
# pnpm-workspace.yaml in your project
minimumReleaseAge: 1440
onlyBuiltDependencies:
  - esbuild
```

With **npm**, there is no extra guard: npm runs install scripts as it
normally would.

### Registry and auth

Installs run in the cache, outside your project, so npm and pnpm would
not see the project's `.npmrc`. npr carries its registry and auth
lines over: `registry=`, `@scope:registry=`, anything scoped to a
registry host (`//host/:_authToken=`, `//host/:_auth=`, ...) and the
top-level `_auth`, `_authToken`, `username`, `_password`, `email` and
`always-auth`. They are copied verbatim, so `${NPM_TOKEN}` still
expands from the environment, written to a `.npmrc` in the cache dir
for the length of the install and removed after. npr never logs them
and never writes them into `binDependenciesDir`. Your user `~/.npmrc`
and `npm_config_*` variables apply as usual.

### Sibling tools

A tool runs with its install's `node_modules/.bin` first on `PATH`, so
it can call the other bin dependencies. When `oxlint-tsgolint` is a bin
dependency, `OXLINT_TSGOLINT_PATH` points at its `tsgolint` (unless you
set it), so `npr oxlint --type-aware` works with no oxlint in
`node_modules`.

### `npr which {module}`

`npr which testcafe` prints the location of the binary, or exits 1
with nothing on stdout if no bin dependency provides it. Useful when a
script needs to `cd` first:

```json
{
  "scripts": {
    "testcafe": "TESTCAFE=$(npr which testcafe); cd ./tests/testcafe; $TESTCAFE *.ts"
  }
}
```

## Upgrading from 1.x

See [CHANGELOG.md](CHANGELOG.md). In short: the first `npr` run in a
1.x project writes `.bin-deps/` (commit it), installs move from
`~/.config/npm-bin-deps/<name>` to `~/.cache/npm-bin-deps/<hash>`
(delete the old dir by hand), and Node 20 is the minimum.

2.0 never reads the 1.x cache. Once every project on the machine runs
2.0, delete `~/.config/npm-bin-deps` (on Windows,
`%USERPROFILE%\.config\npm-bin-deps`); nothing breaks without it.

## install

```sh
$ npm install npm-bin-deps --save-dev
```

or globally with `npm install npm-bin-deps -g`. The package installs
three names for the same command: `npr`, `nbd` and `npm-bin-deps`.

## Development

```sh
$ npm install
$ npm run check   # tsc --noEmit --checkJs over the JSDoc types
$ npm test        # node:test, offline
```

The tests build fixture packages with `npm pack` and install them from
local tarballs, with HOME and the caches in temp dirs. A few tests that
need version ranges or publish dates use a tiny registry on 127.0.0.1.
`NPR_TEST_NETWORK=1 npm test` also runs real `oxlint --type-aware` from
the npm registry.

## MIT Licensed

  [pre-bundled]: https://github.com/Raynos/pre-bundled
