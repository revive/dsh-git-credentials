# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A `v*` tag's GitHub Release body is composed from the matching section below — see
Publishing in the README. Keep each released version's section self-contained: it ships
to users as the release notes.

## [Unreleased]

### Changed

- GitHub Releases are composed from this file's section for the tag's version instead of
  a fixed notice; a version without a section falls back to GitHub's generated notes.

## [0.4.0] - 2026-10-05

### Added

- `get` action on every issues and merge/pull-request tool: read one item by number and
  get its description, labels, and creation/update timestamps, plus the source and target
  branches and the draft flag on merge and pull requests. Descriptions are capped at the
  configured read limit and a capped read is flagged in the result and the rendered text.

### Fixed

- One `get` read renders as a single newline-separated block. Separate content blocks are
  concatenated without a separator, which ran the title into the metadata line and the
  metadata into the description.

### Removed

- The no-op invariant companion (`src/invariant.ts`, its build entry, and the `./invariant`
  export). The harness dropped the invariant-companion convention, and the file only broke
  out-of-tree type checking while registering nothing.

## [0.3.4] - 2026-09-29

### Changed

- The `@deepseek-ai/dsh-tools` peer is `>=0.1.7-rc.1 <1.0.0`: bundle admission accepts the
  whole 0.x harness line, so a harness bump no longer forces a plugin release. 1.0.0 stays
  the deliberate re-validation boundary.
- `publishConfig` pins the public npm registry, so a mirror configured in the local npm
  client cannot misroute a publish.

### Fixed

- `tools/gen-tsconfig.mjs` falls back to a package's source when the checkout has not built
  that client face, instead of pointing at a missing declaration file.

## [0.3.3] - 2026-09-24

### Fixed

- The `@deepseek-ai/dsh-tools` peer tracks the harness's lockstep version line
  (`^0.1.7-rc.1`). Harness packages version with the product and bundle admission reads
  these peers against the runtime, so the stale range got the whole bundle layer skipped on
  0.1.7 — the tools and the Settings page disappeared.

## [0.3.2] - 2026-09-09

### Fixed

- The Settings panel no longer stays permanently blank when the admin read fails: it shows
  a loading line and, on failure, the error plus a retry button.

### Changed

- The panel is a `settings.section` entry of the current client slot standard (composed
  section props, no inject face); type checking targets the harness checkout in use.

## [0.3.1] - 2026-09-03

### Added

- GitHub Actions release pipeline: pushing a `v*` tag builds the node half and the browser
  bundle in the cloud, packs the tarball, and attaches it to the release.

### Changed

- Self-contained build toolchain: no private dev dependencies, and the runtime
  `@deepseek-ai/*` peers resolve from the dsh installation.

## [0.3.0] - 2026-09-03

### Added

- `*_releases` tools (list, create, delete) for GitLab, GitHub, Gitee, and Gitea. Bitbucket
  has no releases API and ships no release tool.
