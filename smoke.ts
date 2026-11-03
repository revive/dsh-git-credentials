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
import { TOKEN_SCOPES, tokenUrlFor } from './src/client/site-model.ts'

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
    /** The model-facing argument JSON Schema (the action enum and the create parameters are read here). */
    readonly parameters?: {
      readonly properties?: Record<string, {
        readonly type?: string
        readonly enum?: readonly string[]
        readonly oneOf?: readonly unknown[]
      }>
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

  // Comments are a first-class action on both resources: issues can list
  // comments, pull/merge requests can list and create them.
  for (const name of [
    'gitlab_issues', 'github_issues', 'gitee_issues', 'gitea_issues', 'bitbucket_issues',
  ]) {
    const actions = tools.get(name)?.parameters?.properties?.action?.enum ?? []
    if (!actions.includes('comments')) throw new Error(`${name} does not expose the comments action`)
  }
  for (const name of [
    'gitlab_merge_requests', 'github_pull_requests', 'gitee_pull_requests', 'gitea_pull_requests', 'bitbucket_pull_requests',
  ]) {
    const actions = tools.get(name)?.parameters?.properties?.action?.enum ?? []
    if (!actions.includes('comment') || !actions.includes('comments')) {
      throw new Error(`${name} does not expose the comment/comments actions`)
    }
  }
  console.log('ok: issues can list comments and pull/merge requests can list and create them')

  // A namespace only GitLab's create takes: the GitLab tool must advertise it,
  // and the other providers' repo tools must not inherit a GitLab-only knob.
  {
    const gitlabProps = tools.get('gitlab_projects')?.parameters?.properties ?? {}
    if (!('namespace' in gitlabProps)) {
      throw new Error('gitlab_projects does not advertise the namespace create parameter')
    }
    for (const name of ['github_repos', 'gitee_repos', 'gitea_repos', 'bitbucket_repos']) {
      if ('namespace' in (tools.get(name)?.parameters?.properties ?? {})) {
        throw new Error(`${name} must not advertise GitLab's namespace parameter`)
      }
    }
    console.log('ok: namespace is a GitLab-only create parameter')
  }

  // Gitee issue ids are strings: the tool must accept one, while the other
  // providers keep the integer-only contract.
  {
    const giteeNumber = (tools.get('gitee_issues')?.parameters?.properties ?? {}).number
    if (giteeNumber?.oneOf === undefined) {
      throw new Error('gitee_issues does not accept string issue ids')
    }
    for (const name of ['github_issues', 'gitea_issues', 'bitbucket_issues', 'gitlab_issues']) {
      if ((tools.get(name)?.parameters?.properties ?? {}).number?.oneOf !== undefined) {
        throw new Error(`${name} must keep the integer-only number argument`)
      }
    }
    console.log('ok: only Gitee accepts string issue ids')
  }

  // The token help links are local strings derived from provider + base URL.
  // A URL that cannot be parsed must hide the link instead of pointing at the
  // wrong host, and every provider must state its minimum permissions.
  {
    const gitlabLink = 'https://gitlab.example.com/-/user_settings/personal_access_tokens?name=dsh-git-credentials&scopes=api'
    if (tokenUrlFor('gitlab', 'https://gitlab.example.com/api/v4') !== gitlabLink) {
      throw new Error(`unexpected GitLab token link for an API root: ${tokenUrlFor('gitlab', 'https://gitlab.example.com/api/v4')}`)
    }
    if (tokenUrlFor('gitlab', 'https://gitlab.example.com') !== gitlabLink) {
      throw new Error('a bare GitLab host must produce the same token link as its /api/v4 root')
    }
    if (tokenUrlFor('gitlab', 'https://example.com/gitlab/api/v4')
      !== 'https://example.com/gitlab/-/user_settings/personal_access_tokens?name=dsh-git-credentials&scopes=api') {
      throw new Error('a GitLab deployment sub-path must survive into the token link')
    }
    if (tokenUrlFor('gitea', 'https://gitea.example.com/api/v1/') !== 'https://gitea.example.com/user/settings/applications') {
      throw new Error(`unexpected Gitea token link: ${tokenUrlFor('gitea', 'https://gitea.example.com/api/v1/')}`)
    }
    if (tokenUrlFor('github', '') !== 'https://github.com/settings/personal-access-tokens/new?name=dsh-git-credentials') {
      throw new Error(`unexpected GitHub token link: ${tokenUrlFor('github', '')}`)
    }
    if (tokenUrlFor('gitee', '') !== 'https://gitee.com/profile/personal_access_tokens'
      || tokenUrlFor('bitbucket', '') !== 'https://bitbucket.org/account/settings/app-passwords/') {
      throw new Error('the fixed Gitee/Bitbucket token links changed')
    }
    for (const [provider, baseUrl] of [
      ['gitlab', ''],
      ['gitlab', 'not a url'],
      ['gitlab', 'javascript:alert(1)'],
      ['gitea', 'ftp://gitea.example.com/api/v1'],
    ] as const) {
      if (tokenUrlFor(provider, baseUrl) !== undefined) {
        throw new Error(`a token link must be hidden for ${provider} with base URL ${JSON.stringify(baseUrl)}`)
      }
    }
    for (const provider of ['github', 'gitlab', 'gitee', 'gitea', 'bitbucket'] as const) {
      if (TOKEN_SCOPES[provider] === undefined) {
        throw new Error(`provider ${provider} must advertise its minimum token permissions`)
      }
    }
    console.log('ok: token help links derive from the provider and base URL')
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
    'closeIssue', 'reopenIssue', 'commentIssue', 'commentPull',
    'listIssueComments', 'listPullComments', 'mergePull', 'closePull',
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

  // GitLab's create takes a numeric namespace_id, so a group path must be
  // looked up first and the POST must carry the resolved id. The stub below
  // keeps this keyless and network-free while exercising both requests.
  {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({
        url,
        method: init?.method ?? 'GET',
        ...init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as Record<string, unknown> },
      })
      const payload = url.includes('/api/v4/groups/')
        ? { id: 42, full_path: 'pandax' }
        : {
          id: 7,
          path: 'pandax-site',
          path_with_namespace: 'pandax/pandax-site',
          name: 'pandax-site',
          web_url: 'https://gitlab.example.com/pandax/pandax-site',
          visibility: 'private',
        }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const client = new GitLabClient({ corp: 'glpat-x' }, {
        id: 'corp',
        baseUrl: 'https://gitlab.example.com',
      })
      const created = await client.createRepo({ name: 'pandax-site', namespace: 'pandax', visibility: 'private' })
      const lookup = calls[0]
      const create = calls[1]
      if (lookup === undefined || lookup.method !== 'GET' || !lookup.url.endsWith('/api/v4/groups/pandax')) {
        throw new Error(`namespace lookup did not target the group endpoint: ${JSON.stringify(calls)}`)
      }
      if (create === undefined || create.method !== 'POST' || create.body?.namespace_id !== 42) {
        throw new Error(`create did not carry the resolved namespace_id: ${JSON.stringify(calls)}`)
      }
      if (created.path !== 'pandax/pandax-site') {
        throw new Error(`created project did not report its full path: ${JSON.stringify(created)}`)
      }
      calls.length = 0
      await client.createRepo({ name: 'mine' })
      if (calls.length !== 1 || calls[0]?.body?.namespace_id !== undefined) {
        throw new Error(`a create without namespace must not resolve or send one: ${JSON.stringify(calls)}`)
      }
      console.log('ok: a GitLab namespace resolves to namespace_id before create')
    } finally {
      globalThis.fetch = realFetch
    }
  }

  // Gitee keeps its API version in the base URL, creates and updates issues at
  // the owner level with the repo in the body, and uses string issue ids. The
  // stub pins every one of those request shapes without touching the network.
  {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
    const realFetch = globalThis.fetch
    let state = 'open'
    const issue = (): Record<string, unknown> => ({
      number: 'IKRZSO',
      title: 'Gitee issue',
      state,
      html_url: 'https://gitee.com/acme/repo/issues/IKRZSO',
      body: 'Body',
      labels: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      user: { login: 'octocat' },
    })
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = init?.method ?? 'GET'
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>
      calls.push({ url, method, ...body === undefined ? {} : { body } })
      let payload: unknown
      if (url.includes('/user/repos')) {
        payload = []
      } else if (url.includes('/comments')) {
        payload = { id: 1, user: { login: 'octocat' } }
      } else if (method === 'PATCH') {
        state = String(body?.state ?? state)
        payload = issue()
      } else if (method === 'POST') {
        payload = issue()
      } else if (new URL(url).pathname.endsWith('/issues')) {
        payload = [issue()]
      } else {
        payload = issue()
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const client = new GiteeClient({ gitee: 'token-x' }, {
        id: 'gitee',
        baseUrl: 'https://gitee.com/api/v5',
      })

      await client.listRepos({ perPage: 1 })
      if (!(calls[0]?.url.startsWith('https://gitee.com/api/v5/user/repos'))) {
        throw new Error(`Gitee dropped the /api/v5 prefix: ${calls[0]?.url}`)
      }

      calls.length = 0
      await client.listIssues({ project: 'acme/repo', state: 'all' })
      if (!(calls[0]?.url.includes('state=all'))) {
        throw new Error(`Gitee list with state "all" omitted the state: ${calls[0]?.url}`)
      }
      calls.length = 0
      await client.listIssues({ project: 'acme/repo' })
      if (!(calls[0]?.url.includes('state=open'))) {
        throw new Error(`Gitee list without a state must send "open": ${calls[0]?.url}`)
      }

      calls.length = 0
      const created = await client.createIssue({ project: 'acme/repo', title: 'Title', body: 'Body' })
      const create = calls[0]
      if (create?.method !== 'POST' || !create.url.endsWith('/api/v5/repos/acme/issues')
        || create.body?.repo !== 'repo' || create.body?.title !== 'Title' || create.body?.body !== 'Body') {
        throw new Error(`Gitee create did not use the owner-level endpoint: ${JSON.stringify(calls)}`)
      }
      if (created.number !== 'IKRZSO') {
        throw new Error(`Gitee create lost the string issue id: ${JSON.stringify(created)}`)
      }

      calls.length = 0
      const detail = await client.getIssue({ project: 'acme/repo', number: 'IKRZSO', maxBytes: 1024 })
      if (detail.number !== 'IKRZSO' || !(calls[0]?.url.endsWith('/repos/acme/repo/issues/IKRZSO'))) {
        throw new Error(`Gitee get did not accept the string id: ${JSON.stringify(calls)}`)
      }

      calls.length = 0
      const closed = await client.closeIssue({ project: 'acme/repo', number: 'IKRZSO' })
      const patch = calls.find(call => call.method === 'PATCH')
      if (patch === undefined || !patch.url.endsWith('/api/v5/repos/acme/issues/IKRZSO')
        || patch.body?.repo !== 'repo' || patch.body?.title !== 'Gitee issue' || patch.body?.state !== 'closed') {
        throw new Error(`Gitee close did not echo repo/title: ${JSON.stringify(calls)}`)
      }
      if (closed.state !== 'closed') throw new Error(`Gitee close did not report the new state: ${JSON.stringify(closed)}`)
      if (calls.filter(call => call.method === 'GET').length !== 2) {
        throw new Error(`Gitee close must read the current issue and re-read the result: ${JSON.stringify(calls)}`)
      }

      calls.length = 0
      const reopened = await client.reopenIssue({ project: 'acme/repo', number: 'IKRZSO' })
      if (reopened.state !== 'open') throw new Error(`Gitee reopen did not report the new state: ${JSON.stringify(reopened)}`)

      calls.length = 0
      const comment = await client.commentIssue({ project: 'acme/repo', number: 'IKRZSO', body: 'hi', maxBytes: 1024 })
      if (comment.webUrl !== '') {
        throw new Error(`Gitee comment without html_url must report an empty webUrl: ${JSON.stringify(comment)}`)
      }
      console.log('ok: Gitee preserves /api/v5 and uses owner-level issue writes with string ids')
    } finally {
      globalThis.fetch = realFetch
    }
  }


  // Comments across providers: each client's list/create path, canonical
  // mapping, and the base-path join that Gitee/Gitea/Bitbucket need.
  {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
    const realFetch = globalThis.fetch
    const comment = {
      id: 11,
      body: 'Hello',
      user: { login: 'octocat' },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      html_url: 'https://github.com/o/r/issues/7#issuecomment-11',
    }
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = init?.method ?? 'GET'
      calls.push({
        url,
        method,
        ...init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as Record<string, unknown> },
      })
      return new Response(JSON.stringify(method === 'POST' ? comment : [comment]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const client = new GitHubClient({ gh: 'x' }, { id: 'gh', baseUrl: 'https://api.github.com' })
      const comments = await client.listIssueComments({ project: 'o/r', number: 7, maxBytes: 1024 })
      if (calls[0]?.url !== 'https://api.github.com/repos/o/r/issues/7/comments?per_page=20') {
        throw new Error(`unexpected GitHub comment list URL: ${calls[0]?.url}`)
      }
      if (comments[0]?.authorName !== 'octocat' || comments[0]?.webUrl === '') {
        throw new Error(`GitHub comment mapping failed: ${JSON.stringify(comments)}`)
      }
      const created = await client.commentPull({ project: 'o/r', number: 7, body: 'Hello', maxBytes: 1024 })
      if (calls[1]?.method !== 'POST' || calls[1]?.body?.body !== 'Hello' || created.id !== 11) {
        throw new Error(`GitHub comment create failed: ${JSON.stringify(calls)}`)
      }
      console.log('ok: GitHub comments list/create')
    } finally {
      globalThis.fetch = realFetch
    }
  }

  {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
    const realFetch = globalThis.fetch
    const notes = [
      { id: 1, body: 'Human note', author: { name: 'Alice' }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', system: false },
      { id: 2, body: 'changed state', author: { name: 'Bot' }, created_at: '2026-01-03T00:00:00Z', updated_at: '2026-01-03T00:00:00Z', system: true },
    ]
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = init?.method ?? 'GET'
      calls.push({
        url,
        method,
        ...init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as Record<string, unknown> },
      })
      return new Response(JSON.stringify(method === 'POST' ? notes[0] : notes), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const client = new GitLabClient({ gl: 'x' }, { id: 'gl', baseUrl: 'https://gitlab.example.com' })
      const comments = await client.listIssueComments({ project: 'group/proj', number: 5, maxBytes: 1024 })
      if (comments.length !== 1 || comments[0]?.authorName !== 'Alice'
        || comments[0]?.webUrl !== 'https://gitlab.example.com/group/proj/-/issues/5#note_1') {
        throw new Error(`GitLab note mapping failed: ${JSON.stringify(comments)}`)
      }
      if (!(calls[0]?.url.endsWith('/api/v4/projects/group%2Fproj/issues/5/notes?per_page=20'))) {
        throw new Error(`unexpected GitLab note list URL: ${calls[0]?.url}`)
      }
      await client.commentPull({ project: 'group/proj', number: 3, body: 'LGTM', maxBytes: 1024 })
      if (calls[1]?.method !== 'POST' || !calls[1]?.url.endsWith('/api/v4/projects/group%2Fproj/merge_requests/3/notes')) {
        throw new Error(`unexpected GitLab merge-request note URL: ${JSON.stringify(calls[1])}`)
      }
      console.log('ok: GitLab notes list/create, system notes filtered')
    } finally {
      globalThis.fetch = realFetch
    }
  }

  {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
    const realFetch = globalThis.fetch
    const comment = {
      id: 3,
      body: 'Gitea comment',
      user: { login: 'gitea-user' },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      html_url: 'https://gitea.example.com/o/r/issues/3#issuecomment-3',
    }
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = init?.method ?? 'GET'
      calls.push({
        url,
        method,
        ...init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as Record<string, unknown> },
      })
      return new Response(JSON.stringify(method === 'POST' ? comment : [comment]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const client = new GiteaClient({ gt: 'x' }, { id: 'gt', baseUrl: 'https://gitea.example.com/api/v1' })
      const comments = await client.listPullComments({ project: 'o/r', number: 3, maxBytes: 1024 })
      if (!(calls[0]?.url.startsWith('https://gitea.example.com/api/v1/repos/o/r/issues/3/comments'))) {
        throw new Error(`Gitea dropped its API base path: ${calls[0]?.url}`)
      }
      if (comments[0]?.authorName !== 'gitea-user') throw new Error('Gitea comment mapping failed')
      await client.commentPull({ project: 'o/r', number: 3, body: 'hi', maxBytes: 1024 })
      if (calls[1]?.method !== 'POST' || !calls[1]?.url.startsWith('https://gitea.example.com/api/v1/repos/o/r/issues/3/comments')) {
        throw new Error(`Gitea comment create URL: ${JSON.stringify(calls[1])}`)
      }
      console.log('ok: Gitea comments keep /api/v1')
    } finally {
      globalThis.fetch = realFetch
    }
  }

  {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
    const realFetch = globalThis.fetch
    const comment = {
      id: 5,
      content: { raw: 'Bitbucket comment' },
      user: { display_name: 'Bob' },
      created_on: '2026-01-01T00:00:00Z',
      updated_on: '2026-01-02T00:00:00Z',
      links: { html: { href: 'https://bitbucket.org/ws/repo/pullrequests/4#comment-5' } },
    }
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = init?.method ?? 'GET'
      calls.push({
        url,
        method,
        ...init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as Record<string, unknown> },
      })
      const payload = method === 'POST' ? comment : { values: [comment] }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const client = new BitbucketClient({ bb: 'x' }, { id: 'bb', baseUrl: 'https://api.bitbucket.org/2.0' })
      const comments = await client.listPullComments({ project: 'ws/repo', number: 4, maxBytes: 1024 })
      if (calls[0]?.url !== 'https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/4/comments?pagelen=20') {
        throw new Error(`Bitbucket dropped /2.0: ${calls[0]?.url}`)
      }
      if (comments[0]?.authorName !== 'Bob' || comments[0]?.webUrl === '') {
        throw new Error(`Bitbucket comment mapping failed: ${JSON.stringify(comments)}`)
      }
      await client.commentIssue({ project: 'ws/repo', number: 4, body: 'hi', maxBytes: 1024 })
      if (calls[1]?.method !== 'POST' || (calls[1]?.body?.content as { raw?: string } | undefined)?.raw !== 'hi') {
        throw new Error(`Bitbucket comment create body: ${JSON.stringify(calls[1])}`)
      }
      console.log('ok: Bitbucket comments keep /2.0')
    } finally {
      globalThis.fetch = realFetch
    }
  }

  {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
    const realFetch = globalThis.fetch
    const created = { id: '9', body: 'hi' }
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = init?.method ?? 'GET'
      calls.push({
        url,
        method,
        ...init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as Record<string, unknown> },
      })
      const payload = method === 'POST'
        ? created
        : [{ id: 9, body: 'hi', user: { login: 'gitee-user' }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }]
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const client = new GiteeClient({ gitee: 'x' }, { id: 'gitee', baseUrl: 'https://gitee.com/api/v5' })
      const comment = await client.commentPull({ project: 'o/r', number: 4, body: 'hi', maxBytes: 1024 })
      if (calls[0]?.method !== 'POST' || !calls[0]?.url.endsWith('/api/v5/repos/o/r/pulls/4/comments')) {
        throw new Error(`Gitee PR comment URL: ${JSON.stringify(calls[0])}`)
      }
      if (comment.authorName !== 'gitee-user') {
        throw new Error(`Gitee sparse comment response was not re-read: ${JSON.stringify(comment)}`)
      }
      if (calls[1]?.method !== 'GET' || !calls[1]?.url.startsWith('https://gitee.com/api/v5/repos/o/r/pulls/4/comments')) {
        throw new Error(`Gitee comment re-read URL: ${JSON.stringify(calls[1])}`)
      }
      console.log('ok: Gitee PR comments re-read a sparse create response')
    } finally {
      globalThis.fetch = realFetch
    }
  }

  console.log('SMOKE OK')
} finally {
  await ctx.fiber.dispose()
}
