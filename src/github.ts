/**
 * GitHub REST API client for the git-credentials plugin: one configured site
 * per client, token values taken from the plugin's own encrypted store
 * snapshot. The token enters only the `Authorization` header; GitHub also
 * requires a User-Agent, which this module supplies. One operation, one
 * decrypted state.
 * @module git-github
 */

import { errorDetail, errorMessage, pageSize, tokenFor, type AuthedSite } from './http.ts'

/** A repository summary as GitHub's API returns it. */
export interface GitHubRepo {
  readonly id: number
  /** `owner/name`, the path Git tooling expects. */
  readonly path: string
  readonly name: string
  readonly webUrl: string
  readonly visibility: string
}

/** One issue or pull request entry. */
export interface GitHubEntry {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly webUrl: string
  readonly authorName: string
}

/** A repository file read through the GitHub API. */
export interface GitHubFile {
  readonly path: string
  readonly ref: string
  readonly content: string
  readonly truncated: boolean
}

/** Issue states GitHub accepts. */
export type GitHubIssueState = 'open' | 'closed' | 'all'

/** Pull-request states GitHub accepts. */
export type GitHubPullState = 'open' | 'closed' | 'all'

/** Raw repository entry. */
interface RawRepo {
  readonly id: number
  readonly full_name: string
  readonly name: string
  readonly html_url: string
  readonly visibility: string
  readonly private: boolean
}

/** Raw issue / pull-request entry; issues list entries carry `pull_request` when they are PRs. */
interface RawEntry {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly html_url: string
  readonly user: { readonly login: string } | null
  readonly pull_request?: unknown
}

/** Raw file entry. */
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
 * Authenticated GitHub REST API client. One instance per call, built from
 * one store snapshot.
 */
export class GitHubClient {
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
  }): Promise<GitHubRepo[]> {
    const raw = options.search === undefined || options.search === ''
      ? await this.get<RawRepo[]>('/user/repos', {
        params: { per_page: pageSize(options.perPage) },
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
      : (await this.get<{ items: RawRepo[] }>('/search/repositories', {
        params: { q: `${options.search} in:name`, per_page: pageSize(options.perPage) },
        ...options.signal === undefined ? {} : { signal: options.signal },
      })).items
    return raw.map(repo => ({
      id: repo.id,
      path: repo.full_name,
      name: repo.name,
      webUrl: repo.html_url,
      visibility: repo.visibility,
    }))
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
  }): Promise<GitHubFile> {
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
   * List issues of one repository (pull requests excluded).
   * @param options - project (site default when omitted), state, page size, cancellation.
   * @returns issue summaries.
   */
  async listIssues(options: {
    readonly project?: string
    readonly state?: GitHubIssueState
    readonly perPage?: number
    readonly signal?: AbortSignal
  }): Promise<GitHubEntry[]> {
    const [owner, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    const raw = await this.get<RawEntry[]>(`/repos/${owner}/${repo}/issues`, {
      params: { state: options.state ?? 'open', per_page: pageSize(options.perPage) },
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    return raw.filter(entry => entry.pull_request === undefined).map(mapEntry)
  }

  /**
   * List pull requests of one repository.
   * @param options - project (site default when omitted), state, page size, cancellation.
   * @returns pull-request summaries.
   */
  async listPullRequests(options: {
    readonly project?: string
    readonly state?: GitHubPullState
    readonly perPage?: number
    readonly signal?: AbortSignal
  }): Promise<GitHubEntry[]> {
    const [owner, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    const raw = await this.get<RawEntry[]>(`/repos/${owner}/${repo}/pulls`, {
      params: { state: options.state ?? 'open', per_page: pageSize(options.perPage) },
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
  }): Promise<GitHubEntry> {
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
  }): Promise<GitHubEntry> {
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
  }): Promise<GitHubRepo> {
    const raw = await this.post<RawRepo>(
      '/user/repos',
      {
        name: options.name,
        ...options.description === undefined ? {} : { description: options.description },
        ...options.private === undefined ? {} : { private: options.private },
      },
      options.signal,
    )
    return {
      id: raw.id,
      path: raw.full_name,
      name: raw.name,
      webUrl: raw.html_url,
      visibility: raw.private ? 'private' : 'public',
    }
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
  }): Promise<GitHubEntry> {
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
  }): Promise<GitHubEntry> {
    return this.setIssueState(options, 'open')
  }

  /** Set one issue's state (close/reopen) and return the updated entry. */
  private async setIssueState(
    options: { readonly project?: string; readonly number: number; readonly signal?: AbortSignal },
    state: 'open' | 'closed',
  ): Promise<GitHubEntry> {
    const [owner, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    await this.patch(`/repos/${owner}/${repo}/issues/${options.number}`, { state })
    return this.issueEntry(owner, repo, options.number, options.signal)
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
  }): Promise<GitHubEntry> {
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
   * @param options - project, PR number, cancellation.
   * @returns the merged pull-request summary.
   */
  async mergePull(options: {
    readonly project?: string
    readonly number: number
    readonly signal?: AbortSignal
  }): Promise<GitHubEntry> {
    const [owner, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    await this.put(`/repos/${owner}/${repo}/pulls/${options.number}/merge`, {})
    return this.pullEntry(owner, repo, options.number, options.signal)
  }

  /**
   * Close a pull request without merging (write operation).
   * @param options - project, PR number, cancellation.
   * @returns the closed pull-request summary.
   */
  async closePull(options: {
    readonly project?: string
    readonly number: number
    readonly signal?: AbortSignal
  }): Promise<GitHubEntry> {
    const [owner, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    await this.patch(`/repos/${owner}/${repo}/pulls/${options.number}`, { state: 'closed' })
    return this.pullEntry(owner, repo, options.number, options.signal)
  }

  /** One issue entry by number. */
  private async issueEntry(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<GitHubEntry> {
    const raw = await this.get<RawEntry>(`/repos/${owner}/${repo}/issues/${number}`, signal === undefined ? {} : { signal })
    return mapEntry(raw)
  }

  /** One pull-request entry by number. */
  private async pullEntry(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<GitHubEntry> {
    const raw = await this.get<RawEntry>(`/repos/${owner}/${repo}/pulls/${number}`, signal === undefined ? {} : { signal })
    return mapEntry(raw)
  }

  /** One authenticated PATCH against the GitHub REST API. */
  private async patch<T = unknown>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return this.write<T>('PATCH', path, body, signal)
  }

  /** One authenticated PUT against the GitHub REST API. */
  private async put<T = unknown>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return this.write<T>('PUT', path, body, signal)
  }

  /** One authenticated JSON write (PATCH/PUT) against the GitHub REST API. */
  private async write<T>(method: 'PATCH' | 'PUT', path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const token = tokenFor(this.tokens, this.site)
    const url = new URL(path, `${this.site.baseUrl.replace(/\/+$/, '')}/`)
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
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

  /** One authenticated POST against the GitHub REST API. */
  private async post<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const token = tokenFor(this.tokens, this.site)
    const url = new URL(path, `${this.site.baseUrl.replace(/\/+$/, '')}/`)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
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
  private async defaultBranch(owner: string, repo: string, signal?: AbortSignal): Promise<string> {
    const raw = await this.get<{ readonly default_branch: string }>(
      `/repos/${owner}/${repo}`,
      signal === undefined ? {} : { signal },
    )
    return raw.default_branch
  }

  /** One authenticated GET against the GitHub REST API. */
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
          'Accept': 'application/vnd.github+json',
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

/** Map one raw issue/PR entry to the canonical summary. */
function mapEntry(entry: RawEntry): GitHubEntry {
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
