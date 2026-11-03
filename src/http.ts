/**
 * Shared HTTP helpers for the forge clients: token resolution from one
 * operation snapshot, page-size clamping, and non-2xx error detail. Token
 * values enter only the request header; error text never carries them.
 * @module git-http
 */

/** One configured site as the clients see it: one site owns exactly one token. */
export interface AuthedSite {
  readonly id: string
  readonly baseUrl: string
  readonly defaultProject?: string
}

/**
 * Join one site's API base URL with an endpoint path, preserving any path
 * segment in the base (`/api/v5` on Gitee, `/api/v1` on Gitea, `/2.0` on
 * Bitbucket, `/api/v3` on GitHub Enterprise). Resolving an absolute path
 * against the base would discard that segment.
 * @param baseUrl - the site's API base URL.
 * @param path - the endpoint path, with or without a leading slash.
 * @returns the absolute request URL.
 */
export function apiUrl(baseUrl: string, path: string): URL {
  return new URL(`${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`)
}

/** One comment as every forge client returns it: already capped and normalized. */
export interface CommentEntry {
  readonly id: number | string
  readonly body: string
  readonly authorName: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly webUrl: string
  readonly bodyTruncated: boolean
}

/**
 * Build one canonical comment, capping its body at the configured byte limit.
 * Missing author/timestamps/links become stable empty strings, so a partial
 * create response still satisfies the tool's output schema.
 * @param comment - the fields known from the API response.
 * @param maxBytes - the configured body cap.
 * @returns the canonical comment.
 */
export function makeComment(comment: {
  readonly id: number | string
  readonly body: string
  readonly authorName?: string | undefined
  readonly createdAt?: string | undefined
  readonly updatedAt?: string | undefined
  readonly webUrl?: string | undefined
}, maxBytes: number): CommentEntry {
  const body = comment.body ?? ''
  const truncated = body.length > maxBytes
  return {
    id: comment.id,
    body: truncated ? body.slice(0, maxBytes) : body,
    authorName: comment.authorName ?? 'unknown',
    createdAt: comment.createdAt ?? '',
    updatedAt: comment.updatedAt ?? '',
    webUrl: comment.webUrl ?? '',
    bodyTruncated: truncated,
  }
}

/**
 * Resolve the site's own token from one operation snapshot; fails loud when it
 * is unconfigured.
 * @param tokens - the operation's decrypted token snapshot, keyed by site id.
 * @param site - the site whose token is needed.
 * @returns the non-empty token value.
 */
export function tokenFor(tokens: Readonly<Record<string, string>>, site: AuthedSite): string {
  const value = tokens[site.id]
  if (value === undefined || value === '') {
    throw new Error(
      `site "${site.id}": no token is configured. Add one in Settings → Git 凭据.`,
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
