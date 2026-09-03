/**
 * Gitea (self-hosted) API v1 client for the git-credentials plugin: one
 * configured site per client, token values taken from the plugin's own
 * encrypted store snapshot. The token enters only the `Authorization` header
 * (`token` scheme, as Gitea documents). One operation, one decrypted state.
 * @module git-gitea
 */

import { errorDetail, errorMessage, pageSize, tokenFor, type AuthedSite } from './http.ts'

/** The largest page size Gitea honors. */
const MAX_LIMIT = 50

/** A repository summary as Gitea's API returns it. */
export interface GiteaRepo {
  readonly id: number
  /** `owner/repo`, the path Git tooling expects. */
  readonly path: string
  readonly name: string
  readonly webUrl: string
  readonly visibility: string
}

/** One issue or pull request entry. */
export interface GiteaEntry {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly webUrl: string
  readonly authorName: string
}

/** A repository file read through the Gitea API. */
export interface GiteaFile {
  readonly path: string
  readonly ref: string
  readonly content: string
  readonly truncated: boolean
}

/** Issue / pull-request states Gitea accepts. */
export type GiteaState = 'open' | 'closed' | 'all'

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
 * Authenticated Gitea API v1 client. One instance per call, built from one
 * store snapshot.
 */
export class GiteaClient {
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
  }): Promise<GiteaRepo[]> {
    const raw = options.search === undefined || options.search === ''
      ? await this.get<RawRepo[]>('/user/repos', {
        params: { limit: giteaLimit(options.perPage) },
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
      : (await this.get<{ data: RawRepo[] }>('/repos/search', {
        params: { q: options.search, limit: giteaLimit(options.perPage) },
        ...options.signal === undefined ? {} : { signal: options.signal },
      })).data
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
  }): Promise<GiteaFile> {
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
    readonly state?: GiteaState
    readonly perPage?: number
    readonly signal?: AbortSignal
  }): Promise<GiteaEntry[]> {
    const [owner, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    const raw = await this.get<RawEntry[]>(`/repos/${owner}/${repo}/issues`, {
      params: {
        ...options.state === undefined || options.state === 'all' ? {} : { state: options.state },
        limit: giteaLimit(options.perPage),
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
    readonly state?: GiteaState
    readonly perPage?: number
    readonly signal?: AbortSignal
  }): Promise<GiteaEntry[]> {
    const [owner, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    const raw = await this.get<RawEntry[]>(`/repos/${owner}/${repo}/pulls`, {
      params: {
        ...options.state === undefined || options.state === 'all' ? {} : { state: options.state },
        limit: giteaLimit(options.perPage),
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
  }): Promise<GiteaEntry> {
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
  }): Promise<GiteaEntry> {
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
  }): Promise<GiteaRepo> {
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
  }): Promise<GiteaEntry> {
    return this.setIssueState(options, 'closed', `/repos/${splitProject(this.site.id, this.resolveProject(options.project)).join('/')}/issues/${options.number}`)
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
  }): Promise<GiteaEntry> {
    return this.setIssueState(options, 'open', `/repos/${splitProject(this.site.id, this.resolveProject(options.project)).join('/')}/issues/${options.number}`)
  }

  /** Set one issue's state (close/reopen) and return the updated entry. */
  private async setIssueState(
    options: { readonly project?: string; readonly number: number; readonly signal?: AbortSignal },
    state: 'open' | 'closed',
    path: string,
  ): Promise<GiteaEntry> {
    await this.patch(path, { state })
    const raw = await this.get<RawEntry>(path, options.signal === undefined ? {} : { signal: options.signal })
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
  }): Promise<GiteaEntry> {
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
  }): Promise<GiteaEntry> {
    const [owner, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    await this.post(`/repos/${owner}/${repo}/pulls/${options.number}/merge`, {}, options.signal)
    const raw = await this.get<RawEntry>(
      `/repos/${owner}/${repo}/pulls/${options.number}`,
      options.signal === undefined ? {} : { signal: options.signal },
    )
    return mapEntry({ ...raw, state: 'merged' })
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
  }): Promise<GiteaEntry> {
    const [owner, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    const path = `/repos/${owner}/${repo}/pulls/${options.number}`
    await this.patch(path, { state: 'closed' })
    const raw = await this.get<RawEntry>(path, options.signal === undefined ? {} : { signal: options.signal })
    return mapEntry(raw)
  }

  /**
   * List releases of one repository.
   * @param options - project (site default when omitted), page size, cancellation.
   * @returns release summaries.
   */
  async listReleases(options: {
    readonly project?: string
    readonly perPage?: number
    readonly signal?: AbortSignal
  }): Promise<Array<{ id: number; tag: string; name: string; webUrl: string; draft: boolean; prerelease: boolean }>> {
    const [owner, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    const raw = await this.get<Array<{
      id: number; tag_name: string; name: string | null; html_url: string; draft: boolean; prerelease: boolean
    }>>(`/repos/${owner}/${repo}/releases`, {
      params: { limit: giteaLimit(options.perPage) },
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    return raw.map(release => ({
      id: release.id,
      tag: release.tag_name,
      name: release.name ?? release.tag_name,
      webUrl: release.html_url,
      draft: release.draft,
      prerelease: release.prerelease,
    }))
  }

  /**
   * Create a release for one tag (write operation).
   * @param options - project (site default when omitted), tag, optional name/body/flags, cancellation.
   * @returns the created release summary.
   */
  async createRelease(options: {
    readonly project?: string
    readonly tagName: string
    readonly name?: string
    readonly body?: string
    readonly draft?: boolean
    readonly prerelease?: boolean
    readonly signal?: AbortSignal
  }): Promise<{ id: number; tag: string; name: string; webUrl: string; draft: boolean; prerelease: boolean }> {
    const [owner, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    const raw = await this.post<{
      id: number; tag_name: string; name: string | null; html_url: string; draft: boolean; prerelease: boolean
    }>(`/repos/${owner}/${repo}/releases`, {
      tag_name: options.tagName,
      ...options.name === undefined ? {} : { name: options.name },
      ...options.body === undefined ? {} : { body: options.body },
      ...options.draft === undefined ? {} : { draft: options.draft },
      ...options.prerelease === undefined ? {} : { prerelease: options.prerelease },
    }, options.signal)
    return {
      id: raw.id,
      tag: raw.tag_name,
      name: raw.name ?? raw.tag_name,
      webUrl: raw.html_url,
      draft: raw.draft,
      prerelease: raw.prerelease,
    }
  }

  /**
   * Delete a release by its release id (write operation).
   * @param options - project (site default when omitted), release id, cancellation.
   * @returns a stub summary of the deleted release.
   */
  async deleteRelease(options: {
    readonly project?: string
    readonly number: number
    readonly signal?: AbortSignal
  }): Promise<{ id: number; tag: string; name: string; webUrl: string; draft: boolean; prerelease: boolean }> {
    const [owner, repo] = splitProject(this.site.id, this.resolveProject(options.project))
    await this.del(`/repos/${owner}/${repo}/releases/${options.number}`, options.signal)
    return { id: options.number, tag: '', name: 'deleted', webUrl: '', draft: false, prerelease: false }
  }

  /** One authenticated DELETE against the Gitea API. */
  private async del(path: string, signal?: AbortSignal): Promise<void> {
    const token = tokenFor(this.tokens, this.site)
    const url = new URL(path, `${this.site.baseUrl.replace(/\/+$/, '')}/`)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'DELETE',
        headers: { 'Authorization': `token ${token}`, 'Accept': 'application/json', 'User-Agent': 'dsh-git-credentials' },
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
  }

  /** One authenticated PATCH against the Gitea API. */
  private async patch<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const token = tokenFor(this.tokens, this.site)
    const url = new URL(path, `${this.site.baseUrl.replace(/\/+$/, '')}/`)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'PATCH',
        headers: {
          'Authorization': `token ${token}`,
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

  /** One authenticated POST against the Gitea API. */
  private async post<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const token = tokenFor(this.tokens, this.site)
    const url = new URL(path, `${this.site.baseUrl.replace(/\/+$/, '')}/`)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `token ${token}`,
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
  private async defaultBranch(owner: string, repo: string, signal?: AbortSignal): Promise<string> {
    const raw = await this.get<{ readonly default_branch: string }>(
      `/repos/${owner}/${repo}`,
      signal === undefined ? {} : { signal },
    )
    return raw.default_branch
  }

  /** One authenticated GET against the Gitea API. */
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
          'Authorization': `token ${token}`,
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

/** Clamp a page size into the range Gitea accepts (limit is capped at 50). */
function giteaLimit(requested: number | undefined): string {
  const size = Number(pageSize(requested))
  return String(Math.min(size, MAX_LIMIT))
}

/** Map one raw repository to the canonical summary. */
function mapRepo(repo: RawRepo): GiteaRepo {
  return {
    id: repo.id,
    path: repo.full_name,
    name: repo.name,
    webUrl: repo.html_url,
    visibility: repo.private ? 'private' : 'public',
  }
}

/** Map one raw issue/PR entry to the canonical summary. */
function mapEntry(entry: RawEntry): GiteaEntry {
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
