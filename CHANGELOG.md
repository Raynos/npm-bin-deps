# Changelog

## 2.0.0 (unreleased)

A rewrite that keeps every 1.x command (`npr <bin>`, `exec`, `which`,
`ls`, `install`, `rm`, `cache clean`, help, the `npr` / `nbd` /
`npm-bin-deps` names) and adds a committed lockfile, pnpm support and
a content-addressed cache.

### Breaking

- **Node 20 or newer.**
- **A committed dir.** npr now writes `binDependenciesDir` (default
  `.bin-deps/`) into the project: a generated `package.json` and the
  manager's lockfile. Commit it. The first `npr` run in a 1.x project
  creates it.
- **Locked versions.** Installs are frozen from that lockfile
  (`npm ci` / `pnpm install --frozen-lockfile`). A range in
  `binDependencies` stays at its locked version until
  `binDependencies` changes; 1.x re-resolved on every fresh install.
- **The cache moved** from `~/.config/npm-bin-deps/<package name>` to
  `~/.cache/npm-bin-deps/<hash>` (`$XDG_CACHE_HOME`, or
  `%LOCALAPPDATA%` on Windows). npr does not delete the old dirs;
  remove `~/.config/npm-bin-deps` by hand.
- **pnpm may install instead of npm**, picked from
  `binDependenciesInstaller`, `packageManager`, the project lockfile,
  the lockfile already in `binDependenciesDir` or
  `npm_config_user_agent`. With pnpm, its rules apply: install scripts
  run only for `onlyBuiltDependencies`, and `minimumReleaseAge` can
  refuse a version.
- **npr's messages go to stderr**, not stdout, and are coloured only
  when stderr is a terminal. That includes the "these DO exist"
  listing. A tool's stdout, and `npr which`, carry only their own
  output.
- **A tool killed by a signal kills npr with that signal.** 1.x exited
  0.
- **`npr cache clean`** removes this project's current install only.
  `npr cache <anything else>` is an error; 1.x ran a bin named
  `cache`.
- **`npr rm`** takes package names and no longer passes flags to
  `npm rm`.
- **The generated package.json holds only `dependencies`.** 1.x
  copied the whole project package.json (so fields such as
  `overrides` reached the install) and blanked `scripts`,
  `devDependencies` and `peerDependencies`.
- A missing command no longer runs `npm ls`, and a failed npm command
  no longer deletes the cache's package.json.

### Added

- `npr install` with no packages: re-resolve and install.
- `npr install --frozen`: install from the committed dir, fail if
  stale. Meant for `prepare` and CI.
- `npr cache prune`: remove installs unused for 30 days.
- `binDependenciesDir` and `binDependenciesInstaller` in package.json.
- pnpm's `minimumReleaseAge`, `minimumReleaseAgeExclude`,
  `strictDepBuilds`, `onlyBuiltDependencies` and
  `ignoredOptionalDependencies` carry over from the project.
- Tools run with the install's `node_modules/.bin` first on `PATH`,
  and with `OXLINT_TSGOLINT_PATH` set when `oxlint-tsgolint` is a bin
  dependency.
- Windows: `.cmd` shims (npm, pnpm, tools) run through `cmd.exe` with
  escaped arguments; current Node refuses to spawn them directly.

### Internal

- Zero dependencies: the vendored `rimraf`, `lockfile` and
  `signal-exit` are replaced by `fs.rmSync`, an `fs.openSync(path,
  'wx')` lock with stale detection, and exit/signal handlers.
- JSDoc types checked by `tsc --noEmit --checkJs` in strict mode.
- An offline `node:test` suite, run by CI on Linux, macOS and Windows
  with Node 20, 22 and 24.
