/**
 * The panel's site vocabulary: provider labels and defaults, field copy, and
 * the client-side mirrors of the admin route's validation rules. The mirrors
 * exist to state a rule BEFORE a write is attempted — the route stays the
 * authority, and its message is still what surfaces if a rule drifts.
 * @module dsh-git-credentials/client/site-model
 */

import type { ProviderId } from './admin-api.ts'

/** Provider order in every picker. */
export const PROVIDER_ORDER: readonly ProviderId[] = ['gitlab', 'github', 'gitee', 'gitea', 'bitbucket']

/** Display label per provider. */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  gitlab: 'GitLab',
  github: 'GitHub',
  gitee: 'Gitee',
  gitea: 'Gitea',
  bitbucket: 'Bitbucket',
}

/** Default token reference per provider (mirrors the admin route's defaults). */
export const DEFAULT_TOKEN_REFS: Record<ProviderId, string> = {
  gitlab: 'GITLAB_TOKEN',
  github: 'GITHUB_TOKEN',
  gitee: 'GITEE_TOKEN',
  gitea: 'GITEA_TOKEN',
  bitbucket: 'BITBUCKET_TOKEN',
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

/** The site id rule, in prose: shown as help before anything is typed. */
export const SITE_ID_HELP = '站点 id 就是工具里 site 参数的值：只能用小写字母、数字和连字符，必须以字母开头，例如 corp、github-work。'

/** The token reference rule, in prose. */
export const TOKEN_REF_HELP = 'token 引用名是存储里这条凭据的名字：只能使用字母、数字和下划线，且不能以数字开头，例如 GITHUB_TOKEN。'

/** The site id pattern the admin route enforces (kept in sync by hand). */
const SITE_ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** The token reference pattern the store enforces (kept in sync by hand). */
const TOKEN_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Why one site id is unusable, or null when it is fine.
 * @param id - the candidate id.
 * @param taken - ids already configured (a duplicate would overwrite that site).
 * @returns the problem text, or null.
 */
export function siteIdProblem(id: string, taken: readonly string[]): string | null {
  const value = id.trim()
  if (value === '') return '请填写站点 id'
  if (!SITE_ID_PATTERN.test(value)) return '只能用小写字母、数字和连字符，且必须以字母开头'
  if (taken.includes(value)) return '该站点 id 已存在'
  return null
}

/**
 * Why one API base URL is unusable, or null when it is fine.
 * @param baseUrl - the candidate URL.
 * @returns the problem text, or null.
 */
export function baseUrlProblem(baseUrl: string): string | null {
  const value = baseUrl.trim()
  if (value === '') return '请填写 API 地址'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return '请填写合法的 URL，例如 https://api.github.com'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'API 地址必须以 http:// 或 https:// 开头'
  return null
}

/**
 * Why one token reference name is unusable, or null when it is fine.
 * @param ref - the candidate reference name.
 * @returns the problem text, or null.
 */
export function tokenRefProblem(ref: string): string | null {
  const value = ref.trim()
  if (value === '') return '请填写 token 引用名，例如 GITHUB_TOKEN'
  if (!TOKEN_REF_PATTERN.test(value)) return '只能使用字母、数字和下划线，且不能以数字开头'
  return null
}

/**
 * Whether a base URL is exactly one of the provider defaults, i.e. nothing the
 * user typed: switching provider may then replace it.
 * @param value - the current draft.
 * @returns true when the value is a stock default.
 */
export function isStockBaseUrl(value: string): boolean {
  return value === '' || Object.values(DEFAULT_BASE_URLS).includes(value)
}

/**
 * Whether a token reference is exactly one of the provider defaults.
 * @param value - the current draft.
 * @returns true when the value is a stock default.
 */
export function isStockTokenRef(value: string): boolean {
  return value === '' || Object.values(DEFAULT_TOKEN_REFS).includes(value)
}
