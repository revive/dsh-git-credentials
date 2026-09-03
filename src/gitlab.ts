/**
 * GitLab REST API client for the gitlab plugin: one configured site per
 * client, token values taken from the plugin's own encrypted store snapshot.
 * The token value enters only the request header this module sends — never
 * a tool argument, a canonical value, an error message, or a log line.
 * @module gitlab-client
 */

import { errorDetail, errorMessage, pageSize, tokenFor, type AuthedSite } from './http.ts'

/** A project summary as GitLab's `/projects` endpoint returns it. */
export interface GitLabProject {
  readonly id: number
  readonly path: string
  readonly name: string
  readonly webUrl: string
  readonly visibility: string
}

/** One merge request or issue list entry. */
export interface GitLabListEntry {
  readonly iid: number
  readonly title: string
  readonly state: string
  readonly webUrl: string
  readonly authorName: string
}

/** A repository file read through the GitLab API. */
export interface GitLabFile {
  readonly path: string
  readonly ref: string
  readonly content: string
  readonly truncated: boolean
}

/** Merge-request states GitLab accepts. */
export type MergeRequestState = 'opened' | 'closed' | 'all' | 'merged'

/** Issue states GitLab accepts. */
export type IssueState = 'opened' | 'closed' | 'all'

/** Raw `/projects` entry; field names are GitLab's snake_case. */
interface RawProject {
  readonly id: number
  readonly path: string
  readonly name: string
  readonly web_url: string
  readonly visibility: string
}

/** Raw `/merge_requests` and `/issues` entry. */
interface RawListEntry {
  readonly iid: number
  readonly title: string
  readonly state: string
  readonly web_url: string
  readonly author: { readonly name: string } | null
}

/**
 * Authenticated GitLab REST API client. One instance per call, built from
 * one store snapshot — one operation, one decrypted state.
 */
export class GitLabClient {
  constructor(
    private readonly tokens: Readonly<Record<string, string>>,
    readonly site: AuthedSite,
  ) {}

  /** The operation snapshot's token for this site; fails loud when unconfigured. */
  private token(): string {
    return tokenFor(this.tokens, this.site)
  }

  /**
   * List projects, optionally filtered by name search and membership.
   * @param options - search text, membership filter, page size, cancellation.
   * @returns project summaries.
   */
  async listRepos(options: {
    readonly search?: string
    readonly membership?: boolean
    readonly perPage?: number
    readonly signal?: AbortSignal
  }): Promise<GitLabProject[]> {
    const raw = await this.get<RawProject[]>('/projects', {
      params: {
        search: options.search,
        membership: options.membership === true ? 'true' : undefined,
        per_page: pageSize(options.perPage),
      },
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    return raw.map(project => ({
      id: project.id,
      path: project.path,
      name: project.name,
      webUrl: project.web_url,
      visibility: project.visibility,
    }))
  }

  /**
   * Read one repository file at a ref; the project's default branch when the
   * ref is omitted. Content beyond `maxBytes` is cut and flagged.
   * @param options - project, file path, ref, byte cap, cancellation.
   * @returns the decoded file content.
   */
  async readFile(options: {
    readonly project: string
    readonly path: string
    readonly ref?: string
    readonly maxBytes: number
    readonly signal?: AbortSignal
  }): Promise<GitLabFile> {
    const ref = options.ref ?? (await this.defaultBranch(options.project, options.signal))
    const raw = await this.get<{ readonly content: string }>(
      `/projects/${encodeURIComponent(options.project)}/repository/files/${encodeURIComponent(options.path)}`,
      { params: { ref }, ...options.signal === undefined ? {} : { signal: options.signal } },
    )
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
   * List merge requests of one project.
   * @param options - project (site default when omitted), state, page size, cancellation.
   * @returns merge-request summaries.
   */
  async listPullRequests(options: {
    readonly project?: string
    readonly state?: MergeRequestState
    readonly perPage?: number
    readonly signal?: AbortSignal
  }): Promise<GitLabListEntry[]> {
    return this.listEntries(
      '/merge_requests', options.project, options.state ?? 'opened', options.perPage, options.signal,
    )
  }

  /**
   * List issues of one project.
   * @param options - project (site default when omitted), state, page size, cancellation.
   * @returns issue summaries.
   */
  async listIssues(options: {
    readonly project?: string
    readonly state?: IssueState
    readonly perPage?: number
    readonly signal?: AbortSignal
  }): Promise<GitLabListEntry[]> {
    return this.listEntries('/issues', options.project, options.state ?? 'opened', options.perPage, options.signal)
  }

  /** Shared listing path for merge requests and issues. */
  private async listEntries(
    suffix: '/merge_requests' | '/issues',
    projectArg: string | undefined,
    state: string,
    perPage: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<GitLabListEntry[]> {
    const project = this.resolveProject(projectArg)
    const raw = await this.get<RawListEntry[]>(`/projects/${encodeURIComponent(project)}${suffix}`, {
      params: { state, per_page: pageSize(perPage) },
      ...signal === undefined ? {} : { signal },
    })
    return raw.map(entry => ({
      iid: entry.iid,
      title: entry.title,
      state: entry.state,
      webUrl: entry.web_url,
      authorName: entry.author?.name ?? 'unknown',
    }))
  }

  /** The project's default branch name. */
  private async defaultBranch(project: string, signal?: AbortSignal): Promise<string> {
    const raw = await this.get<{ readonly default_branch: string }>(
      `/projects/${encodeURIComponent(project)}`,
      signal === undefined ? {} : { signal },
    )
    return raw.default_branch
  }

  /**
   * Create an issue in one project (write operation).
   * @param options - project, title, optional body, cancellation.
   * @returns the created issue summary (canonical entry shape).
   */
  async createIssue(options: {
    readonly project?: string
    readonly title: string
    readonly body?: string
    readonly signal?: AbortSignal
  }): Promise<GitLabListEntry> {
    const raw = await this.post<RawListEntry>(
      `/projects/${encodeURIComponent(this.resolveProject(options.project))}/issues`,
      { title: options.title, ...options.body === undefined ? {} : { description: options.body } },
      options.signal,
    )
    return mapEntry(raw)
  }

  /**
   * Create a merge request in one project (write operation).
   * @param options - project (site default when omitted), branches, title, body, cancellation.
   * @returns the created merge-request summary (canonical entry shape).
   */
  async createPullRequest(options: {
    readonly project?: string
    readonly title: string
    readonly sourceBranch: string
    readonly targetBranch: string
    readonly body?: string
    readonly signal?: AbortSignal
  }): Promise<GitLabListEntry> {
    const project = this.resolveProject(options.project)
    const raw = await this.post<RawListEntry>(
      `/projects/${encodeURIComponent(project)}/merge_requests`,
      {
        title: options.title,
        source_branch: options.sourceBranch,
        target_branch: options.targetBranch,
        ...options.body === undefined ? {} : { description: options.body },
      },
      options.signal,
    )
    return mapEntry(raw)
  }

  /**
   * Create a project under the token owner (write operation).
   * @param options - name, optional path/description/visibility, cancellation.
   * @returns the created project summary (canonical project shape).
   */
  async createRepo(options: {
    readonly name: string
    readonly path?: string
    readonly description?: string
    readonly visibility?: 'private' | 'internal' | 'public'
    readonly signal?: AbortSignal
  }): Promise<GitLabProject> {
    const raw = await this.post<RawProject>(
      '/projects',
      {
        name: options.name,
        ...options.path === undefined ? {} : { path: options.path },
        ...options.description === undefined ? {} : { description: options.description },
        ...options.visibility === undefined ? {} : { visibility: options.visibility },
      },
      options.signal,
    )
    return mapProject(raw)
  }

  /**
   * Close an issue (write operation).
   * @param options - project, issue iid, cancellation.
   * @returns the updated issue summary.
   */
  async closeIssue(options: {
    readonly project?: string
    readonly number: number
    readonly signal?: AbortSignal
  }): Promise<GitLabListEntry> {
    return this.setIssueState(options, 'close')
  }

  /**
   * Reopen an issue (write operation).
   * @param options - project, issue iid, cancellation.
   * @returns the updated issue summary.
   */
  async reopenIssue(options: {
    readonly project?: string
    readonly number: number
    readonly signal?: AbortSignal
  }): Promise<GitLabListEntry> {
    return this.setIssueState(options, 'reopen')
  }

  /** Set one issue's state (close/reopen) and return the updated entry. */
  private async setIssueState(
    options: { readonly project?: string; readonly number: number; readonly signal?: AbortSignal },
    stateEvent: 'close' | 'reopen',
  ): Promise<GitLabListEntry> {
    const project = encodeURIComponent(this.resolveProject(options.project))
    await this.put(`/projects/${project}/issues/${options.number}`, { state_event: stateEvent })
    const raw = await this.get<RawListEntry>(
      `/projects/${project}/issues/${options.number}`,
      options.signal === undefined ? {} : { signal: options.signal },
    )
    return mapEntry(raw)
  }

  /**
   * Comment on an issue (write operation).
   * @param options - project, issue iid, comment body, cancellation.
   * @returns a comment-shaped entry (`state: "comment"`, title = comment body).
   */
  async commentIssue(options: {
    readonly project?: string
    readonly number: number
    readonly body: string
    readonly signal?: AbortSignal
  }): Promise<GitLabListEntry> {
    const project = encodeURIComponent(this.resolveProject(options.project))
    const raw = await this.post<{ id: number; body: string; author: { readonly name: string } | null }>(
      `/projects/${project}/issues/${options.number}/notes`,
      { body: options.body },
      options.signal,
    )
    return {
      iid: options.number,
      title: options.body,
      state: 'comment',
      webUrl: `${this.site.baseUrl.replace(/\/+$/, '')}/${options.project}/-/issues/${options.number}#note_${raw.id}`,
      authorName: raw.author?.name ?? 'unknown',
    }
  }

  /**
   * Merge a merge request (write operation).
   * @param options - project (site default when omitted), MR iid, cancellation.
   * @returns the merged merge-request summary.
   */
  async mergePull(options: {
    readonly project?: string
    readonly number: number
    readonly signal?: AbortSignal
  }): Promise<GitLabListEntry> {
    const project = encodeURIComponent(this.resolveProject(options.project))
    const raw = await this.put<RawListEntry>(
      `/projects/${project}/merge_requests/${options.number}/merge`,
      {},
      options.signal,
    )
    return mapEntry(raw)
  }

  /**
   * Close a merge request without merging (write operation).
   * @param options - project (site default when omitted), MR iid, cancellation.
   * @returns the closed merge-request summary.
   */
  async closePull(options: {
    readonly project?: string
    readonly number: number
    readonly signal?: AbortSignal
  }): Promise<GitLabListEntry> {
    const project = encodeURIComponent(this.resolveProject(options.project))
    await this.put(`/projects/${project}/merge_requests/${options.number}`, { state_event: 'close' })
    const raw = await this.get<RawListEntry>(
      `/projects/${project}/merge_requests/${options.number}`,
      options.signal === undefined ? {} : { signal: options.signal },
    )
    return mapEntry(raw)
  }

  /**
   * List releases of one project (GitLab keys releases by tag name).
   * @param options - project (site default when omitted), page size, cancellation.
   * @returns release summaries (id omitted — GitLab has no numeric release id).
   */
  async listReleases(options: {
    readonly project?: string
    readonly perPage?: number
    readonly signal?: AbortSignal
  }): Promise<Array<{ tag: string; name: string; webUrl: string; draft: boolean; prerelease: boolean }>> {
    const project = this.resolveProject(options.project)
    const raw = await this.get<Array<{ tag_name: string; name: string | null }>>(
      `/projects/${encodeURIComponent(project)}/releases`,
      {
        params: { per_page: pageSize(options.perPage) },
        ...options.signal === undefined ? {} : { signal: options.signal },
      },
    )
    return raw.map(release => ({
      tag: release.tag_name,
      name: release.name ?? release.tag_name,
      webUrl: `${this.site.baseUrl.replace(/\/+$/, '')}/${project}/-/releases/${encodeURIComponent(release.tag_name)}`,
      draft: false,
      prerelease: false,
    }))
  }

  /**
   * Create a release for one tag (write operation).
   * @param options - project (site default when omitted), tag, optional name/body, cancellation.
   * @returns the created release summary.
   */
  async createRelease(options: {
    readonly project?: string
    readonly tagName: string
    readonly name?: string
    readonly body?: string
    readonly signal?: AbortSignal
  }): Promise<{ tag: string; name: string; webUrl: string; draft: boolean; prerelease: boolean }> {
    const project = this.resolveProject(options.project)
    const raw = await this.post<{ tag_name: string; name: string | null }>(
      `/projects/${encodeURIComponent(project)}/releases`,
      {
        tag_name: options.tagName,
        ...options.name === undefined ? {} : { name: options.name },
        ...options.body === undefined ? {} : { description: options.body },
      },
      options.signal,
    )
    return {
      tag: raw.tag_name,
      name: raw.name ?? raw.tag_name,
      webUrl: `${this.site.baseUrl.replace(/\/+$/, '')}/${project}/-/releases/${encodeURIComponent(raw.tag_name)}`,
      draft: false,
      prerelease: false,
    }
  }

  /**
   * Delete a release by its tag name (write operation).
   * @param options - project (site default when omitted), tag, cancellation.
   * @returns a stub summary of the deleted release.
   */
  async deleteRelease(options: {
    readonly project?: string
    readonly tag: string
    readonly signal?: AbortSignal
  }): Promise<{ tag: string; name: string; webUrl: string; draft: boolean; prerelease: boolean }> {
    const project = this.resolveProject(options.project)
    await this.del(`/projects/${encodeURIComponent(project)}/releases/${encodeURIComponent(options.tag)}`, options.signal)
    return { tag: options.tag, name: 'deleted', webUrl: '', draft: false, prerelease: false }
  }

  /** One authenticated DELETE against the GitLab REST API. */
  private async del(path: string, signal?: AbortSignal): Promise<void> {
    const token = this.token()
    const url = new URL(`/api/v4${path}`, this.site.baseUrl)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'DELETE',
        headers: { 'PRIVATE-TOKEN': token },
        ...signal === undefined ? {} : { signal },
      })
    } catch (error) {
      throw new Error(`GitLab site "${this.site.id}": request to ${path} failed: ${errorMessage(error)}`)
    }
    if (!response.ok) {
      const detail = await errorDetail(response)
      const hint = response.status === 401
        ? ` — the ${this.site.tokenRef} token is invalid or expired; rotate it in Settings → Git 凭据`
        : ''
      throw new Error(`GitLab site "${this.site.id}": ${path} returned ${response.status} ${detail}${hint}`)
    }
  }

  /** One authenticated PUT against the GitLab REST API. */
  private async put<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const token = this.token()
    const url = new URL(`/api/v4${path}`, this.site.baseUrl)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers: { 'PRIVATE-TOKEN': token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error) {
      throw new Error(`GitLab site "${this.site.id}": request to ${path} failed: ${errorMessage(error)}`)
    }
    if (!response.ok) {
      const detail = await errorDetail(response)
      const hint = response.status === 401
        ? ` — the ${this.site.tokenRef} token is invalid or expired; rotate it in Settings → Git 凭据`
        : ''
      throw new Error(`GitLab site "${this.site.id}": ${path} returned ${response.status} ${detail}${hint}`)
    }
    return (await response.json()) as T
  }

  /** One authenticated POST against the GitLab REST API. */
  private async post<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const token = this.token()
    const url = new URL(`/api/v4${path}`, this.site.baseUrl)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'PRIVATE-TOKEN': token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error) {
      throw new Error(`GitLab site "${this.site.id}": request to ${path} failed: ${errorMessage(error)}`)
    }
    if (!response.ok) {
      const detail = await errorDetail(response)
      const hint = response.status === 401
        ? ` — the ${this.site.tokenRef} token is invalid or expired; rotate it in Settings → Git 凭据`
        : ''
      throw new Error(`GitLab site "${this.site.id}": ${path} returned ${response.status} ${detail}${hint}`)
    }
    return (await response.json()) as T
  }

  /** One authenticated GET against the GitLab REST API. */
  private async get<T>(path: string, options: {
    readonly params?: Record<string, string | undefined>
    readonly signal?: AbortSignal
  }): Promise<T> {
    const token = this.token()
    const url = new URL(`/api/v4${path}`, this.site.baseUrl)
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value)
    }
    let response: Response
    try {
      response = await fetch(url, {
        headers: { 'PRIVATE-TOKEN': token },
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
    } catch (error) {
      throw new Error(`GitLab site "${this.site.id}": request to ${path} failed: ${errorMessage(error)}`)
    }
    if (!response.ok) {
      const detail = await errorDetail(response)
      const hint = response.status === 401
        ? ` — the ${this.site.tokenRef} token is invalid or expired; rotate it in Settings → Git 凭据`
        : ''
      throw new Error(`GitLab site "${this.site.id}": ${path} returned ${response.status} ${detail}${hint}`)
    }
    return (await response.json()) as T
  }

  /** The project to list; explicit argument wins, then the site default; otherwise fail loud. */
  private resolveProject(project: string | undefined): string {
    if (project !== undefined) return project
    if (this.site.defaultProject !== undefined) return this.site.defaultProject
    throw new Error(
      `GitLab site "${this.site.id}": a project argument is required when the site declares no defaultProject`,
    )
  }
}



/** Map one raw project to the canonical summary; POST /projects reports path_with_namespace. */
function mapProject(project: RawProject & { readonly path_with_namespace?: string }): GitLabProject {
  return {
    id: project.id,
    path: project.path_with_namespace ?? project.path,
    name: project.name,
    webUrl: project.web_url,
    visibility: project.visibility,
  }
}

/** Map one raw issue/MR entry to the canonical summary. */
function mapEntry(entry: RawListEntry): GitLabListEntry {
  return {
    iid: entry.iid,
    title: entry.title,
    state: entry.state,
    webUrl: entry.web_url,
    authorName: entry.author?.name ?? 'unknown',
  }
}
