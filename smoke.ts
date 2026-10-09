/**
 * Keyless boot smoke: composes the base bundle plus this plugin's patch over
 * an empty root, asserts the gitlab tools register, the encrypted store
 * round-trips (ciphertext on disk, no plaintext), and an unconfigured token
 * fails loud. No network calls and no model key are involved.
 *
 * Run from the plugin checkout (DSH_REPO points at the harness checkout;
 * the repo's own tsconfig drives tsx path resolution):
 *   DSH_REPO=/path/to/deepseek-harness \
 *     TSX_TSCONFIG_PATH="$DSH_REPO/tsconfig.json" \
 *     node --import "$DSH_REPO/node_modules/tsx/dist/esm/index.mjs" smoke.ts
 * @module git-credentials-smoke
 */

import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { GitLabClient } from './src/gitlab.ts'
import { GitHubClient } from './src/github.ts'
import { GiteeClient } from './src/gitee.ts'
import { GiteaClient } from './src/gitea.ts'
import { BitbucketClient } from './src/bitbucket.ts'
import { GitStore, normalizeState, type StoreState } from './src/store.ts'

// The harness checkout comes from the environment, never from a baked-in
// machine path. The plugin root is derived from this script's own location.
const REPO = process.env.DSH_REPO
if (!REPO) {
  throw new Error(
    'DSH_REPO must point at a deepseek-harness checkout, e.g. DSH_REPO=/path/to/deepseek-harness',
  )
}
const PLUGIN = fileURLToPath(new URL('.', import.meta.url))

/** Structural slice of the tool registry the smoke asserts against. */
interface ToolRegistry {
  get(name: string): {
    readonly name: string
    /** The model-facing argument JSON Schema (only the action enum is read here). */
    readonly parameters?: {
      readonly properties?: { readonly action?: { readonly enum?: readonly string[] } }
    }
    /** The output contract's model-facing projection (rendered for the get layout check). */
    readonly output?: {
      readonly render?: (args: unknown, value: unknown) =>
        ReadonlyArray<{ readonly type: string; readonly text: string }>
    }
  } | undefined
}

// Isolate the smoke from any live harness home (the running GUI shares ~/.dsh).
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'git-credentials-smoke-'))
// Mirror the real deployment: the root config lives under profiles/<name>,
// so the loader's parent walk finds the plugin through the profiles
// node_modules fallback, exactly as a profile boot would.
mkdirSync(join(process.env.DSH_HOME, 'profiles', 'node_modules'), { recursive: true })
symlinkSync(PLUGIN, join(process.env.DSH_HOME, 'profiles', 'node_modules', 'dsh-git-credentials'), 'dir')
const profileDir = join(process.env.DSH_HOME, 'profiles', 'smoke')
mkdirSync(profileDir, { recursive: true })
const rootConfig = join(profileDir, 'cordis.yml')
writeFileSync(rootConfig, '[]\n')

// The encrypted store round-trips through explicit paths inside the temp home.
const storeDir = join(process.env.DSH_HOME, 'store-test')
mkdirSync(storeDir, { recursive: true })
const dataPath = join(storeDir, 'data.json')
const keyPath = join(storeDir, 'key.bin')
const store = GitStore.create({ dataPath, keyPath })
store.write({
  defaultSite: 'corp',
  sites: {
    corp: { provider: 'gitlab', baseUrl: 'https://gitlab.example.com' },
    gh: { provider: 'github', baseUrl: 'https://api.github.com' },
    ge: { provider: 'gitee', baseUrl: 'https://gitee.com/api/v5' },
  },
  tokens: {
    corp: 'glpat-smoke-secret',
    gh: 'ghp-smoke-secret',
    ge: 'gitee-smoke-secret',
  },
})
const roundTrip = store.read()
if (roundTrip.sites.corp?.provider !== 'gitlab' || roundTrip.sites.gh?.provider !== 'github'
  || roundTrip.sites.ge?.provider !== 'gitee'
  || roundTrip.tokens.gh !== 'ghp-smoke-secret'
  || roundTrip.tokens.ge !== 'gitee-smoke-secret') {
  throw new Error(`store round-trip mismatch: ${JSON.stringify(roundTrip)}`)
}
const onDisk = readFileSync(dataPath, 'utf8')
if (onDisk.includes('glpat-smoke-secret') || onDisk.includes('gitlab.example.com')) {
  throw new Error('store data file contains plaintext')
}
if (!onDisk.includes('"cipher":"aes-256-gcm"')) {
  throw new Error('store data file is not the encrypted envelope')
}
console.log('ok: encrypted store round-trips with ciphertext at rest')

// A document written before sites owned their tokens migrates on read: the
// referenced value lands on the site id, `tokenRef` disappears, and a reference
// that no site used is not carried over.
const legacyDir = join(process.env.DSH_HOME, 'store-legacy')
mkdirSync(legacyDir, { recursive: true })
const legacy = GitStore.create({ dataPath: join(legacyDir, 'data.json'), keyPath: join(legacyDir, 'key.bin') })
const legacyDocument: Record<string, unknown> = {
  defaultSite: 'corp',
  sites: { corp: { provider: 'gitlab', baseUrl: 'https://gitlab.example.com', tokenRef: 'GITLAB_TOKEN' } },
  tokens: { GITLAB_TOKEN: 'glpat-legacy', ORPHAN_TOKEN: 'orphan-secret' },
}
legacy.write(legacyDocument as unknown as StoreState)
const migrated = legacy.read()
if (migrated.sites.corp === undefined || 'tokenRef' in migrated.sites.corp
  || migrated.tokens.corp !== 'glpat-legacy') {
  throw new Error(`legacy store was not migrated: ${JSON.stringify(migrated)}`)
}
if ('GITLAB_TOKEN' in migrated.tokens || 'ORPHAN_TOKEN' in migrated.tokens) {
  throw new Error(`legacy reference keys survived migration: ${JSON.stringify(migrated.tokens)}`)
}
if (normalizeState({ sites: {}, tokens: {} }).tokens['anything'] !== undefined) {
  throw new Error('normalizeState invented a token')
}
console.log('ok: a legacy tokenRef document migrates to one token per site')

const ctx = await boot('gitlab-smoke', rootConfig, [
  ...loadOverlayPatches('gitlab-smoke', join(REPO, 'packages/bundle/base/cordis.patch.yml')),
  ...loadOverlayPatches('gitlab-smoke', join(PLUGIN, 'cordis.patch.yml')),
])

try {
  const tools = ctx.get('tools') as ToolRegistry | undefined
  if (tools === undefined) throw new Error('tools service is not registered')
  for (const name of [
    'gitlab_projects', 'gitlab_file', 'gitlab_merge_requests', 'gitlab_issues',
    'github_repos', 'github_file', 'github_issues', 'github_pull_requests',
    'gitee_repos', 'gitee_file', 'gitee_issues', 'gitee_pull_requests',
    'gitea_repos', 'gitea_file', 'gitea_issues', 'gitea_pull_requests',
    'bitbucket_repos', 'bitbucket_file', 'bitbucket_issues', 'bitbucket_pull_requests',
  ]) {
    if (tools.get(name) === undefined) throw new Error(`tool ${name} is not registered`)
    console.log(`ok: ${name} registered`)
  }

  // The read action must reach the model: every issues / merge-request /
  // pull-request tool advertises "get" in its action enum.
  for (const name of [
    'gitlab_issues', 'gitlab_merge_requests',
    'github_issues', 'github_pull_requests',
    'gitee_issues', 'gitee_pull_requests',
    'gitea_issues', 'gitea_pull_requests',
    'bitbucket_issues', 'bitbucket_pull_requests',
  ]) {
    const actions = tools.get(name)?.parameters?.properties?.action?.enum ?? []
    if (!actions.includes('get')) {
      throw new Error(`tool ${name} does not expose the "get" action (enum: ${JSON.stringify(actions)})`)
    }
    console.log(`ok: ${name} exposes the get action`)
  }

  // The get read must render as ONE newline-separated block: the result
  // pipeline concatenates separate content blocks without a separator, which
  // ran the title into the author line before.
  {
    const detail = {
      number: 7,
      title: 'Sample issue',
      state: 'open',
      webUrl: 'https://example.test/i/7',
      authorName: 'octocat',
      body: 'First line\nSecond line',
      labels: ['bug', 'docs'],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      bodyTruncated: true,
    }
    const rendered = tools.get('github_issues')?.output?.render?.({ action: 'get' }, [detail]) ?? []
    if (rendered.length !== 1) {
      throw new Error(`the get renderer must emit one content block, got ${rendered.length}`)
    }
    const expected = [
      '#7 [open] Sample issue',
      'octocat — labels: bug, docs — created 2026-01-01T00:00:00Z — updated 2026-01-02T00:00:00Z — https://example.test/i/7',
      'First line',
      'Second line',
      '(description truncated — full text at https://example.test/i/7)',
    ].join('\n')
    if (rendered[0]?.text !== expected) {
      throw new Error(`unexpected get rendering:\n${JSON.stringify(rendered[0]?.text)}\nexpected:\n${JSON.stringify(expected)}`)
    }
    console.log('ok: the get renderer emits one newline-separated block')
  }

  // The forge surface contract: every client must expose every method the
  // tool factory dispatches to — a missing method would otherwise surface at
  // call time as "X is not a function" instead of failing the smoke.
  const SURFACE = [
    'listRepos', 'readFile', 'listIssues', 'listPullRequests', 'getIssue', 'getPull',
    'createRepo', 'createIssue', 'createPullRequest',
    'closeIssue', 'reopenIssue', 'commentIssue', 'mergePull', 'closePull',
  ] as const
  // Bitbucket has no releases API, so it is exempt from the release methods.
  const RELEASE_SURFACE = ['listReleases', 'createRelease', 'deleteRelease'] as const
  // The constructors take (tokens, site); `new (...args: never[]) => object`
  // is the argument-agnostic constructor shape the probe (Object.create over
  // the prototype) only needs.
  const surfaces: Array<{ ctor: new (...args: never[]) => object; methods: readonly string[] }> = [
    { ctor: GitLabClient, methods: [...SURFACE, ...RELEASE_SURFACE] },
    { ctor: GitHubClient, methods: [...SURFACE, ...RELEASE_SURFACE] },
    { ctor: GiteeClient, methods: [...SURFACE, ...RELEASE_SURFACE] },
    { ctor: GiteaClient, methods: [...SURFACE, ...RELEASE_SURFACE] },
    { ctor: BitbucketClient, methods: SURFACE },
  ]
  for (const { ctor, methods } of surfaces) {
    const probe = Object.create(ctor.prototype) as Record<string, unknown>
    for (const method of methods) {
      if (typeof probe[method] !== 'function') {
        throw new Error(`${ctor.name} is missing the forge-surface method ${method}`)
      }
    }
    console.log(`ok: ${ctor.name} implements the forge surface`)
  }

  // Fail-loud without a configured token: the model must get a clear error,
  // never a crash and never a network call.
  const bare = new GitLabClient({}, {
    id: 'smoke',
    baseUrl: 'https://gitlab.example.com',
  })
  let failed = false
  try {
    await bare.listRepos({})
  } catch (error) {
    failed = true
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('smoke') || !message.includes('no token is configured')) {
      throw new Error(`unexpected failure text: ${message}`)
    }
  }
  if (!failed) throw new Error('listRepos must fail loud without a configured token')
  console.log('ok: unconfigured token fails loud with a clear message')

  console.log('SMOKE OK')
} finally {
  await ctx.fiber.dispose()
}
