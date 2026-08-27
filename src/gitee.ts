/**
 * Gitee (gitee.com) OpenAPI v5 client for the git-credentials plugin: one
 * configured site per client, token values taken from the plugin's own
 * encrypted store snapshot. The token enters only the `Authorization`
 * header; when Gitee answers 401 to the header (some deployments only honor
 * the URL form), the request is retried once with the `access_token` query
 * parameter. One operation, one decrypted state.
 * @module git-gitee
 */

import { errorDetail, errorMessage, pageSize, tokenFor, type AuthedSite } from './http.ts'

/** A repository summary as Gitee's API returns it. */
export interface GiteeRepo {
  readonly id: number
  /** `owner/repo`, the path Git tooling expects. */
  readonly path: string
  readonly name: string
  readonly webUrl: string
  readonly visibility: string
}

/** One issue or pull request entry. */
export interface GiteeEntry {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly webUrl: string
  readonly authorName: string
}

/** A repository file read through the Gitee API. */
export interface GiteeFile {
  readonly path: string
  readonly ref: string
  readonly content: string
  readonly truncated: boolean
}

/** Issue states Gitee accepts. */
export type GiteeIssueState = 'open' | 'closed' | 'all'

/** Pull-request states Gitee accepts. */
export type GiteePullState = 'open' | 'closed' | 'all'

/** Raw repository entry (list and search shapes share these fields). */
interface RawRepo {
  readonly id: number
  readonly full_name: string
  readonly name: string
  readonly html_url: string
  readonly private: boolean
}

/** Raw issue / pull-request entry. */
interface RawEntry {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly html_url: string
  readonly user: { readonly login: string } | null
}

/** Raw file entry (same shape as GitHub's contents API). */
interface RawFile {
  readonly encoding?: string
  readonly content?: string
}

/** Split `owner/repo` into two path segments; fails loud on a malformed argument. */
function splitProject(siteId: string, project: string): [string, string] {
  const parts = project.split('/')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error(`site "${siteId}": project must be "owner/repo", got ${JSON.stringify(project)}`)
  }
  return [parts[0]!, parts[1]!]
}

/**
 * Authenticated Gitee OpenAPI v5 client. One instance per call, built from
 * one store snapshot.
 */
export class GiteeClient {
  constructor(
    private readonly tokens: Readonly<Record<string, string>>,
    readonly site: AuthedSite,
  ) {}

  /**
   * List repositories of the token owner, optionally by name search.
   * @param options - search text, page size, cancellation.
   * @returns repository summaries.
   */
  async listRepos(options: {
    readonly search?: string
    readonly perPage?: number
    readonly signal?: AbortSignal
  }): Promise<GiteeRepo[]> {
    const raw = options.search === undefined || options.search === ''
      ? await this.get<RawRepo[]>('/user/repos', {
        params: { type: 'all', per_page: pageSize(options.perPage) },
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
      : (await this.get<{ items: RawRepo[] }>('/search/repositories', {
        params: { q: options.search, per_page: pageSize(options.perPage) },
        ...options.signal === undefined ? {} : { signal: options.signal },
      })).items
    return raw.map(mapRepo)
  }

  /**
   * Read one repository file at a ref; the default branch when the ref is
   * omitted. Content beyond `maxBytes` is cut and flagged.
   * @param options - project, file path, ref, byte cap, cancellation.
   * @returns the decoded file content.
   */
  async readFile(options: {
    readonly project: string
    readonly path: string
    readonly ref?: string
    readonly maxBytes: number
    readonly signal?: AbortSignal
  }): Promise<GiteeFile> {
    const [owner, repo] = splitProject(this.site.id, options.project)
    const ref = options.ref ?? (await this.defaultBranch(owner, repo, options.signal))
    const raw = await this.get<RawFile | unknown[]>(
      `/repos/${owner}/${repo}/contents/${encodePath(options.path)}`,
      { params: { ref }, ...options.signal === undefined ? {} : { signal: options.signal } },
    )
    if (Array.isArray(raw)) {
      throw new Error(`site "${this.site.id}": ${options.path} is a directory, not a file`)
    }
    if (raw.encoding !== 'base64' || raw.content === undefined) {
      throw new Error(`site "${this.site.id}": ${options.path} has an unexpected content encoding`)
    }
    const content = Buffer.from(raw.content, 'base64').toString('utf8')
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
    readonly state?: GiteeIssueState
    readonly perPage?: number
    readonly signal?: AbortSignal
  }): Promise<GiteeEntry[]> {
    const [owner, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    const raw = await this.get<RawEntry[]>(`/repos/${owner}/${repo}/issues`, {
      params: {
        ...options.state === undefined || options.state === 'all' ? {} : { state: options.state },
        per_page: pageSize(options.perPage),
      },
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    return raw.map(mapEntry)
  }

  /**
   * List pull requests of one repository.
   * @param options - project (site default when omitted), state, page size, cancellation.
   * @returns pull-request summaries.
   */
  async listPullRequests(options: {
    readonly project?: string
    readonly state?: GiteePullState
    readonly perPage?: number
    readonly signal?: AbortSignal
  }): Promise<GiteeEntry[]> {
    const [owner, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    const raw = await this.get<RawEntry[]>(`/repos/${owner}/${repo}/pulls`, {
      params: {
        ...options.state === undefined || options.state === 'all' ? {} : { state: options.state },
        per_page: pageSize(options.perPage),
      },
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    return raw.map(mapEntry)
  }

  /**
   * Create an issue in one repository (write operation).
   * @param options - project, title, optional body, cancellation.
   * @returns the created issue summary (canonical entry shape).
   */
  async createIssue(options: {
    readonly project?: string
    readonly title: string
    readonly body?: string
    readonly signal?: AbortSignal
  }): Promise<GiteeEntry> {
    const [owner, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    const raw = await this.post<RawEntry>(
      `/repos/${owner}/${repo}/issues`,
      { title: options.title, ...options.body === undefined ? {} : { body: options.body } },
      options.signal,
    )
    return mapEntry(raw)
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
  }): Promise<GiteeEntry> {
    const [owner, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    const raw = await this.post<RawEntry>(
      `/repos/${owner}/${repo}/pulls`,
      {
        title: options.title,
        head: options.head,
        base: options.base,
        ...options.body === undefined ? {} : { body: options.body },
      },
      options.signal,
    )
    return mapEntry(raw)
  }

  /**
   * Create a repository under the token owner (write operation).
   * @param options - name, optional description/visibility, cancellation.
   * @returns the created repository summary (canonical repo shape).
   */
  async createRepo(options: {
    readonly name: string
    readonly description?: string
    readonly private?: boolean
    readonly signal?: AbortSignal
  }): Promise<GiteeRepo> {
    const raw = await this.post<RawRepo>(
      '/user/repos',
      {
        name: options.name,
        ...options.description === undefined ? {} : { description: options.description },
        ...options.private === undefined ? {} : { private: options.private },
      },
      options.signal,
    )
    return mapRepo(raw)
  }

  /**
   * Close an issue (write operation).
   * @param options - project, issue number, cancellation.
   * @returns the updated issue summary.
   */
  async closeIssue(options: {
    readonly project?: string
    readonly number: number
    readonly signal?: AbortSignal
  }): Promise<GiteeEntry> {
    return this.setIssueState(options, 'closed')
  }

  /**
   * Reopen an issue (write operation).
   * @param options - project, issue number, cancellation.
   * @returns the updated issue summary.
   */
  async reopenIssue(options: {
    readonly project?: string
    readonly number: number
    readonly signal?: AbortSignal
  }): Promise<GiteeEntry> {
    return this.setIssueState(options, 'open')
  }

  /** Set one issue's state (close/reopen) and return the updated entry. */
  private async setIssueState(
    options: { readonly project?: string; readonly number: number; readonly signal?: AbortSignal },
    state: 'open' | 'closed',
  ): Promise<GiteeEntry> {
    const [owner, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    await this.patch(`/repos/${owner}/${repo}/issues/${options.number}`, { state })
    const raw = await this.get<RawEntry>(
      `/repos/${owner}/${repo}/issues/${options.number}`,
      options.signal === undefined ? {} : { signal: options.signal },
    )
    return mapEntry(raw)
  }

  /**
   * Comment on an issue (write operation).
   * @param options - project, issue number, comment body, cancellation.
   * @returns a comment-shaped entry (`state: "comment"`, title = comment body).
   */
  async commentIssue(options: {
    readonly project?: string
    readonly number: number
    readonly body: string
    readonly signal?: AbortSignal
  }): Promise<GiteeEntry> {
    const [owner, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    const raw = await this.post<{ id: number; html_url: string; user: { login: string } | null }>(
      `/repos/${owner}/${repo}/issues/${options.number}/comments`,
      { body: options.body },
      options.signal,
    )
    return {
      number: options.number,
      title: options.body,
      state: 'comment',
      webUrl: raw.html_url,
      authorName: raw.user?.login ?? 'unknown',
    }
  }

  /**
   * Merge a pull request (write operation).
   * @param options - project (site default when omitted), PR number, cancellation.
   * @returns the merged pull-request summary.
   */
  async mergePull(options: {
    readonly project?: string
    readonly number: number
    readonly signal?: AbortSignal
  }): Promise<GiteeEntry> {
    const [owner, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    await this.put(`/repos/${owner}/${repo}/pulls/${options.number}/merge`, {})
    const merged = await this.get<RawEntry>(
      `/repos/${owner}/${repo}/pulls/${options.number}`,
      options.signal === undefined ? {} : { signal: options.signal },
    )
    return mapEntry({ ...merged, state: 'merged' })
  }

  /**
   * Close a pull request without merging (write operation).
   * @param options - project (site default when omitted), PR number, cancellation.
   * @returns the closed pull-request summary.
   */
  async closePull(options: {
    readonly project?: string
    readonly number: number
    readonly signal?: AbortSignal
  }): Promise<GiteeEntry> {
    const [owner, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    await this.patch(`/repos/${owner}/${repo}/pulls/${options.number}`, { state: 'closed' })
    const raw = await this.get<RawEntry>(
      `/repos/${owner}/${repo}/pulls/${options.number}`,
      options.signal === undefined ? {} : { signal: options.signal },
    )
    return mapEntry(raw)
  }

  /** One authenticated PATCH against the Gitee API. */
  private async patch<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return this.write<T>('PATCH', path, body, signal)
  }

  /** One authenticated PUT against the Gitee API. */
  private async put<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return this.write<T>('PUT', path, body, signal)
  }

  /** One authenticated JSON write (PATCH/PUT) against the Gitee API. */
  private async write<T>(
    method: 'PATCH' | 'PUT',
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    queryAuth = false,
  ): Promise<T> {
    const token = tokenFor(this.tokens, this.site)
    const url = new URL(path, `${this.site.baseUrl.replace(/\/+$/, '')}/`)
    if (queryAuth) url.searchParams.set('access_token', token)
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers: queryAuth
          ? { 'content-type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'dsh-git-credentials' }
          : {
            'Authorization': `Bearer ${token}`,
            'content-type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'dsh-git-credentials',
          },
        body: JSON.stringify(body),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error) {
      throw new Error(`site "${this.site.id}": request to ${path} failed: ${errorMessage(error)}`)
    }
    // Some Gitee deployments only honor the access_token URL form: retry once
    // with the query parameter when the header form is rejected.
    if (response.status === 401 && !queryAuth) return this.write(method, path, body, signal, true)
    if (!response.ok) {
      const detail = await errorDetail(response)
      const hint = response.status === 401
        ? ` — the ${this.site.tokenRef} token is invalid or expired; rotate it in Settings → Git 凭据`
        : ''
      throw new Error(`site "${this.site.id}": ${path} returned ${response.status} ${detail}${hint}`)
    }
    return (await response.json()) as T
  }

  /** One authenticated POST against the Gitee API. */
  private async post<T>(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    queryAuth = false,
  ): Promise<T> {
    const token = tokenFor(this.tokens, this.site)
    const url = new URL(path, `${this.site.baseUrl.replace(/\/+$/, '')}/`)
    if (queryAuth) url.searchParams.set('access_token', token)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: queryAuth
          ? { 'content-type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'dsh-git-credentials' }
          : {
            'Authorization': `Bearer ${token}`,
            'content-type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'dsh-git-credentials',
          },
        body: JSON.stringify(body),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error) {
      throw new Error(`site "${this.site.id}": request to ${path} failed: ${errorMessage(error)}`)
    }
    // Some Gitee deployments only honor the access_token URL form: retry once
    // with the query parameter when the header form is rejected.
    if (response.status === 401 && !queryAuth) return this.post(path, body, signal, true)
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
  private async defaultBranch(owner: string, repo: string, signal?: AbortSignal): Promise<string> {
    const raw = await this.get<{ readonly default_branch: string }>(
      `/repos/${owner}/${repo}`,
      signal === undefined ? {} : { signal },
    )
    return raw.default_branch
  }

  /** One authenticated GET against the Gitee API. */
  private async get<T>(path: string, options: {
    readonly params?: Record<string, string | undefined>
    readonly signal?: AbortSignal
  }, queryAuth = false): Promise<T> {
    const token = tokenFor(this.tokens, this.site)
    const url = new URL(path, `${this.site.baseUrl.replace(/\/+$/, '')}/`)
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value)
    }
    if (queryAuth) url.searchParams.set('access_token', token)
    let response: Response
    try {
      response = await fetch(url, {
        headers: queryAuth
          ? { 'Accept': 'application/json', 'User-Agent': 'dsh-git-credentials' }
          : { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'User-Agent': 'dsh-git-credentials' },
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
    } catch (error) {
      throw new Error(`site "${this.site.id}": request to ${path} failed: ${errorMessage(error)}`)
    }
    // Some Gitee deployments only honor the access_token URL form: retry once
    // with the query parameter when the header form is rejected.
    if (response.status === 401 && !queryAuth) return this.get(path, options, true)
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
function mapRepo(repo: RawRepo): GiteeRepo {
  return {
    id: repo.id,
    path: repo.full_name,
    name: repo.name,
    webUrl: repo.html_url,
    visibility: repo.private ? 'private' : 'public',
  }
}

/** Map one raw issue/PR entry to the canonical summary. */
function mapEntry(entry: RawEntry): GiteeEntry {
  return {
    number: entry.number,
    title: entry.title,
    state: entry.state,
    webUrl: entry.html_url,
    authorName: entry.user?.login ?? 'unknown',
  }
}

/** URL-encode one file path for the contents endpoint (slashes preserved as segments). */
function encodePath(path: string): string {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/')
}
