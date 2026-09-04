/**
 * Regression tests for the issues tool's new "label" action, one per
 * provider: GitHub/Gitee/Bitbucket-name-based endpoints, GitLab's single
 * add_labels/remove_labels PUT, Gitea's id-resolution requirement, and
 * Bitbucket's documented lack of a labels concept.
 * @module git-credentials-issue-labels-test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GiteaClient } from '../src/gitea.ts'
import { GitHubClient } from '../src/github.ts'
import { GitLabClient } from '../src/gitlab.ts'
import { GiteeClient } from '../src/gitee.ts'
import { BitbucketClient } from '../src/bitbucket.ts'
import { refOf } from '../src/store.ts'

/** Fake fetch that dispatches on method+path substring; records every call. */
function fakeFetch(handler: (method: string, url: string, body: unknown) => unknown): { calls: Array<{ method: string; url: string; body: unknown }> } {
  const calls: Array<{ method: string; url: string; body: unknown }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
    calls.push({ method, url, body })
    return new Response(JSON.stringify(handler(method, url, body)), { status: 200 })
  }) as typeof fetch
  return { calls }
}

test('GitHub: labelIssue adds by name (POST) and removes by name (DELETE), then refetches the issue', async () => {
  const state = fakeFetch((method, url) => {
    if (method === 'GET' && url.includes('/issues/42')) {
      return { number: 42, title: 'bug', state: 'open', html_url: 'https://x/42', user: { login: 'a' } }
    }
    return {}
  })
  const client = new GitHubClient({ GITHUB_TOKEN: 't' }, { id: 's', baseUrl: 'https://api.github.com', tokenRef: refOf('GITHUB_TOKEN') })
  const result = await client.labelIssue({ project: 'o/r', number: 42, add: ['bug'], remove: ['wontfix'] })
  assert.equal(result.number, 42)
  const addCall = state.calls.find(c => c.method === 'POST' && c.url.includes('/issues/42/labels'))
  assert.ok(addCall, 'expected a POST to add labels')
  assert.deepEqual(addCall!.body, { labels: ['bug'] })
  const removeCall = state.calls.find(c => c.method === 'DELETE' && c.url.includes('/issues/42/labels/wontfix'))
  assert.ok(removeCall, 'expected a DELETE for the removed label, addressed by name')
})

test('GitLab: labelIssue sends add_labels/remove_labels on a single Edit Issue PUT', async () => {
  const state = fakeFetch((method, url) => {
    if (method === 'GET' && url.includes('/issues/7')) {
      return { iid: 7, title: 'bug', state: 'opened', web_url: 'https://x/7', author: { name: 'a' } }
    }
    return {}
  })
  const client = new GitLabClient({ GITLAB_TOKEN: 't' }, { id: 's', baseUrl: 'https://gitlab.example.com', tokenRef: refOf('GITLAB_TOKEN') })
  await client.labelIssue({ project: 'g/p', number: 7, add: ['bug', 'p1'], remove: ['triage'] })
  const putCall = state.calls.find(c => c.method === 'PUT' && c.url.includes('/issues/7'))
  assert.ok(putCall, 'expected a single PUT to the Edit Issue endpoint')
  assert.deepEqual(putCall!.body, { add_labels: 'bug,p1', remove_labels: 'triage' })
})

test('Gitea: labelIssue resolves label names to ids before adding, and deletes by id', async () => {
  const state = fakeFetch((method, url) => {
    if (method === 'GET' && url.includes('/labels')) {
      return [{ id: 1, name: 'bug' }, { id: 2, name: 'wontfix' }]
    }
    if (method === 'GET' && url.includes('/issues/5')) {
      return { number: 5, title: 'bug', state: 'open', html_url: 'https://x/5', user: { login: 'a' } }
    }
    return {}
  })
  const client = new GiteaClient({ GITEA_TOKEN: 't' }, { id: 's', baseUrl: 'https://gitea.example.com/api/v1', tokenRef: refOf('GITEA_TOKEN') })
  await client.labelIssue({ project: 'o/r', number: 5, add: ['bug'], remove: ['wontfix'] })
  const addCall = state.calls.find(c => c.method === 'POST' && c.url.includes('/issues/5/labels'))
  assert.ok(addCall, 'expected a POST with resolved label ids')
  assert.deepEqual(addCall!.body, { labels: [1] })
  const removeCall = state.calls.find(c => c.method === 'DELETE' && c.url.includes('/issues/5/labels/2'))
  assert.ok(removeCall, 'expected a DELETE addressed by the resolved numeric id, not the name')
})

test('Gitea: labelIssue fails loud when a requested label name does not exist on the repo', async () => {
  fakeFetch((method, url) => {
    if (method === 'GET' && url.includes('/labels')) return [{ id: 1, name: 'bug' }]
    return {}
  })
  const client = new GiteaClient({ GITEA_TOKEN: 't' }, { id: 's', baseUrl: 'https://gitea.example.com/api/v1', tokenRef: refOf('GITEA_TOKEN') })
  await assert.rejects(
    () => client.labelIssue({ project: 'o/r', number: 5, add: ['does-not-exist'] }),
    /no label named "does-not-exist"/,
  )
})

test('Gitee: labelIssue adds via comma-separated names (POST) and removes by name (DELETE)', async () => {
  const state = fakeFetch((method, url) => {
    if (method === 'GET' && url.includes('/issues/3')) {
      return { number: 3, title: 'bug', state: 'open', html_url: 'https://x/3', user: { login: 'a' } }
    }
    return {}
  })
  const client = new GiteeClient({ GITEE_TOKEN: 't' }, { id: 's', baseUrl: 'https://gitee.com/api/v5', tokenRef: refOf('GITEE_TOKEN') })
  await client.labelIssue({ project: 'o/r', number: 3, add: ['bug', 'p1'], remove: ['triage'] })
  const addCall = state.calls.find(c => c.method === 'POST' && c.url.includes('/issues/3/labels'))
  assert.ok(addCall, 'expected a POST to add labels')
  assert.deepEqual(addCall!.body, { labels: 'bug,p1' })
  const removeCall = state.calls.find(c => c.method === 'DELETE' && c.url.includes('/issues/3/labels/triage'))
  assert.ok(removeCall, 'expected a DELETE for the removed label, addressed by name')
})

test('Bitbucket: labelIssue always fails loud — Cloud Issue Tracker has no labels field', async () => {
  fakeFetch(() => ({}))
  const client = new BitbucketClient({ BITBUCKET_TOKEN: 't' }, { id: 's', baseUrl: 'https://api.bitbucket.org/2.0', tokenRef: refOf('BITBUCKET_TOKEN') })
  await assert.rejects(
    () => client.labelIssue({ project: 'w/r', number: 1, add: ['bug'] }),
    /no labels field or endpoint/,
  )
})
