# dsh-git-credentials

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4b32c3)](https://github.com/deepseek-ai/deepseek-harness)

[简体中文](README.zh-CN.md)

An out-of-tree plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that manages GitLab and GitHub API tokens so **token values never enter the model context**.

The model's tools carry only a token *reference name* (e.g. `GITLAB_TOKEN`); the value is decrypted from the plugin's own encrypted store at call time and appears only in the outgoing HTTP `Authorization` header. Changing a site or rotating a token takes effect on the very next call — no restart required.

## Features

- **Tokens stay out of the model context** — never in tool arguments, return values, or error messages; only business data (`site`, `project`, `path`, …) crosses the model boundary
- **Encrypted at rest** — AES-256-GCM encrypted data file with a separate 32-byte random key file (`0600`, atomic writes)
- **Per-provider tool scoping** — `gitlab_*` tools only see GitLab sites, `github_*` only GitHub sites; unconfigured sites/tokens fail loud with the valid values listed in the error
- **Web settings panel** — add, edit, and delete sites; store or clear token values; **no response ever carries a token value**, only configured state
- **Hot load/unload** — mounts and unmounts on a running GUI without restarting it
- **Instant effect** — each tool call reads a freshly decrypted snapshot, so edits and rotations apply immediately

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

> The browser half (`lib/client.js`) is a build artifact — after cloning, build it first (see [Development](#development)).

## Usage

Manage sites and tokens in **Settings → Git Credentials**:

- **Add a site**: provider (GitLab / GitHub), site id, API base URL (GitHub defaults to `https://api.github.com`), token reference name (defaults to `GITLAB_TOKEN` / `GITHUB_TOKEN`), optional token value (write it with the dedicated **Save Token** button, or together with **Add Site**), optional default project
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

- Token reference names are POSIX identifiers (`GITLAB_TOKEN`, `GITHUB_TOKEN`, `GITLAB_CORP_TOKEN`, …); multiple sites can share one reference or use their own
- GitLab authenticates with the `PRIVATE-TOKEN` header; GitHub with `Authorization: Bearer` (PAT and fine-grained tokens both work) plus the User-Agent GitHub requires
- HTTP goes through Node's built-in `fetch` directly — `ctx.web.fetch` is deliberately not used (URL-only, no header support)

## How it works

```
~/.dsh/git-credentials.json (AES-256-GCM encrypted: sites + token values)
  → tool execution decrypts one snapshot, filters sites by provider, resolves tokenRef
  → fetch(baseUrl/api/v4/... or api.github.com/..., { headers: { PRIVATE-TOKEN | Bearer } })
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
- **Host plugin source** has no hot path (Node caches modules; the harness has no host-side watch) — restart the process, or rename the plugin directory so module URLs change and hot-swap zero-restart

`$DSH_REPO/node_modules/.bin/tsdown` is a shell shim — run it directly (as `pnpm build` does), not via `node .../.bin/tsdown`.

## Project structure

```
git-credentials/
  package.json            # dsh-git-credentials; peers: @deepseek-ai/{cordis,dsh-tools,dsh-schemastery}
                          # dsh.client manifest + exports["./client"] (browser half)
  cordis.yml              # dev --patch overlay
  tsdown.config.ts        # reuses the repo's clientBundle preset to build lib/
  smoke.ts                # keyless boot smoke (incl. encrypted-store round-trip assertions)
  tools/gen-tsconfig.mjs  # regenerates tsconfig.json paths for this checkout (DSH_REPO-driven)
  src/index.ts            # plugin entry: 8 tool registrations + admin route wiring
  src/store.ts            # AES-256-GCM encrypted storage (independent key, atomic write, 0600)
  src/http.ts             # shared HTTP helpers (token resolution, pagination, error detail)
  src/gitlab.ts           # GitLabClient (PRIVATE-TOKEN header)
  src/github.ts           # GitHubClient (Bearer header + User-Agent)
  src/admin.ts            # /git-credentials-admin/* management endpoints
  src/invariant.ts        # invariant companion (out-of-tree rationale)
  src/client/             # browser half: the Settings → Git Credentials panel
  lib/                    # build output (node half + client bundle, gitignored)
```

## License

[MIT](LICENSE)
