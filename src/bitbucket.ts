/**
 * Bitbucket (bitbucket.org) API 2.0 client for the git-credentials plugin:
 * one configured site per client, token values taken from the plugin's own
 * encrypted store snapshot. The token enters only the `Authorization`
 * header. Bitbucket calls repositories "workspace/repo"; the site
 * defaultProject carries the workspace used to list repositories. One
 * operation, one decrypted state.
 * @module git-bitbucket
 */

import { errorDetail, errorMessage, pageSize, tokenFor, type AuthedSite } from './http.ts'

/** A repository summary as Bitbucket's API returns it. */
export interface BitbucketRepo {
  readonly id: string
  /** `workspace/repo`, the path Git tooling expects. */
  readonly path: string
  readonly name: string
  readonly webUrl: string
  readonly visibility: string
}

/** One issue or pull request entry. */
export interface BitbucketEntry {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly webUrl: string
  readonly authorName: string
}

/** A repository file read through the Bitbucket API. */
export interface BitbucketFile {
  readonly path: string
  readonly ref: string
  readonly content: string
  readonly truncated: boolean
}

/** Issue states Bitbucket accepts (2.0 vocabulary). */
export type BitbucketIssueState = 'open' | 'closed' | 'all'

/** Pull-request states Bitbucket accepts (2.0 vocabulary). */
export type BitbucketPullState = 'open' | 'closed' | 'all'

/** One page of a 2.0 list response. */
interface Page<T> {
  readonly values: readonly T[]
}

/** Raw repository entry. */
interface RawRepo {
  readonly uuid: string
  readonly full_name: string
  readonly name: string
  readonly is_private: boolean
  readonly links: { readonly html: { readonly href: string } }
}

/** Raw issue entry. */
interface RawIssue {
  readonly id: number
  readonly title: string
  readonly state: string
  readonly links: { readonly html: { readonly href: string } }
  readonly reporter: { readonly display_name: string } | null
}

/** Raw pull-request entry. */
interface RawPull {
  readonly id: number
  readonly title: string
  readonly state: string
  readonly links: { readonly html: { readonly href: string } }
  readonly author: { readonly display_name: string } | null
}

/** Split `workspace/repo` into two path segments; fails loud on a malformed argument. */
function splitProject(siteId: string, project: string): [string, string] {
  const parts = project.split('/')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error(`site "${siteId}": project must be "workspace/repo", got ${JSON.stringify(project)}`)
  }
  return [parts[0]!, parts[1]!]
}

/**
 * Authenticated Bitbucket API 2.0 client. One instance per call, built from
 * one store snapshot.
 */
export class BitbucketClient {
  constructor(
    private readonly tokens: Readonly<Record<string, string>>,
    readonly site: AuthedSite,
  ) {}

  /**
   * List repositories, optionally by name search. With a site defaultProject
   * the workspace's repositories are listed (2.0 has no global search, so a
   * search text becomes a server-side `q` filter); otherwise the token
   * owner's permitted repositories are listed and filtered client-side.
   * @param options - search text, page size, cancellation.
   * @returns repository summaries.
   */
  async listRepos(options: {
    readonly search?: string
    readonly perPage?: number
    readonly signal?: AbortSignal
  }): Promise<BitbucketRepo[]> {
    const search = options.search?.trim() ?? ''
    const workspace = this.site.defaultProject?.split('/')[0]
    const raw = workspace === undefined || workspace === ''
      ? (await this.get<Page<{ readonly repository: RawRepo }>>('/user/permissions/repositories', {
        params: { pagelen: pageSize(options.perPage) },
        ...options.signal === undefined ? {} : { signal: options.signal },
      })).values.map(entry => entry.repository)
      : (await this.get<Page<RawRepo>>(`/repositories/${encodeURIComponent(workspace)}`, {
        params: {
          pagelen: pageSize(options.perPage),
          ...search === '' ? {} : { q: `name~"${search}"` },
        },
        ...options.signal === undefined ? {} : { signal: options.signal },
      })).values
    const filtered = search === '' || workspace !== undefined
      ? raw
      : raw.filter(repo => repo.name.toLowerCase().includes(search.toLowerCase()))
    return filtered.map(mapRepo)
  }

  /**
   * Read one repository file at a ref; the default branch when the ref is
   * omitted. Bitbucket's src endpoint embeds the ref in the path and returns
   * the raw file. Content beyond `maxBytes` is cut and flagged.
   * @param options - project, file path, ref, byte cap, cancellation.
   * @returns the file content.
   */
  async readFile(options: {
    readonly project: string
    readonly path: string
    readonly ref?: string
    readonly maxBytes: number
    readonly signal?: AbortSignal
  }): Promise<BitbucketFile> {
    const [workspace, repo] = splitProject(this.site.id, options.project)
    const ref = options.ref ?? (await this.defaultBranch(workspace, repo, options.signal))
    const url = new URL(
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/src/${encodeURIComponent(ref)}/${encodePath(options.path)}`,
      `${this.site.baseUrl.replace(/\/+$/, '')}/`,
    )
    const token = tokenFor(this.tokens, this.site)
    let response: Response
    try {
      response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'dsh-git-credentials' },
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
    } catch (error) {
      throw new Error(`site "${this.site.id}": request to ${url.pathname} failed: ${errorMessage(error)}`)
    }
    if (!response.ok) {
      const detail = await errorDetail(response)
      const hint = response.status === 401
        ? ` — the ${this.site.tokenRef} token is invalid or expired; rotate it in Settings → Git 凭据`
        : ''
      throw new Error(`site "${this.site.id}": ${url.pathname} returned ${response.status} ${detail}${hint}`)
    }
    // A directory returns an HTML listing; a file returns its raw content.
    if ((response.headers.get('content-type') ?? '').includes('text/html')) {
      throw new Error(`site "${this.site.id}": ${options.path} is a directory, not a file`)
    }
    const content = await response.text()
    const truncated = content.length > options.maxBytes
    return {
      path: options.path,
      ref,
      content: truncated ? content.slice(0, options.maxBytes) : content,
      truncated,
    }
  }

  /**
   * List issues of one repository.
   * @param options - project (site default when omitted), state, page size, cancellation.
   * @returns issue summaries.
   */
  async listIssues(options: {
    readonly project?: string
    readonly state?: BitbucketIssueState
    readonly perPage?: number
    readonly signal?: AbortSignal
  }): Promise<BitbucketEntry[]> {
    const [workspace, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    const raw = await this.get<Page<RawIssue>>(
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/issues`,
      {
        params: {
          ...options.state === undefined || options.state === 'all' ? {} : { state: options.state },
          pagelen: pageSize(options.perPage),
        },
        ...options.signal === undefined ? {} : { signal: options.signal },
      },
    )
    return raw.values.map(issue => ({
      number: issue.id,
      title: issue.title,
      state: issue.state,
      webUrl: issue.links.html.href,
      authorName: issue.reporter?.display_name ?? 'unknown',
    }))
  }

  /**
   * List pull requests of one repository. 2.0 has no single "closed" state,
   * so `closed` maps to `ALL` (merged and declined both qualify).
   * @param options - project (site default when omitted), state, page size, cancellation.
   * @returns pull-request summaries.
   */
  async listPullRequests(options: {
    readonly project?: string
    readonly state?: BitbucketPullState
    readonly perPage?: number
    readonly signal?: AbortSignal
  }): Promise<BitbucketEntry[]> {
    const [workspace, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    const raw = await this.get<Page<RawPull>>(
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests`,
      {
        params: {
          ...options.state === undefined || options.state === 'closed' || options.state === 'all'
            ? { state: 'ALL' }
            : { state: 'OPEN' },
          pagelen: pageSize(options.perPage),
        },
        ...options.signal === undefined ? {} : { signal: options.signal },
      },
    )
    return raw.values.map(pull => ({
      number: pull.id,
      title: pull.title,
      state: pull.state,
      webUrl: pull.links.html.href,
      authorName: pull.author?.display_name ?? 'unknown',
    }))
  }

  /**
   * Create an issue in one repository (write operation).
   * @param options - project (site default when omitted), title, optional body, cancellation.
   * @returns the created issue summary (canonical entry shape).
   */
  async createIssue(options: {
    readonly project?: string
    readonly title: string
    readonly body?: string
    readonly signal?: AbortSignal
  }): Promise<BitbucketEntry> {
    const [workspace, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    const raw = await this.post<RawIssue>(
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/issues`,
      {
        title: options.title,
        ...options.body === undefined ? {} : { content: { raw: options.body } },
      },
      options.signal,
    )
    return mapIssue(raw)
  }

  /**
   * Create a pull request in one repository (write operation).
   * @param options - project (site default when omitted), branches, title, body, cancellation.
   * @returns the created pull-request summary (canonical entry shape).
   */
  async createPullRequest(options: {
    readonly project?: string
    readonly title: string
    readonly head: string
    readonly base: string
    readonly body?: string
    readonly signal?: AbortSignal
  }): Promise<BitbucketEntry> {
    const [workspace, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    const raw = await this.post<RawPull>(
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests`,
      {
        title: options.title,
        source: { branch: { name: options.head } },
        destination: { branch: { name: options.base } },
        ...options.body === undefined ? {} : { description: options.body },
      },
      options.signal,
    )
    return mapPull(raw)
  }

  /**
   * Create a repository in the site's workspace (write operation). The
   * workspace comes from the site defaultProject ("workspace/repo").
   * @param options - name, optional description/visibility, cancellation.
   * @returns the created repository summary (canonical repo shape).
   */
  async createRepo(options: {
    readonly name: string
    readonly description?: string
    readonly private?: boolean
    readonly signal?: AbortSignal
  }): Promise<BitbucketRepo> {
    const workspace = this.site.defaultProject?.split('/')[0] ?? ''
    if (workspace === '') {
      throw new Error(
        `site "${this.site.id}": creating a Bitbucket repository needs a workspace — configure the site defaultProject as "workspace/repo" first`,
      )
    }
    const raw = await this.post<RawRepo>(
      `/repositories/${encodeURIComponent(workspace)}`,
      {
        name: options.name,
        ...options.description === undefined ? {} : { description: options.description },
        ...options.private === undefined ? {} : { is_private: options.private },
      },
      options.signal,
    )
    return mapRepo(raw)
  }

  /**
   * Close an issue (write operation).
   * @param options - project, issue id, cancellation.
   * @returns the updated issue summary.
   */
  async closeIssue(options: {
    readonly project?: string
    readonly number: number
    readonly signal?: AbortSignal
  }): Promise<BitbucketEntry> {
    return this.setIssueState(options, 'closed')
  }

  /**
   * Reopen an issue (write operation).
   * @param options - project, issue id, cancellation.
   * @returns the updated issue summary.
   */
  async reopenIssue(options: {
    readonly project?: string
    readonly number: number
    readonly signal?: AbortSignal
  }): Promise<BitbucketEntry> {
    return this.setIssueState(options, 'open')
  }

  /** Set one issue's state (close/reopen) via the changes endpoint and return the updated entry. */
  private async setIssueState(
    options: { readonly project?: string; readonly number: number; readonly signal?: AbortSignal },
    state: 'open' | 'closed',
  ): Promise<BitbucketEntry> {
    const [workspace, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    const base = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/issues/${options.number}`
    await this.post(`${base}/changes`, { changes: { state: { new: state } } }, options.signal)
    const raw = await this.get<RawIssue>(base, options.signal === undefined ? {} : { signal: options.signal })
    return mapIssue(raw)
  }

  /**
   * Comment on an issue (write operation).
   * @param options - project, issue id, comment body, cancellation.
   * @returns a comment-shaped entry (`state: "comment"`, title = comment body).
   */
  async commentIssue(options: {
    readonly project?: string
    readonly number: number
    readonly body: string
    readonly signal?: AbortSignal
  }): Promise<BitbucketEntry> {
    const [workspace, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    const raw = await this.post<{
      id: number
      content: { raw: string }
      links: { html: { href: string } }
      user: { display_name: string } | null
    }>(
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/issues/${options.number}/comments`,
      { content: { raw: options.body } },
      options.signal,
    )
    return {
      number: options.number,
      title: options.body,
      state: 'comment',
      webUrl: raw.links.html.href,
      authorName: raw.user?.display_name ?? 'unknown',
    }
  }

  /**
   * Merge a pull request (write operation).
   * @param options - project (site default when omitted), PR id, cancellation.
   * @returns the merged pull-request summary.
   */
  async mergePull(options: {
    readonly project?: string
    readonly number: number
    readonly signal?: AbortSignal
  }): Promise<BitbucketEntry> {
    const [workspace, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    const base = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests/${options.number}`
    const raw = await this.post<RawPull>(`${base}/merge`, {}, options.signal)
    return mapPull({ ...raw, state: 'MERGED' })
  }

  /**
   * Decline (close without merging) a pull request (write operation).
   * @param options - project (site default when omitted), PR id, cancellation.
   * @returns the declined pull-request summary.
   */
  async closePull(options: {
    readonly project?: string
    readonly number: number
    readonly signal?: AbortSignal
  }): Promise<BitbucketEntry> {
    const [workspace, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    const base = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests/${options.number}`
    const raw = await this.post<RawPull>(`${base}/decline`, {}, options.signal)
    return mapPull({ ...raw, state: 'declined' })
  }

  /** One authenticated POST against the Bitbucket 2.0 API. */
  private async post<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const token = tokenFor(this.tokens, this.site)
    const url = new URL(path, `${this.site.baseUrl.replace(/\/+$/, '')}/`)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'User-Agent': 'dsh-git-credentials',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error) {
      throw new Error(`site "${this.site.id}": request to ${path} failed: ${errorMessage(error)}`)
    }
    if (!response.ok) {
      const detail = await errorDetail(response)
      const hint = response.status === 401
        ? ` — the ${this.site.tokenRef} token is invalid or expired; rotate it in Settings → Git 凭据`
        : ''
      throw new Error(`site "${this.site.id}": ${path} returned ${response.status} ${detail}${hint}`)
    }
    return (await response.json()) as T
  }

  /** The repository's default branch name. */
  private async defaultBranch(workspace: string, repo: string, signal?: AbortSignal): Promise<string> {
    const raw = await this.get<{ readonly mainbranch: { readonly name: string } }>(
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}`,
      signal === undefined ? {} : { signal },
    )
    return raw.mainbranch.name
  }

  /** One authenticated GET against the Bitbucket 2.0 API. */
  private async get<T>(path: string, options: {
    readonly params?: Record<string, string | undefined>
    readonly signal?: AbortSignal
  }): Promise<T> {
    const token = tokenFor(this.tokens, this.site)
    const url = new URL(path, `${this.site.baseUrl.replace(/\/+$/, '')}/`)
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value)
    }
    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'User-Agent': 'dsh-git-credentials',
        },
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
    } catch (error) {
      throw new Error(`site "${this.site.id}": request to ${path} failed: ${errorMessage(error)}`)
    }
    if (!response.ok) {
      const detail = await errorDetail(response)
      const hint = response.status === 401
        ? ` — the ${this.site.tokenRef} token is invalid or expired; rotate it in Settings → Git 凭据`
        : ''
      throw new Error(`site "${this.site.id}": ${path} returned ${response.status} ${detail}${hint}`)
    }
    return (await response.json()) as T
  }

  /** The project to list; explicit argument wins, then the site default; otherwise fail loud. */
  private resolveProject(project: string | undefined): string {
    if (project !== undefined) return project
    if (this.site.defaultProject !== undefined) return this.site.defaultProject
    throw new Error(`site "${this.site.id}": a project argument is required when the site declares no defaultProject`)
  }
}

/** Map one raw repository to the canonical summary. */
function mapRepo(repo: RawRepo): BitbucketRepo {
  return {
    id: repo.uuid,
    path: repo.full_name,
    name: repo.name,
    webUrl: repo.links.html.href,
    visibility: repo.is_private ? 'private' : 'public',
  }
}

/** URL-encode one file path for the src endpoint (slashes preserved as segments). */
function encodePath(path: string): string {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

/** Map one raw issue to the canonical summary. */
function mapIssue(issue: RawIssue): BitbucketEntry {
  return {
    number: issue.id,
    title: issue.title,
    state: issue.state,
    webUrl: issue.links.html.href,
    authorName: issue.reporter?.display_name ?? 'unknown',
  }
}

/** Map one raw pull request to the canonical summary. */
function mapPull(pull: RawPull): BitbucketEntry {
  return {
    number: pull.id,
    title: pull.title,
    state: pull.state,
    webUrl: pull.links.html.href,
    authorName: pull.author?.display_name ?? 'unknown',
  }
}
