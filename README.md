# dsh-git-credentials

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4b32c3)](https://github.com/deepseek-ai/deepseek-harness)

[简体中文](README.zh-CN.md)

An out-of-tree plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that manages GitLab, GitHub, Gitee, Gitea, and Bitbucket API tokens so **token values never enter the model context**.

The model's tools carry only a token *reference name* (e.g. `GITLAB_TOKEN`); the value is decrypted from the plugin's own encrypted store at call time and appears only in the outgoing HTTP `Authorization` header. Changing a site or rotating a token takes effect on the very next call — no restart required.

## Features

- **Tokens stay out of the model context** — never in tool arguments, return values, or error messages; only business data (`site`, `project`, `path`, …) crosses the model boundary
- **Encrypted at rest** — AES-256-GCM encrypted data file with a separate 32-byte random key file (`0600`, atomic writes)
- **Per-provider tool scoping** — `gitlab_*` tools only see GitLab sites, `github_*` only GitHub sites, and likewise for `gitee_*`, `gitea_*`, `bitbucket_*`; unconfigured sites/tokens fail loud with the valid values listed in the error
- **Web settings panel** — add, edit, and delete sites; store or clear token values; **no response ever carries a token value**, only configured state
- **Hot load/unload** — mounts and unmounts on a running GUI without restarting it
- **Instant effect** — each tool call reads a freshly decrypted snapshot, so edits and rotations apply immediately

## Why not just an MCP server?

GitHub publishes an official MCP server, and the harness supports MCP clients natively — for GitHub-only automation, wiring up the official MCP server is the mainstream choice, and this plugin's `github_*` tools do overlap with it.

This plugin earns its place where MCP servers don't cover the gap:

| | Official GitHub MCP | This plugin |
|---|---|---|
| Forges | GitHub only (GitLab has an official server; Gitee / Gitea / Bitbucket rely on third-party servers of varying quality and maintenance) | One encrypted store, one settings panel, one tool set for GitLab, GitHub, Gitee, Gitea, and Bitbucket — including self-hosted Gitea / GitLab |
| Token handling | Plaintext environment variables per server, no management UI | AES-256-GCM encrypted storage, token reference names, settings-page management; token values never enter the model context |
| Integration | Extra MCP proxy process | Tools register directly in the harness tool registry |

Use the MCP route for a single hosted forge with standard token handling; use this plugin for multi-forge setups (especially Gitee or self-hosted Gitea), or when you want encrypted storage plus an in-product management page.

## Security model

### Storage

- `~/.dsh/git-credentials.json` — data file, fully encrypted with AES-256-GCM (`0600`, atomic write)
- `~/.dsh/git-credentials.key` — 32-byte random key, stored as a separate file (`0600`)

### Threat model

| Scenario | Protected? |
|---|---|
| A human copies/backs up/syncs the **data file** | ✅ Yes — ciphertext only; without the key file it cannot be decrypted |
| A **same-UID process** (e.g. the agent's bash/fs tools) reads both files | ❌ No — the key sits beside the data with the same permissions; same level as the harness's own key handling ("discretion, not a boundary") |
| The **user deliberately** asks the model to read the files | ❌ No — out of scope; no system can stop that |

Losing the key file means the data is unrecoverable (decryption fails loud and reports the key path); a copied data file alone is safe.

## Installation

### Option A: install the release tarball (recommended)

Download `dsh-git-credentials-<version>.tgz` from the [releases page](https://github.com/revive/dsh-git-credentials/releases) — the tarball ships the built browser bundle, so no harness checkout or build step is needed — then install it into a profile with the `dsh` CLI:

```sh
dsh plugin --profile <name> add ./dsh-git-credentials-0.4.0.tgz
```

The first use initializes the profile, pnpm links the package, and `dsh` appends the plugin to the profile's bundle layers. Verify the layer without booting:

```sh
dsh --profile <name> --dump-config    # look for "# == dsh-git-credentials"
```

> Installing a bundle does **not** hot-mount into a running GUI: bundle layers are composed at boot (HMR hot-applies only patch files), so restart the GUI process after `dsh plugin add`. After the restart, the plugin appears under **Settings → Git Credentials**.

### Option B: install from a source checkout

The plugin is a pure add-on — zero changes to harness code. Two entries under `~/.dsh` are enough:

1. Symlink the plugin directory so every profile can resolve the package:

   ```sh
   mkdir -p ~/.dsh/profiles/node_modules
   ln -s /path/to/dsh-git-credentials ~/.dsh/profiles/node_modules/dsh-git-credentials
   ```

2. Add the plugin row to the home-layer overlay `~/.dsh/cordis.patch.yml` (applies to every profile, web and headless alike):

   ```yaml
   - insert:
       - id: git-credentials
         name: 'dsh-git-credentials'
   ```

The HMR watcher monitors the home layer: adding the row hot-mounts the plugin into a running GUI, removing it (or `disabled: true`) hot-unmounts it, and config edits hot-reconfigure it. Uninstalling = removing both entries.

> The browser half (`lib/client.js`) is a build artifact — after cloning, build it first (see [Development](#development)). The release tarball already contains it.

## Usage

Manage sites and tokens in **Settings → Git Credentials**:

- **Add a site**: the form sits in its own **Add site** card below the configured list, with site id, provider (GitLab / GitHub / Gitee / Gitea / Bitbucket), API base URL (defaults per provider: `https://api.github.com`, `https://gitee.com/api/v5`, `https://api.bitbucket.org/2.0`; GitLab and Gitea are self-hosted and need their own address, e.g. `https://gitlab.example.com` / `https://gitea.example.com/api/v1`), token reference name (defaults to `GITLAB_TOKEN` / `GITHUB_TOKEN` / `GITEE_TOKEN` / `GITEA_TOKEN` / `BITBUCKET_TOKEN`), optional token value, and an optional default project. One **Save** writes the site and the token together; the field rules (site id charset, token reference charset, http(s) base URL) appear as field help, and an invalid draft says what is wrong and disables Save instead of failing server-side
- **Each configured site**: read-only by default (provider, base URL, token reference, default project, configured state) in its own card, with **Edit** and **Delete site**; edit mode reveals the inputs plus **Save / Cancel**, saves the fields and a newly typed token value in one action, and offers **Clear token** beside the token field
- The panel talks to same-origin `/git-credentials-admin/*` JSON endpoints; token values never appear in any response
- All changes take effect immediately — every tool call reads a fresh decrypted snapshot

### Tools

One resource tool per provider, with an `action` parameter selecting the operation. List actions return the provider's canonical summary shapes (repos: `{id, path, name, webUrl, visibility}`; issues/PRs: `{number|iid, title, state, webUrl, authorName}`; file: `{path, ref, content, truncated}`). `get` reads one issue or merge/pull request in full — that summary plus `body`, `labels`, `createdAt`, `updatedAt`, `bodyTruncated`, and (on merge/pull requests) `sourceBranch`, `targetBranch`, and `draft`; the body is capped at the configured byte limit and a capped read is flagged. Write actions perform a real mutation — the model should confirm with the user before calling them.

| Tool | `action` | Parameters |
|---|---|---|
| `gitlab_projects` | `list`, `create` | list: `search?`, `membership?`, `perPage?` · create: `name`, `description?`, `path?`, `visibility?` |
| `gitlab_file` | `read` | `project`, `path`, `ref?` |
| `gitlab_merge_requests` | `list`, `get`, `create`, `merge`, `close` | `project?`, `state?`, `perPage?`, `number`, `title`, `sourceBranch`, `targetBranch`, `body?` |
| `gitlab_issues` | `list`, `get`, `create`, `close`, `reopen`, `comment` | `project?`, `state?`, `perPage?`, `number`, `title`, `body?` |
| `github_repos` | `list`, `create` | list: `search?`, `perPage?` · create: `name`, `description?`, `private?` |
| `github_file` | `read` | `project` (owner/repo), `path`, `ref?` |
| `github_pull_requests` | `list`, `get`, `create`, `merge`, `close` | `project?`, `state?`, `perPage?`, `number`, `title`, `head`, `base`, `body?` |
| `github_issues` | `list`, `get`, `create`, `close`, `reopen`, `comment` | `project?`, `state?`, `perPage?`, `number`, `title`, `body?` |
| `gitee_repos` | `list`, `create` | list: `search?`, `perPage?` · create: `name`, `description?`, `private?` |
| `gitee_file` | `read` | `project` (owner/repo), `path`, `ref?` |
| `gitee_pull_requests` | `list`, `get`, `create`, `merge`, `close` | `project?`, `state?`, `perPage?`, `number`, `title`, `head`, `base`, `body?` |
| `gitee_issues` | `list`, `get`, `create`, `close`, `reopen`, `comment` | `project?`, `state?`, `perPage?`, `number`, `title`, `body?` |
| `gitea_repos` | `list`, `create` | list: `search?`, `perPage?` · create: `name`, `description?`, `private?` |
| `gitea_file` | `read` | `project` (owner/repo), `path`, `ref?` |
| `gitea_pull_requests` | `list`, `get`, `create`, `merge`, `close` | `project?`, `state?`, `perPage?`, `number`, `title`, `head`, `base`, `body?` |
| `gitea_issues` | `list`, `get`, `create`, `close`, `reopen`, `comment` | `project?`, `state?`, `perPage?`, `number`, `title`, `body?` |
| `gitlab_releases` | `list`, `create`, `delete` | `project?`, `perPage?`, `tag` (create requires; delete deletes by tag on GitLab), `name?`, `body?`, `draft?`, `prerelease?` |
| `github_releases` | `list`, `create`, `delete` | `project?`, `perPage?`, `tag`, `number` (release id, required for delete), `name?`, `body?`, `draft?`, `prerelease?` |
| `gitee_releases` | `list`, `create`, `delete` | `project?`, `perPage?`, `tag`, `number` (release id, required for delete), `name?`, `body?`, `draft?`, `prerelease?` |
| `gitea_releases` | `list`, `create`, `delete` | `project?`, `perPage?`, `tag`, `number` (release id, required for delete), `name?`, `body?`, `draft?`, `prerelease?` |
| `bitbucket_repos` | `list`, `create` | list: `search?`, `perPage?` · create: `name`, `description?`, `private?` |
| `bitbucket_file` | `read` | `project` (workspace/repo), `path`, `ref?` |
| `bitbucket_pull_requests` | `list`, `get`, `create`, `merge`, `close` | `project?`, `state?`, `perPage?`, `number`, `title`, `head`, `base`, `body?` |
| `bitbucket_issues` | `list`, `get`, `create`, `close`, `reopen`, `comment` | `project?`, `state?`, `perPage?`, `number`, `title`, `body?` |

- `action` defaults to the read operation (`list`, or `read` for file) — existing read callers keep working unchanged
- `number` is the issue/PR number (iid on GitLab); required for `get` / `close` / `reopen` / `comment` / `merge`
- `state` values: GitLab `opened`/`closed`/`all` (`merged` for MRs), the others `open`/`closed`/`all`
- `file` always reads: `project`, `path`, `ref?` (defaults to the repository default branch; content over the byte cap is truncated and flagged)
- `bitbucket_repos` create needs the site's `defaultProject` (`workspace/repo`) to know which workspace to create in
- Bitbucket has no releases API, so no `bitbucket_releases` tool; release delete uses the release `number` (GitLab deletes by `tag`)
- Token reference names are POSIX identifiers (`GITLAB_TOKEN`, `GITHUB_TOKEN`, `GITEE_TOKEN`, `GITEA_TOKEN`, `BITBUCKET_TOKEN`, …); multiple sites can share one reference or use their own
- GitLab authenticates with the `PRIVATE-TOKEN` header; GitHub, Gitee, and Bitbucket with `Authorization: Bearer` (Gitee additionally falls back to the `access_token` URL parameter when the header form is rejected); Gitea with `Authorization: token`
- HTTP goes through Node's built-in `fetch` directly — `ctx.web.fetch` is deliberately not used (URL-only, no header support)
## How it works

```
~/.dsh/git-credentials.json (AES-256-GCM encrypted: sites + token values)
  → tool execution decrypts one snapshot, filters sites by provider, resolves tokenRef
  → fetch(baseUrl/<provider api path>, { headers: { PRIVATE-TOKEN | Bearer | token } })
  → tool arguments/returns/errors carry only business data (site, project, path, …)
```

## Development

Prerequisites: a clone of [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness). The dev toolchain is harness-backed: point `DSH_REPO` at the checkout and put its `node_modules/.bin` on `PATH` (the harness's `@deepseek-ai/*` packages are private and resolve through its tsconfig paths).

The browser half targets the current client slot standard: the panel is a `settings.section` list entry whose component receives the composed section props, and the typecheck program pulls the slot contracts through type-only imports. Typecheck against the checkout you actually run — regenerate `tsconfig.json` after switching harness versions. A checkout that has not built its client face yet falls back to those packages' sources; if the report names errors inside `packages/.../src`, build the face first with `pnpm run build:lib:client` in the checkout and typecheck again.

**The panel brings its own controls.** `src/client/panel-css.ts` copies the control metrics, focus behavior, and list rhythm of the host pages the panel sits beside, renamed under a `dshgc-` prefix, and the only thing shared with the host is the `--dsw-*` theme tokens — so light and dark follow automatically. Harness Client packages (such as `@deepseek-ai/dsh-client-ui-primitives`) are deliberately **not** imported as modules: they change without notice, and a throwing component blanks the slot entry. `dsh.client.inject` entries only order activation and remain allowed.

**Harness compatibility is enforced from the manifest.** DSH reads this package's `peerDependencies` on `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` and refuses to apply the bundle layer unless every range matches the running harness version (prereleases included); a refused bundle contributes no tools and no settings page, and the harness reports the refused peers. The `@deepseek-ai/dsh-tools` range is deliberately wide — `>=0.1.7-rc.1 <1.0.0` — so that a harness bump inside the 0.x line never refuses the bundle on its own (harness packages version in lockstep with the product). A new harness release is therefore handled as: regenerate `tsconfig.json`, `pnpm typecheck`, `pnpm smoke`; touch the range only when one of those actually fails, and treat `<1.0.0` as the re-validation boundary. Verify a package against a checkout without installing it — the check itself takes only the manifest:

```sh
node --input-type=module -e "
import { readFileSync } from 'node:fs'
const { evaluatePluginCompatibility, pluginCompatibilityWarning } = await import('$DSH_REPO/packages/boot/app-boot/lib/index.js')
const manifest = JSON.parse(readFileSync('./package.json', 'utf8'))
const issue = evaluatePluginCompatibility(manifest)
console.log(issue === undefined ? 'compatible' : pluginCompatibilityWarning(issue))
"
```

```sh
export DSH_REPO=/path/to/deepseek-harness
export PATH="$DSH_REPO/node_modules/.bin:$PATH"

# Regenerate tsconfig.json paths for this checkout (gitignored — machine-specific)
pnpm gen:tsconfig

# Typecheck (including the browser half)
pnpm typecheck

# Keyless smoke: encrypted-store round-trip + boot assertions + loud failure
# for unconfigured tokens (no network, no model key)
DSH_REPO="$DSH_REPO" TSX_TSCONFIG_PATH="$DSH_REPO/tsconfig.json" \
  node --import "$DSH_REPO/node_modules/tsx/dist/esm/index.mjs" smoke.ts

# Rebuild the browser bundle after touching src/client/ (the live GUI hot-swaps it)
pnpm build
```

- **Composition/config layers** recombine via HMR immediately — no restart
- **Client bundle** is picked up by the webserver's stat-poll + client-hmr broadcast — rebuild and the browser hot-swaps it
- **Host plugin source** has no hot path (Node caches modules; the harness has no host-side watch) — and since the package entry is the built `lib/index.js`, host-side edits need a `pnpm build` before the restart; or rename the plugin directory so module URLs change and hot-swap zero-restart

`$DSH_REPO/node_modules/.bin/tsdown` is a shell shim — run it directly (as `pnpm build` does), not via `node .../.bin/tsdown`.

## Project structure

```
git-credentials/
  package.json            # dsh-git-credentials; peers: @deepseek-ai/{cordis,dsh-tools,dsh-schemastery}
                          # dsh.client manifest + exports["./client"] (browser half)
  cordis.patch.yml        # bundle patch layer (dsh.bundle.patch) — also the dev --patch overlay
  tsdown.config.ts        # self-contained build (node half + browser bundle, no harness checkout)
  smoke.ts                # keyless boot smoke (incl. encrypted-store round-trip assertions)
  tools/gen-tsconfig.mjs  # regenerates tsconfig.json paths for this checkout (DSH_REPO-driven)
  src/index.ts            # plugin entry: 24 tool registrations + admin route wiring
  src/store.ts            # AES-256-GCM encrypted storage (independent key, atomic write, 0600)
  src/http.ts             # shared HTTP helpers (token resolution, pagination, error detail)
  src/gitlab.ts           # GitLabClient (PRIVATE-TOKEN header)
  src/github.ts           # GitHubClient (Bearer header + User-Agent)
  src/gitee.ts            # GiteeClient (Bearer header, access_token URL fallback)
  src/gitea.ts            # GiteaClient (token header)
  src/bitbucket.ts        # BitbucketClient (Bearer header, 2.0 API)
  src/admin.ts            # /git-credentials-admin/* management endpoints
  src/client/             # browser half: the Settings → Git Credentials panel
  lib/                    # build output (node half + client bundle, gitignored)
  CHANGELOG.md            # per-version changes; the source of each release body
```

## Publishing

The package is shaped as a dsh **bundle**: `dsh.bundle.patch` points at `cordis.patch.yml`, so users install it with `dsh plugin --profile <name> add dsh-git-credentials` and it joins the profile's bundle layers. The runtime resolves the plugin's `@deepseek-ai/*` imports from the installation's flat fallback (`$DSH_HOME/profiles/node_modules`), so the peerDependencies declare the **published** version line (`@deepseek-ai/cordis ^4.0.1-rc.1`, `@deepseek-ai/dsh-tools >=0.1.7-rc.1 <1.0.0`, `@deepseek-ai/schemastery ^3.18.1-rc.1`) — never the dev-workspace `0.1.0-rc.5` versions. Harness packages version in lockstep with the product, and DSH admits a bundle only while those ranges match the running harness; the `dsh-tools` range deliberately spans the whole 0.x line, so a harness bump alone never forces a plugin release (see Development).

Two channels carry the same packed artifact:

- **npm** — `pnpm publish` ships the built package to the public registry; `publishConfig` pins `https://registry.npmjs.org/`, so a mirror configured in the local npm client cannot misroute the publish. `lib/` is gitignored but whitelisted in `files`, so **build first**:

  ```sh
  pnpm build
  pnpm publish
  ```

  Users then install with `dsh plugin --profile <name> add dsh-git-credentials`.
- **GitHub release** — pushing a `v*` tag triggers [GitHub Actions](.github/workflows/release.yml) to build the node half + browser bundle in the cloud, pack the tarball, and attach it to the release. The same pipeline, by hand:

  ```sh
  pnpm build
  pnpm pack                       # -> dsh-git-credentials-<version>.tgz
  ```

  Attach that tarball to the release, or install it directly:

  ```sh
  dsh plugin --profile <name> add ./dsh-git-credentials-<version>.tgz
  ```

**Release notes come from `CHANGELOG.md`.** Pushing a `v*` tag composes the release body from that file's section for the tag's version and appends the standard install footer (`.github/scripts/compose-release-notes.sh`); a version without a section falls back to GitHub's generated notes, so a release never blocks on a changelog omission. Before tagging, move the `[Unreleased]` items into a `## [<version>] - <date>` section in the version-bump commit, so the tagged tree carries the notes. Preview one body locally with `bash .github/scripts/compose-release-notes.sh <version>`.

To (re)compose the notes of a release that is already published — for example to backfill one that predates this pipeline — run the `release` workflow manually with its `version` input: it reads `CHANGELOG.md` from the default branch, rewrites the release body, and leaves the attached tarball untouched.

Verify the artifact locally before announcing it — `dsh plugin --profile <name> add <tarball|package>`, confirm `dsh --profile <name> --dump-config` shows the `# == dsh-git-credentials` layer, then boot the profile and check the 24 tools register.

## License

[MIT](LICENSE)
