/**
 * Shared HTTP helpers for the forge clients: token resolution from one
 * operation snapshot, page-size clamping, and non-2xx error detail. Token
 * values enter only the request header; error text never carries them.
 * @module git-http
 */

import type { TokenRef } from './store.ts'

/** One configured site as the clients see it. */
export interface AuthedSite {
  readonly id: string
  readonly baseUrl: string
  readonly tokenRef: TokenRef
  readonly defaultProject?: string
}

/**
 * Resolve the site token from one operation snapshot; fails loud when the
 * reference is unconfigured.
 * @param tokens - the operation's decrypted token snapshot.
 * @param site - the site whose token is needed.
 * @returns the non-empty token value.
 */
export function tokenFor(tokens: Readonly<Record<string, string>>, site: AuthedSite): string {
  const value = tokens[site.tokenRef]
  if (value === undefined || value === '') {
    throw new Error(
      `site "${site.id}": token ${site.tokenRef} is not configured. Add it in Settings → Git 凭据.`,
    )
  }
  return value
}

/** The maximum `per_page` GitHub and GitLab honor. */
const MAX_PER_PAGE = 100

/** Clamp a page size into the accepted range. */
export function pageSize(requested: number | undefined): string {
  return String(Math.min(Math.max(Math.trunc(requested ?? 20), 1), MAX_PER_PAGE))
}

/** Human-readable failure text for any thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The API's `{message}` detail from a non-2xx body; the status line when the body is not JSON. */
export async function errorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { readonly message?: unknown }
    if (typeof body.message === 'string' && body.message !== '') return body.message
    if (body.message !== undefined) return JSON.stringify(body.message)
  } catch {
    // Non-JSON error body (proxy or gateway); the status text is the whole story.
  }
  return response.statusText
}
