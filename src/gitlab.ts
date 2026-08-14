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
  async listProjects(options: {
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
  async listMergeRequests(options: {
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


