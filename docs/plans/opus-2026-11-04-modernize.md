# Plan: npm-bin-deps 2.0 for greenroom

Status: in progress 2026-11-05: Jake said go; a Claude Code agent
builds it row by row, commits locally, never pushes or publishes.
Parity suite written against 1.10.2 first; rows done: v1 parity,
lockfile in `binDependenciesDir`, manager detection and installer,
content-addressed cache, sibling binaries, built-ins over vendored
code, types and lint, tests (green under a macOS sandbox with
outbound network denied).
Owner: Jake. Builder: Claude Code (claude-opus-5-5).

## Why

Jake wants greenroom's dev dependencies out of `node_modules`: "i
think i like npm-bin-deps why cant we use it ? we can clone it and
improve it." A test on 2026-11-04 showed `npr` 1.10.2 (published
2022) still runs oxlint 1.89, oxfmt 0.74 and TypeScript 7.0.2 on
Node 24, but four things make it unsafe to adopt (below). Jake:
"We want to have feature parity with v1 of npm-bin-deps".

## What's wrong in 1.10.2 (`index.js`)

1. **No lockfile.** `npm install` into
   `~/.config/npm-bin-deps/<pkg.name>/` re-resolves transitive
   versions each time; no integrity record lives in the project.
2. **npm, not the project's rules.** It ignores pnpm's
   `minimumReleaseAge`, `strictDepBuilds` and `onlyBuiltDependencies`,
   never runs through a wrapper like `socket`, and runs every install
   script.
3. **Cache keyed by package name.** Two projects called `greenroom`,
   or two checkouts with different `binDependencies`, share one dir.
4. **Siblings can't find each other.** oxlint finds tsgolint via
   `node_modules` or `OXLINT_TSGOLINT_PATH`; nothing sets that.

Smaller: vendored `rimraf`, `lockfile` and `signal-exit`; a failed
install deletes the cache's package.json; no tests.

## Design (Jake's picks, 2026-11-04/05)

- **Declared** in the project's package.json `binDependencies`, as in
  1.x. Scripts call tools explicitly: `npr oxlint`. No shims.
- **Package manager:** one `npr` that detects it: the `packageManager`
  field, then the lockfile beside package.json (`pnpm-lock.yaml` /
  `package-lock.json`), then `npm_config_user_agent`, then npm. The
  package.json field `binDependenciesInstaller` overrides (e.g.
  `"socket pnpm"`, `"pnpm"`, `"npm"`).
- **Lockfile home:** `binDependenciesDir` in package.json (default
  `.bin-deps/`; greenroom will set `src/bin-deps`). npr writes
  `<dir>/package.json` (dependencies = `binDependencies`) and the
  manager's native lockfile beside it (`pnpm-lock.yaml` or
  `package-lock.json`). Both are committed.
- **pnpm rules carry over:** with pnpm, copy the project's
  `minimumReleaseAge`, `strictDepBuilds`, `onlyBuiltDependencies` and
  `ignoredOptionalDependencies` into the generated package.json /
  config. With npm, no extra guard (Jake: "No extra guard on npm").
- **Cache:** `~/.cache/npm-bin-deps/<sha256 of the lockfile>`
  (respect `XDG_CACHE_HOME`; on Windows `%LOCALAPPDATA%`). A run
  installs there frozen (`pnpm install --frozen-lockfile` / `npm ci`)
  if the dir is missing.
- **When tools download:** a project `prepare` step runs
  `npr install --frozen`; a run that finds no cache installs lazily
  as a fallback.
- **Siblings:** run the tool with the cache's `node_modules/.bin`
  first on `PATH`; set `OXLINT_TSGOLINT_PATH` when `oxlint-tsgolint` is
  a bin dependency.
- **Source:** plain JS, CommonJS, JSDoc types checked by `tsc
  --checkJs`; Node 20 floor; zero runtime dependencies.
- **Platforms:** macOS, Linux and Windows, tested on a GitHub Actions
  matrix.

## Rows

- [x] **v1 parity.** Every 1.x behaviour stays: `npr <bin> [args]`,
  `npr exec <bin>`, `npr which <bin>`, `npr ls`, `npr install
  <pkg>`, `npr rm <pkg>`, `npr cache clean`, `-h`/`--help`/`help`,
  the `npr`/`nbd`/`npm-bin-deps` bin aliases, reinstall when
  `binDependencies` changed, a lock so concurrent `npr` runs don't
  race, the exit code passed through, and the "could not find
  command, these DO exist" listing. Done when a parity test runs each
  1.x command against fixtures and the help text lists the same
  commands plus the new ones.
- [x] **Lockfile in `binDependenciesDir`.** `npr install <pkg>` /
  `npr rm <pkg>` update `binDependencies`, regenerate
  `<dir>/package.json` and the native lockfile; `npr install --frozen`
  installs from it without changing it. Done when a test commits the
  dir, wipes the cache, and a fresh run installs identical versions
  (lockfile unchanged byte for byte).
- [x] **Manager detection and installer.** Detection order above,
  `binDependenciesInstaller` override, pnpm rules copied. Done when
  tests cover each detection source, the override, and (pnpm) a
  package newer than `minimumReleaseAge` refused and an unlisted
  install script not run.
- [x] **Content-addressed cache.** Hash-keyed dirs, an access stamp
  per run, `npr cache prune` (unused 30 days), `npr cache clean`
  (this project's current dir). Done when two projects with the same
  name and different versions run side by side.
- [x] **Sibling binaries.** `PATH` and `OXLINT_TSGOLINT_PATH`. Done
  when an e2e test runs `npr oxlint --type-aware` (or a fixture
  equivalent) with no oxlint in the project's `node_modules`.
- [x] **Built-ins over vendored code.** Replace `rimraf.js`,
  `lockfile.js`, `signal-exit.js`, `signals.js` with `fs.rmSync`, an
  `fs.openSync(path, 'wx')` lock with stale detection, and process
  exit handlers. Done when those files are gone and `npm ls --all`
  prints nothing.
- [x] **Types and lint.** JSDoc on every function, `tsc --noEmit
  --checkJs` clean in strict mode. Done when `npm run check` passes.
- [x] **Tests.** `node:test`, temp dirs, offline: fixture packages
  built with `npm pack` and installed from local tarballs (no
  registry, no network). Done when `npm test` passes with the network
  off.
- [ ] **CI.** GitHub Actions matrix: ubuntu, macos, windows; Node 20,
  22, 24; runs check + test. Done when the workflow file is in and
  passes locally where it can (`act` not required).
- [ ] **Docs.** README rewritten for 2.0 (the new fields, the
  committed dir, the cache, pnpm vs npm), and a CHANGELOG entry
  listing the breaking changes. Done when the README's examples match
  the tests.
- [ ] **Release prep.** Version 2.0.0 in package.json, `npm pack
  --dry-run` lists only the intended files. Push and `npm publish`
  are Jake's.

## Then in greenroom (a greenroom plan row, after 2.0.0 is out)

- `binDependencies`: typescript, oxlint, oxlint-tsgolint, oxfmt;
  esbuild too if `src/tools/build-web.ts` switches to the esbuild
  CLI. `binDependenciesDir`: `src/bin-deps`.
- Stay in `devDependencies` (code imports them): `@playwright/test`,
  `@types/node`, `npm-bin-deps`.

## Decided (Jake)

- 2026-11-04: pnpm lockfile (now: the manager's native lockfile in
  `binDependenciesDir`); ship as `npm-bin-deps@2` on npm;
  `@types/node` stays a greenroom devDependency.
- 2026-11-05: one auto-detecting `npr`; configurable
  `binDependenciesDir`; cache in `~/.cache/npm-bin-deps`; download on
  install with a lazy fallback; declared in `binDependencies`;
  explicit `npr <tool>`; plain JS + JSDoc; all platforms with a CI
  matrix; Node 20 floor; CommonJS; commands run/exec/which/ls,
  install/rm, cache prune/clean; no extra guard on npm; v1 feature
  parity; a subagent builds it; Jake reviews, pushes and publishes.
