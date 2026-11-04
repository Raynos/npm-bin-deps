# Plan: modernize npm-bin-deps for greenroom

Status: draft 2026-11-04: waits on Jake's go. Owner: Jake. Builder:
Claude Code (claude-opus-5-5).

## Why

Jake wants greenroom's dev dependencies out of `node_modules`: "i
think i like npm-bin-deps why cant we use it ? we can clone it and
improve it." A test on 2026-11-04 showed `npr` 1.10.2 (last
published 2022) still runs oxlint 1.89, oxfmt 0.74 and TypeScript
7.0.2 on Node 24. Four things stop it being safe to adopt.

## What's wrong today (read in `index.js`, 1.10.2)

1. **No lockfile.** `npm install` into
   `~/.config/npm-bin-deps/<pkg.name>/` resolves transitive versions
   fresh each time; there's no integrity record in the project.
2. **npm, not the project's rules.** Plain `npm install` ignores
   pnpm's `minimumReleaseAge`, `strictDepBuilds` and
   `onlyBuiltDependencies`, never runs through the `socket` wrapper,
   and runs every install script.
3. **Cache keyed by package name.** Two projects called `greenroom`,
   or two checkouts on different `binDependencies`, share one dir and
   reinstall over each other.
4. **Siblings can't find each other.** oxlint looks for tsgolint via
   `node_modules` or `OXLINT_TSGOLINT_PATH`; nothing sets that.

Smaller: vendored `rimraf`, `lockfile` and `signal-exit` (Node 24 has
`fs.rmSync` and `fs.openSync(..., 'wx')`); a failed install deletes
the cache's package.json; no tests.

## Rows

- [ ] **Committed lockfile.** `npr install` writes the resolved tree
  to `bin-deps.lock.yaml` in the project (a pnpm lockfile for the
  `binDependencies` alone); every run installs it frozen. Done when a
  test changes nothing in the project and a second machine-like run
  (fresh cache) installs byte-identical versions.
- [ ] **pnpm as the installer, with the project's rules.** Install
  with `pnpm install --frozen-lockfile` and copy the project's
  `minimumReleaseAge`, `strictDepBuilds` and `onlyBuiltDependencies`
  into the cache dir; if `binDependenciesInstaller` is set (e.g.
  `"socket pnpm"`), use it. Done when a test sees a package newer
  than the age limit refused and an unlisted install script not run.
- [ ] **Content-addressed cache.** Cache dir =
  `~/.cache/npm-bin-deps/<sha256 of the lockfile>`; `npr cache prune`
  removes dirs no project referenced in 30 days. Done when two
  projects with the same name and different versions run side by
  side.
- [ ] **Sibling binaries.** Run the tool with the cache's `.bin`
  first on `PATH`, and set `OXLINT_TSGOLINT_PATH` when tsgolint is a
  bin dependency. Done when `npr oxlint --type-aware` works with no
  oxlint packages in the project's `node_modules`.
- [ ] **Modernize.** ESM, Node 24, drop the vendored rimraf,
  lockfile and signal-exit for built-ins; keep zero dependencies.
  Done when `npm ls --all` in npm-bin-deps prints nothing.
- [ ] **Tests.** `node:test` with temp dirs and a local registry of
  `npm pack`ed fixture packages (no network). Done when CI runs them
  offline.
- [ ] **Publish** 2.0.0 (breaking: new cache path, lockfile). Done
  when greenroom installs it from npm.

## Then in greenroom

- `binDependencies`: typescript, oxlint, oxlint-tsgolint, oxfmt.
  esbuild too, if `src/tools/build-web.ts` calls the esbuild CLI
  instead of its JS API.
- Stay in `devDependencies` (imported by code, so they must resolve
  from `node_modules`): `@playwright/test`, `@types/node`,
  `npm-bin-deps` itself.
- Result: `node_modules` holds the runtime four (hono,
  @hono/node-server, preact, zod) plus about five dev packages.

## Open decisions for Jake

- Lockfile format: a pnpm lockfile (reuses pnpm's integrity and age
  rules) or our own JSON (name, version, integrity per package)?
- Publish to npm as `npm-bin-deps@2`, or keep it a git dependency of
  greenroom?
- Should `@types/node` move to the cache too, with `typeRoots`
  pointing there?
