/**
 * Regression test for Bug B: Forgejo is a hard fork of Gitea and
 * wire-compatible with it, so a "forgejo" site should be selectable in the
 * dropdown/site validation and resolve to the GiteaClient adapter under the
 * hood — no separate adapter needed.
 * @module git-credentials-forgejo-alias-test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSite } from '../src/admin.ts'
import { adapterFor, refOf } from '../src/store.ts'
import { GiteaClient } from '../src/gitea.ts'

test('site validation accepts "forgejo" as a provider, defaulting its token ref', () => {
  const result = parseSite({
    id: 'self-hosted-forgejo',
    site: { baseUrl: 'https://forgejo.example.com/api/v1', provider: 'forgejo' },
  })
  assert.equal(typeof result, 'object', `expected a parsed site, got: ${result}`)
  const parsed = result as { site: { provider: string; tokenRef: string } }
  assert.equal(parsed.site.provider, 'forgejo')
  assert.equal(parsed.site.tokenRef, 'FORGEJO_TOKEN')
})

test('adapterFor maps "forgejo" to the "gitea" adapter and leaves other providers untouched', () => {
  assert.equal(adapterFor('forgejo'), 'gitea')
  for (const provider of ['gitlab', 'github', 'gitee', 'gitea', 'bitbucket'] as const) {
    assert.equal(adapterFor(provider), provider)
  }
})

test('a forgejo-labeled site behaves through the GiteaClient adapter (same wire protocol)', async () => {
  const urls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(input instanceof URL ? input.toString() : String(input))
    return new Response(JSON.stringify([]), { status: 200 })
  }) as typeof fetch

  // clientFor in index.ts picks GiteaClient whenever adapterFor(provider) === 'gitea';
  // this exercises that same adapter directly against a forgejo-flavored site config.
  const client = new GiteaClient(
    { FORGEJO_TOKEN: 't' },
    { id: 'self-hosted-forgejo', baseUrl: 'https://forgejo.example.com/api/v1', tokenRef: refOf('FORGEJO_TOKEN') },
  )
  await client.listRepos({})
  assert.equal(urls.length, 1)
  assert.ok(urls[0].startsWith('https://forgejo.example.com/api/v1/user/repos'))
})
