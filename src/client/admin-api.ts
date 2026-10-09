/**
 * Transport for the plugin's own management routes (`/git-credentials-admin/*`).
 * The panel is the only caller. Token values never appear in any response, so
 * nothing here round-trips a secret.
 * @module dsh-git-credentials/client/admin-api
 */

/** One supported forge provider (mirrors the store's union). */
export type ProviderId = 'gitlab' | 'github' | 'gitee' | 'gitea' | 'bitbucket'

/** One configured site as the admin state reports it. */
export interface AdminSite {
  provider: ProviderId
  baseUrl: string
  tokenRef: string
  defaultProject?: string
}

/** Token state of one reference, as the admin state reports it. */
export interface AdminToken {
  configured: boolean
  source?: string
}

/** The loaded admin state. */
export interface AdminState {
  defaultSite?: string
  sites: Record<string, AdminSite>
  tokens: Record<string, AdminToken>
}

/** The problem one failed response reports, as an Error. */
async function failureOf(response: Response): Promise<Error> {
  const body = await response.json().catch(() => undefined)
  const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : `HTTP ${response.status}`
  return new Error(message)
}

/** GET one admin endpoint. */
export async function adminGet(path: string): Promise<unknown> {
  const response = await fetch(path)
  if (!response.ok) throw await failureOf(response)
  return await response.json().catch(() => undefined)
}

/** POST or DELETE one admin endpoint with an optional JSON body. */
export async function adminWrite(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<void> {
  const response = await fetch(path, {
    method,
    ...body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  })
  if (!response.ok) throw await failureOf(response)
}
