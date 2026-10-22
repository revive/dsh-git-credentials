/**
 * The panel's site vocabulary: provider labels and defaults plus the
 * client-side mirrors of the admin route's validation rules. The mirrors exist
 * to state a rule BEFORE a write is attempted — the route stays the authority,
 * and its message is still what surfaces if a rule drifts. Problems are
 * returned as copy keys, so the panel renders them in the active locale.
 * @module dsh-git-credentials/client/site-model
 */

import type { ProviderId } from './admin-api.ts'

/** Provider order in every picker. */
export const PROVIDER_ORDER: readonly ProviderId[] = ['gitlab', 'github', 'gitee', 'gitea', 'bitbucket']

/** Display label per provider (product names, identical in every locale). */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  gitlab: 'GitLab',
  github: 'GitHub',
  gitee: 'Gitee',
  gitea: 'Gitea',
  bitbucket: 'Bitbucket',
}

/** Default API base URL per provider (empty = the user must fill it in). */
export const DEFAULT_BASE_URLS: Record<ProviderId, string> = {
  gitlab: '',
  github: 'https://api.github.com',
  gitee: 'https://gitee.com/api/v5',
  gitea: '',
  bitbucket: 'https://api.bitbucket.org/2.0',
}

/** Base-URL placeholder per provider. */
export const BASE_URL_PLACEHOLDERS: Record<ProviderId, string> = {
  gitlab: 'https://gitlab.example.com',
  github: 'https://api.github.com',
  gitee: 'https://gitee.com/api/v5',
  gitea: 'https://gitea.example.com/api/v1',
  bitbucket: 'https://api.bitbucket.org/2.0',
}

/** The copy keys a rejected field can point at. */
export type SiteProblemKey =
  | 'problemIdEmpty'
  | 'problemIdCharset'
  | 'problemIdTaken'
  | 'problemUrlEmpty'
  | 'problemUrlMalformed'
  | 'problemUrlScheme'

/** The site id pattern the admin route enforces (kept in sync by hand). */
const SITE_ID_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * Why one site id is unusable, or null when it is fine.
 * @param id - the candidate id.
 * @param taken - ids already configured (a duplicate would overwrite that site).
 * @returns the problem key, or null.
 */
export function siteIdProblem(id: string, taken: readonly string[]): SiteProblemKey | null {
  const value = id.trim()
  if (value === '') return 'problemIdEmpty'
  if (!SITE_ID_PATTERN.test(value)) return 'problemIdCharset'
  if (taken.includes(value)) return 'problemIdTaken'
  return null
}

/**
 * Why one API base URL is unusable, or null when it is fine.
 * @param baseUrl - the candidate URL.
 * @returns the problem key, or null.
 */
export function baseUrlProblem(baseUrl: string): SiteProblemKey | null {
  const value = baseUrl.trim()
  if (value === '') return 'problemUrlEmpty'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'problemUrlMalformed'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'problemUrlScheme'
  return null
}

/**
 * Whether a base URL is a provider default (or empty), i.e. nothing the user
 * typed: switching provider may then replace it.
 * @param value - the current draft.
 * @returns true when the value is a stock default.
 */
export function isStockBaseUrl(value: string): boolean {
  return value === '' || Object.values(DEFAULT_BASE_URLS).includes(value)
}

/**
 * The minimum token scope (or permission set) each provider's UI asks for.
 * Values are the platforms' own scope/permission names, so they stay untranslated;
 * a provider without a single unambiguous set is left undefined and shows no hint.
 */
export const TOKEN_SCOPES: Record<ProviderId, string | undefined> = {
  github: 'Contents, Issues, Pull requests (read & write)',
  gitlab: 'api',
  gitee: 'projects',
  gitea: 'repo',
  bitbucket: 'Repositories, Pull requests, Issues (read & write)',
}

/**
 * The web root that serves one forge's pages, derived from its API base URL.
 * Self-hosted GitLab/Gitea API roots end in `/api/v4` or `/api/v1`; strip that
 * suffix and keep any deployment sub-path, so `https://host/gitlab/api/v4`
 * yields `https://host/gitlab`. An empty, malformed, or non-http(s) URL has no
 * usable page root.
 * @param baseUrl - the site's API base URL as typed.
 * @param apiSuffix - the provider's API path suffix ("/api/v4" or "/api/v1").
 * @returns the page root without a trailing slash, or undefined.
 */
function pageRoot(baseUrl: string, apiSuffix: string): string | undefined {
  const value = baseUrl.trim()
  if (value === '') return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  let path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith(apiSuffix)) path = path.slice(0, -apiSuffix.length).replace(/\/+$/, '')
  return `${url.origin}${path}`
}

/**
 * The selected provider's token-creation page, or undefined when it cannot be
 * derived safely. GitHub points at the fine-grained PAT page with the token
 * name prefilled; GitLab and Gitea build their page from the site's own URL.
 * The result is a local string and never carries a token value.
 * @param provider - the site's provider.
 * @param baseUrl - the site's API base URL as currently typed.
 * @returns the absolute https URL, or undefined to hide the link.
 */
export function tokenUrlFor(provider: ProviderId, baseUrl: string): string | undefined {
  switch (provider) {
    case 'github': {
      const url = new URL('https://github.com/settings/personal-access-tokens/new')
      url.searchParams.set('name', 'dsh-git-credentials')
      return url.toString()
    }
    case 'gitlab': {
      const root = pageRoot(baseUrl, '/api/v4')
      if (root === undefined) return undefined
      const url = new URL(`${root}/-/user_settings/personal_access_tokens`)
      url.searchParams.set('name', 'dsh-git-credentials')
      url.searchParams.set('scopes', 'api')
      return url.toString()
    }
    case 'gitea': {
      const root = pageRoot(baseUrl, '/api/v1')
      return root === undefined ? undefined : `${root}/user/settings/applications`
    }
    case 'gitee':
      return 'https://gitee.com/profile/personal_access_tokens'
    case 'bitbucket':
      return 'https://bitbucket.org/account/settings/app-passwords/'
  }
}
