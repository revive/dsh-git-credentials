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
