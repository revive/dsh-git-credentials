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
dsh plugin --profile <name> add ./dsh-git-credentials-0.1.0.tgz
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

- **Add a site**: provider (GitLab / GitHub / Gitee / Gitea / Bitbucket), site id, API base URL (defaults per provider: `https://api.github.com`, `https://gitee.com/api/v5`, `https://api.bitbucket.org/2.0`; GitLab and Gitea are self-hosted and need their own address, e.g. `https://gitlab.example.com` / `https://gitea.example.com/api/v1`), token reference name (defaults to `GITLAB_TOKEN` / `GITHUB_TOKEN` / `GITEE_TOKEN` / `GITEA_TOKEN` / `BITBUCKET_TOKEN`), optional token value (write it with the dedicated **Save Token** button, or together with **Add Site**), optional default project
- **Each existing site**: read-only by default (provider, base URL, token ref, default project, configured state) with an **Edit** button; edit mode reveals the inputs plus **Save / Cancel**, and lets you store or clear the token value, or delete the site
- The panel talks to same-origin `/git-credentials-admin/*` JSON endpoints; token values never appear in any response
- All changes take effect immediately — every tool call reads a fresh decrypted snapshot

### Tools

| Tool | Arguments | Returns |
|---|---|---|
| `gitlab_projects` | `site?`, `search?`, `membership?`, `perPage?` | project summary array |
| `gitlab_file` | `site?`, `project`, `path`, `ref?` | `{ path, ref, content, truncated }` |
| `gitlab_merge_requests` | `site?`, `project?`, `state?`, `perPage?` | MR summary array |
| `gitlab_issues` | `site?`, `project?`, `state?`, `perPage?` | issue summary array |
| `github_repos` | `site?`, `search?`, `perPage?` | repository summary array |
| `github_file` | `site?`, `project` (owner/repo), `path`, `ref?` | `{ path, ref, content, truncated }` |
| `github_issues` | `site?`, `project?`, `state?`, `perPage?` | issue summary array (PRs excluded) |
| `github_pull_requests` | `site?`, `project?`, `state?`, `perPage?` | PR summary array |
| `gitee_repos` | `site?`, `search?`, `perPage?` | repository summary array |
| `gitee_file` | `site?`, `project` (owner/repo), `path`, `ref?` | `{ path, ref, content, truncated }` |
| `gitee_issues` | `site?`, `project?`, `state?`, `perPage?` | issue summary array |
| `gitee_pull_requests` | `site?`, `project?`, `state?`, `perPage?` | PR summary array |
| `gitea_repos` | `site?`, `search?`, `perPage?` | repository summary array |
| `gitea_file` | `site?`, `project` (owner/repo), `path`, `ref?` | `{ path, ref, content, truncated }` |
| `gitea_issues` | `site?`, `project?`, `state?`, `perPage?` | issue summary array |
| `gitea_pull_requests` | `site?`, `project?`, `state?`, `perPage?` | PR summary array |
| `bitbucket_repos` | `site?`, `search?`, `perPage?` | repository summary array |
| `bitbucket_file` | `site?`, `project` (workspace/repo), `path`, `ref?` | `{ path, ref, content, truncated }` |
| `bitbucket_issues` | `site?`, `project?`, `state?`, `perPage?` | issue summary array |
| `bitbucket_pull_requests` | `site?`, `project?`, `state?`, `perPage?` | PR summary array |

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
  tsdown.config.ts        # reuses the repo's clientBundle preset to build lib/
  smoke.ts                # keyless boot smoke (incl. encrypted-store round-trip assertions)
  tools/gen-tsconfig.mjs  # regenerates tsconfig.json paths for this checkout (DSH_REPO-driven)
  src/index.ts            # plugin entry: 8 tool registrations + admin route wiring
  src/store.ts            # AES-256-GCM encrypted storage (independent key, atomic write, 0600)
  src/http.ts             # shared HTTP helpers (token resolution, pagination, error detail)
  src/gitlab.ts           # GitLabClient (PRIVATE-TOKEN header)
  src/github.ts           # GitHubClient (Bearer header + User-Agent)
  src/gitee.ts            # GiteeClient (Bearer header, access_token URL fallback)
  src/gitea.ts            # GiteaClient (token header)
  src/bitbucket.ts        # BitbucketClient (Bearer header, 2.0 API)
  src/admin.ts            # /git-credentials-admin/* management endpoints
  src/invariant.ts        # invariant companion (out-of-tree rationale)
  src/client/             # browser half: the Settings → Git Credentials panel
  lib/                    # build output (node half + client bundle, gitignored)
```

## Publishing

The package is shaped as a dsh **bundle**: `dsh.bundle.patch` points at `cordis.patch.yml`, so users install it with `dsh plugin --profile <name> add dsh-git-credentials` and it joins the profile's bundle layers. The runtime resolves the plugin's `@deepseek-ai/*` imports from the installation's flat fallback (`$DSH_HOME/profiles/node_modules`), so the peerDependencies declare the **published** version line (`@deepseek-ai/cordis ^4.0.1-rc.1`, `@deepseek-ai/dsh-tools ^0.0.1-rc.1`, `@deepseek-ai/schemastery ^3.18.1-rc.1`) — never the dev-workspace `0.1.0-rc.5` versions.

**Every GitHub release attaches the packed tarball** — that is the current distribution channel (npm publication is pending account 2FA). A release is produced like this:

```sh
# Build the node half + browser bundle, then pack
DSH_REPO=/path/to/deepseek-harness pnpm build
pnpm pack                       # -> dsh-git-credentials-<version>.tgz
```

Attach the tarball to the release (or install it locally):

```sh
dsh plugin --profile <name> add ./dsh-git-credentials-<version>.tgz
```

Once an npm account is available, publish the same tarball contents with `npm publish --registry=https://registry.npmjs.org/`, and users switch to `dsh plugin add dsh-git-credentials`.

Verify a tarball locally before publishing: `dsh plugin --profile <name> add <tarball>`, confirm `dsh --profile <name> --dump-config` shows the `# == dsh-git-credentials` layer, then boot the profile and check the eight tools register.

## License

[MIT](LICENSE)
