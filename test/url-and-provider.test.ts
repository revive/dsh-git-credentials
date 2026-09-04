/**
 * Regression tests for two real bugs found against a self-hosted Forgejo
 * instance: (1) a stale provider whitelist rejecting valid adapters, and
 * (2) request URLs silently dropping a self-hosted API subpath (e.g.
 * `/api/v1`) because of how the WHATWG URL constructor resolves a
 * leading-slash relative reference against a base URL that has its own path.
 * @module git-credentials-url-provider-test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSite } from '../src/admin.ts'
import { GiteaClient } from '../src/gitea.ts'
import { GitHubClient } from '../src/github.ts'
import { GitLabClient } from '../src/gitlab.ts'
import { GiteeClient } from '../src/gitee.ts'
import { BitbucketClient } from '../src/bitbucket.ts'
import { refOf } from '../src/store.ts'

/**
 * Capture the URL fetch was called with, without making a network request.
 * `body` is the empty-page shape the target client's `listRepos` expects
 * (a bare array for most providers, `{ values: [] }` for Bitbucket).
 */
function captureFetchUrl(body: unknown = []): { readonly urls: string[] } {
  const state = { urls: [] as string[] }
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    state.urls.push(input instanceof URL ? input.toString() : String(input))
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  return state
}

test('site validation accepts "gitea" as a provider', () => {
  const result = parseSite({
    id: 'self-hosted',
    site: { baseUrl: 'https://git.example.com/api/v1', provider: 'gitea' },
  })
  assert.equal(typeof result, 'object', `expected a parsed site, got: ${result}`)
})

test('site validation accepts "gitee" and "bitbucket" as providers', () => {
  for (const provider of ['gitee', 'bitbucket']) {
    const result = parseSite({ id: 'x', site: { baseUrl: 'https://example.com', provider } })
    assert.equal(typeof result, 'object', `provider "${provider}" should be accepted, got: ${result}`)
  }
})

test('site validation still rejects an unknown provider', () => {
  const result = parseSite({ id: 'x', site: { baseUrl: 'https://example.com', provider: 'sourcehut' } })
  assert.equal(typeof result, 'string')
})

test('Gitea client preserves a self-hosted baseUrl subpath (e.g. /api/v1) in request URLs', async () => {
  const state = captureFetchUrl()
  const client = new GiteaClient(
    { GITEA_TOKEN: 't' },
    { id: 'self-hosted', baseUrl: 'https://git.example.com/api/v1', tokenRef: refOf('GITEA_TOKEN') },
  )
  await client.listRepos({})
  assert.equal(state.urls.length, 1)
  assert.ok(
    state.urls[0].startsWith('https://git.example.com/api/v1/user/repos'),
    `expected the /api/v1 subpath to survive, got: ${state.urls[0]}`,
  )
})

test('GitHub, GitLab, Gitee, and Bitbucket clients also preserve a baseUrl subpath', async () => {
  const cases: Array<{ readonly name: string; readonly body?: unknown; readonly run: () => Promise<void> }> = [
    {
      name: 'github',
      run: async () => {
        const client = new GitHubClient(
          { GITHUB_TOKEN: 't' },
          { id: 's', baseUrl: 'https://git.example.com/api/v3', tokenRef: refOf('GITHUB_TOKEN') },
        )
        await client.listRepos({})
      },
    },
    {
      name: 'gitlab',
      run: async () => {
        const client = new GitLabClient(
          { GITLAB_TOKEN: 't' },
          { id: 's', baseUrl: 'https://git.example.com/gitlab', tokenRef: refOf('GITLAB_TOKEN') },
        )
        await client.listRepos({})
      },
    },
    {
      name: 'gitee',
      run: async () => {
        const client = new GiteeClient(
          { GITEE_TOKEN: 't' },
          { id: 's', baseUrl: 'https://git.example.com/api/v5', tokenRef: refOf('GITEE_TOKEN') },
        )
        await client.listRepos({})
      },
    },
    {
      name: 'bitbucket',
      body: { values: [] },
      run: async () => {
        const client = new BitbucketClient(
          { BITBUCKET_TOKEN: 't' },
          { id: 's', baseUrl: 'https://git.example.com/api/2.0', tokenRef: refOf('BITBUCKET_TOKEN') },
        )
        await client.listRepos({})
      },
    },
  ]
  for (const { name, body, run } of cases) {
    const state = captureFetchUrl(body)
    await run()
    assert.equal(state.urls.length, 1, `${name}: expected exactly one request`)
    assert.ok(
      new URL(state.urls[0]).pathname.length > 1 && state.urls[0].includes('/api/') || state.urls[0].includes('/gitlab/'),
      `${name}: expected the baseUrl subpath to survive, got: ${state.urls[0]}`,
    )
  }
})
