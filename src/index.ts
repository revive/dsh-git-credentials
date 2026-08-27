/**
 * The git-credentials plugin: model-facing GitLab, GitHub, Gitee, Gitea, and
 * Bitbucket tools whose tokens never enter the model context. Sites and
 * token values live in the plugin's own encrypted store (AES-256-GCM,
 * separate key file), managed from the Settings → Git 凭据 page through the
 * plugin's own admin routes. Each tool call reads one decrypted snapshot, so
 * editing a site or rotating a token reaches the next call without a
 * restart. The plugin is a pure out-of-tree bolt-on: it uses no product wire
 * channel and mounts/unmounts dynamically through the home-level patch
 * layer.
 * @module dsh-git-credentials
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool, type GenericCallView } from '@deepseek-ai/dsh-tools'
import { GitLabClient, type GitLabFile, type GitLabListEntry, type GitLabProject } from './gitlab.ts'
import { GitHubClient, type GitHubEntry, type GitHubFile, type GitHubRepo } from './github.ts'
import { GiteeClient } from './gitee.ts'
import { GiteaClient } from './gitea.ts'
import { BitbucketClient } from './bitbucket.ts'
import { GitStore, refOf, type ForgeProvider } from './store.ts'
import { registerGitLabAdmin } from './admin.ts'

export const name = 'git-credentials'

/** Plugin configuration: storage paths (defaults under $DSH_HOME) and the file-read cap. */
export interface PluginConfig {
  dataPath?: string
  keyPath?: string
  fileReadMaxBytes: number
}

export const Config: Schema<PluginConfig> = Schema.object({
  dataPath: Schema.string(),
  keyPath: Schema.string(),
  fileReadMaxBytes: Schema.number().min(1024).default(256 * 1024),
})

export const inject = ['tools']

/** Shared `site` parameter: sites are runtime-managed, so the id set is live. */
const siteParameter = {
  type: 'string',
  description: 'Which configured site to call (ids are managed in Settings → Git 凭据).',
} as const

/** Canonical shape of one repository/project summary (both providers). */
const repoSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    path: { type: 'string' },
    name: { type: 'string' },
    webUrl: { type: 'string' },
    visibility: { type: 'string' },
  },
  additionalProperties: false,
} as const

/** Canonical shape of one GitLab merge-request or issue summary. */
const listEntrySchema = {
  type: 'object',
  properties: {
    iid: { type: 'integer' },
    title: { type: 'string' },
    state: { type: 'string' },
    webUrl: { type: 'string' },
    authorName: { type: 'string' },
  },
  additionalProperties: false,
} as const

/** Canonical shape of one GitHub issue or pull-request summary. */
const githubEntrySchema = {
  type: 'object',
  properties: {
    number: { type: 'integer' },
    title: { type: 'string' },
    state: { type: 'string' },
    webUrl: { type: 'string' },
    authorName: { type: 'string' },
  },
  additionalProperties: false,
} as const

/** Canonical shape of one file read (both providers). */
const fileSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    ref: { type: 'string' },
    content: { type: 'string' },
    truncated: { type: 'boolean' },
  },
  additionalProperties: false,
} as const

/** Canonical shape of one created issue / merge-request / pull-request summary. */
const createdEntrySchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    title: { type: 'string' },
    webUrl: { type: 'string' },
  },
  additionalProperties: false,
} as const

/** Canonical shape of one created project / repository summary. */
const createdRepoSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    webUrl: { type: 'string' },
  },
  additionalProperties: false,
} as const

export function apply(ctx: Context, config: PluginConfig): void {
  const store = GitStore.create(config)

  // One operation, one decrypted snapshot: sites and tokens are read per
  // call, so Settings → Git 凭据 changes reach the next call immediately.
  // Tools are provider-scoped: a gitlab tool only sees gitlab sites.
  const clientFor = (siteArg: string | undefined, tool: string, provider: ForgeProvider):
    GitLabClient | GitHubClient | GiteeClient | GiteaClient | BitbucketClient => {
    const state = store.read()
    const candidates = Object.entries(state.sites).filter(([, site]) => site.provider === provider)
    const defaultSiteId = state.defaultSite
    const fallback = defaultSiteId !== undefined
      ? (state.sites[defaultSiteId]?.provider === provider ? defaultSiteId : undefined)
      : undefined
    const id = siteArg ?? (candidates.length === 1 ? candidates[0]![0] : undefined) ?? fallback
    if (id === undefined) {
      const hint = candidates.length === 0
        ? `no ${provider} site configured; add one in Settings → Git 凭据`
        : `no ${provider} site configured; add one in Settings → Git 凭据 (or pass a site argument)`
      throw new Error(`git-credentials: ${hint}`)
    }
    const site = state.sites[id]
    if (site === undefined || site.provider !== provider) {
      const ids = candidates.map(([candidateId]) => candidateId).join(', ') || '(none)'
      throw new Error(`git-credentials: unknown ${provider} site "${id}" for ${tool}; configured ${provider} sites: ${ids}`)
    }
    const base = {
      id,
      baseUrl: site.baseUrl,
      tokenRef: refOf(site.tokenRef),
      ...site.defaultProject === undefined ? {} : { defaultProject: site.defaultProject },
    }
    switch (site.provider) {
      case 'gitlab': return new GitLabClient(state.tokens, base)
      case 'github': return new GitHubClient(state.tokens, base)
      case 'gitee': return new GiteeClient(state.tokens, base)
      case 'gitea': return new GiteaClient(state.tokens, base)
      case 'bitbucket': return new BitbucketClient(state.tokens, base)
    }
  }
  const SITE_DESCRIPTION = ' Site ids are managed in Settings → Git 凭据.'

  ctx.logger('git-credentials').info('git-credentials plugin loaded')
  registerGitLabAdmin(ctx, { store })

  ctx.tools.register(defineTool({
    name: 'gitlab_projects',
    description: `List or search projects on GitLab (self-hosted or gitlab.com). Use when the user references a GitLab repository or project and you need its path (group/subgroup/project) — the token is injected per site and never enters the model context.${SITE_DESCRIPTION}`,
    parameters: {
      site: siteParameter,
      search: { type: 'string', description: 'Filter projects whose name or path contains this text.' },
      membership: { type: 'boolean', description: 'Only list projects the token owner belongs to.' },
      perPage: { type: 'integer', description: 'Maximum number of projects to return (1-100).' },
    },
    output: {
      schema: { type: 'array', items: repoSchema },
      render: (_args, projects: GitLabProject[]) => projects.length === 0
        ? [{ type: 'text', text: 'No projects found.' }]
        : [{
          type: 'text',
          text: projects.map(project => `${project.path} (${project.visibility}) — ${project.webUrl}`).join('\n'),
        }],
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `GitLab projects${args.search === undefined ? '' : ` matching ${args.search}`}`,
        kind: 'search',
      }
    },
    async execute(args, exec) {
      const client = clientFor(args.site, 'gitlab_projects', 'gitlab') as GitLabClient
      return client.listProjects({ ...args, signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gitlab_file',
    description: `Read one file from a GitLab project. Use whenever an answer may live in a GitLab repository the user mentions — the token is injected automatically and never appears in the model context.${SITE_DESCRIPTION}`,
    parameters: {
      site: siteParameter,
      project: {
        type: 'string', required: true,
        description: 'Project path on GitLab, e.g. group/subgroup/project.',
      },
      path: {
        type: 'string', required: true,
        description: 'File path within the repository, e.g. src/index.ts.',
      },
      ref: {
        type: 'string',
        description: 'Branch or tag to read from; defaults to the project default branch.',
      },
    },
    output: {
      schema: fileSchema,
      render: (_args, file: GitLabFile) => [
        { type: 'text', text: file.truncated ? `(truncated) ${file.path}@${file.ref}` : `${file.path}@${file.ref}` },
        { type: 'text', text: file.content },
      ],
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Read ${args.path}@${args.ref ?? 'default branch'} in ${args.project}`,
        kind: 'read',
      }
    },
    async execute(args, exec) {
      const client = clientFor(args.site, 'gitlab_file', 'gitlab') as GitLabClient
      return client.readFile({ ...args, maxBytes: config.fileReadMaxBytes, signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gitlab_merge_requests',
    description: `List merge requests of a GitLab project. Use when the user references an MR, a code review, or asks about open/merged changes — the token is injected per site.${SITE_DESCRIPTION}`,
    parameters: {
      site: siteParameter,
      project: {
        type: 'string',
        description: 'Project path; defaults to the site defaultProject when configured.',
      },
      state: {
        type: 'string', enum: ['opened', 'closed', 'all', 'merged'],
        description: 'Filter by state; defaults to opened.',
      },
      perPage: { type: 'integer', description: 'Maximum number of entries to return (1-100).' },
    },
    output: {
      schema: { type: 'array', items: listEntrySchema },
      render: (_args, entries: GitLabListEntry[]) => entries.length === 0
        ? [{ type: 'text', text: 'No merge requests found.' }]
        : [{
          type: 'text',
          text: entries.map(entry => `!${entry.iid} [${entry.state}] ${entry.title} — ${entry.authorName} — ${entry.webUrl}`)
            .join('\n'),
        }],
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Merge requests of ${args.project ?? 'default project'}`,
        kind: 'search',
      }
    },
    async execute(args, exec) {
      const client = clientFor(args.site, 'gitlab_merge_requests', 'gitlab') as GitLabClient
      return client.listMergeRequests({ ...args, signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gitlab_issues',
    description: `List issues of a GitLab project. Use when the user references a GitLab issue or asks about open issues — the token is injected per site.${SITE_DESCRIPTION}`,
    parameters: {
      site: siteParameter,
      project: {
        type: 'string',
        description: 'Project path; defaults to the site defaultProject when configured.',
      },
      state: {
        type: 'string', enum: ['opened', 'closed', 'all'],
        description: 'Filter by state; defaults to opened.',
      },
      perPage: { type: 'integer', description: 'Maximum number of entries to return (1-100).' },
    },
    output: {
      schema: { type: 'array', items: listEntrySchema },
      render: (_args, entries: GitLabListEntry[]) => entries.length === 0
        ? [{ type: 'text', text: 'No issues found.' }]
        : [{
          type: 'text',
          text: entries.map(entry => `#${entry.iid} [${entry.state}] ${entry.title} — ${entry.authorName} — ${entry.webUrl}`)
            .join('\n'),
        }],
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Issues of ${args.project ?? 'default project'}`,
        kind: 'search',
      }
    },
    async execute(args, exec) {
      const client = clientFor(args.site, 'gitlab_issues', 'gitlab') as GitLabClient
      return client.listIssues({ ...args, signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gitlab_create_issue',
    description: `Create an issue in a GitLab project (write operation). Use when the user asks to file a new issue — the token is injected per site.${SITE_DESCRIPTION}`,
    parameters: {
      site: siteParameter,
      project: {
        type: 'string', required: true,
        description: 'Project path on GitLab, e.g. group/subgroup/project.',
      },
      title: { type: 'string', required: true, description: 'Issue title.' },
      body: { type: 'string', description: 'Issue description (Markdown).' },
    },
    output: {
      schema: createdEntrySchema,
      render: (_args, created: { id: number; title: string; webUrl: string }) => [
        { type: 'text', text: `Created issue #${created.id}: ${created.title} — ${created.webUrl}` },
      ],
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Create issue in ${args.project}`, kind: 'edit' }
    },
    async execute(args, exec) {
      const client = clientFor(args.site, 'gitlab_create_issue', 'gitlab') as GitLabClient
      return client.createIssue({ ...args, signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gitlab_create_merge_request',
    description: `Create a merge request in a GitLab project (write operation). Use when the user asks to open an MR — the token is injected per site.${SITE_DESCRIPTION}`,
    parameters: {
      site: siteParameter,
      project: {
        type: 'string',
        description: 'Project path; defaults to the site defaultProject when configured.',
      },
      title: { type: 'string', required: true, description: 'Merge-request title.' },
      sourceBranch: { type: 'string', required: true, description: 'Source branch (the changes).' },
      targetBranch: { type: 'string', required: true, description: 'Target branch (often main or master).' },
      body: { type: 'string', description: 'Merge-request description (Markdown).' },
    },
    output: {
      schema: createdEntrySchema,
      render: (_args, created: { id: number; title: string; webUrl: string }) => [
        { type: 'text', text: `Created merge request !${created.id}: ${created.title} — ${created.webUrl}` },
      ],
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Create merge request in ${args.project ?? 'default project'}`,
        kind: 'edit',
      }
    },
    async execute(args, exec) {
      const client = clientFor(args.site, 'gitlab_create_merge_request', 'gitlab') as GitLabClient
      return client.createMergeRequest({ ...args, signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gitlab_create_project',
    description: `Create a project on GitLab (write operation). Use when the user asks to create a new repository or project — the token is injected per site.${SITE_DESCRIPTION}`,
    parameters: {
      site: siteParameter,
      name: { type: 'string', required: true, description: 'Project name.' },
      path: { type: 'string', description: 'Project path (defaults to the name).' },
      description: { type: 'string', description: 'Project description.' },
      visibility: {
        type: 'string', enum: ['private', 'internal', 'public'],
        description: 'Visibility; defaults to the instance default.',
      },
    },
    output: {
      schema: createdRepoSchema,
      render: (_args, created: { path: string; webUrl: string }) => [
        { type: 'text', text: `Created project ${created.path} — ${created.webUrl}` },
      ],
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Create GitLab project ${args.name}`, kind: 'edit' }
    },
    async execute(args, exec) {
      const client = clientFor(args.site, 'gitlab_create_project', 'gitlab') as GitLabClient
      return client.createProject({ ...args, signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'github_repos',
    description: `List or search GitHub repositories. Use to discover or locate a repository (owner/repo) by name before reading files or listing issues/PRs from it — the token is injected per site.${SITE_DESCRIPTION}`,
    parameters: {
      site: siteParameter,
      search: { type: 'string', description: 'Filter repositories by name.' },
      perPage: { type: 'integer', description: 'Maximum number of repositories to return (1-100).' },
    },
    output: {
      schema: { type: 'array', items: repoSchema },
      render: (_args, repos: GitHubRepo[]) => repos.length === 0
        ? [{ type: 'text', text: 'No repositories found.' }]
        : [{
          type: 'text',
          text: repos.map(repo => `${repo.path} (${repo.visibility}) — ${repo.webUrl}`).join('\n'),
        }],
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `GitHub repositories${args.search === undefined ? '' : ` matching ${args.search}`}`,
        kind: 'search',
      }
    },
    async execute(args, exec) {
      const client = clientFor(args.site, 'github_repos', 'github') as GitHubClient
      return client.listRepos({ ...args, signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'github_file',
    description: `Read one file from a GitHub repository the token can access (public or private). Use whenever an answer may live in a GitHub repo the user mentions — the token is injected automatically and never enters the model context.${SITE_DESCRIPTION}`,
    parameters: {
      site: siteParameter,
      project: {
        type: 'string', required: true,
        description: 'Repository on GitHub, e.g. owner/repo.',
      },
      path: {
        type: 'string', required: true,
        description: 'File path within the repository, e.g. src/index.ts.',
      },
      ref: {
        type: 'string',
        description: 'Branch or tag to read from; defaults to the repository default branch.',
      },
    },
    output: {
      schema: fileSchema,
      render: (_args, file: GitHubFile) => [
        { type: 'text', text: file.truncated ? `(truncated) ${file.path}@${file.ref}` : `${file.path}@${file.ref}` },
        { type: 'text', text: file.content },
      ],
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Read ${args.path}@${args.ref ?? 'default branch'} in ${args.project}`,
        kind: 'read',
      }
    },
    async execute(args, exec) {
      const client = clientFor(args.site, 'github_file', 'github') as GitHubClient
      return client.readFile({ ...args, maxBytes: config.fileReadMaxBytes, signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'github_issues',
    description: `List issues of a GitHub repository (pull requests excluded). Use when the user references a GitHub issue or wants open issues — the token is injected per site.${SITE_DESCRIPTION}`,
    parameters: {
      site: siteParameter,
      project: {
        type: 'string',
        description: 'Repository on GitHub, e.g. owner/repo; defaults to the site defaultProject when configured.',
      },
      state: {
        type: 'string', enum: ['open', 'closed', 'all'],
        description: 'Filter by state; defaults to open.',
      },
      perPage: { type: 'integer', description: 'Maximum number of entries to return (1-100).' },
    },
    output: {
      schema: { type: 'array', items: githubEntrySchema },
      render: (_args, entries: GitHubEntry[]) => entries.length === 0
        ? [{ type: 'text', text: 'No issues found.' }]
        : [{
          type: 'text',
          text: entries.map(entry => `#${entry.number} [${entry.state}] ${entry.title} — ${entry.authorName} — ${entry.webUrl}`)
            .join('\n'),
        }],
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Issues of ${args.project ?? 'default project'}`,
        kind: 'search',
      }
    },
    async execute(args, exec) {
      const client = clientFor(args.site, 'github_issues', 'github') as GitHubClient
      return client.listIssues({ ...args, signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'github_pull_requests',
    description: `List pull requests of a GitHub repository. Use when the user references a PR, a code review, or asks about open/closed PRs — the token is injected per site.${SITE_DESCRIPTION}`,
    parameters: {
      site: siteParameter,
      project: {
        type: 'string',
        description: 'Repository on GitHub, e.g. owner/repo; defaults to the site defaultProject when configured.',
      },
      state: {
        type: 'string', enum: ['open', 'closed', 'all'],
        description: 'Filter by state; defaults to open.',
      },
      perPage: { type: 'integer', description: 'Maximum number of entries to return (1-100).' },
    },
    output: {
      schema: { type: 'array', items: githubEntrySchema },
      render: (_args, entries: GitHubEntry[]) => entries.length === 0
        ? [{ type: 'text', text: 'No pull requests found.' }]
        : [{
          type: 'text',
          text: entries.map(entry => `#${entry.number} [${entry.state}] ${entry.title} — ${entry.authorName} — ${entry.webUrl}`)
            .join('\n'),
        }],
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Pull requests of ${args.project ?? 'default project'}`,
        kind: 'search',
      }
    },
    async execute(args, exec) {
      const client = clientFor(args.site, 'github_pull_requests', 'github') as GitHubClient
      return client.listPullRequests({ ...args, signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'github_create_issue',
    description: `Create an issue in a GitHub repository (write operation). Use when the user asks to file a new issue — the token is injected per site.${SITE_DESCRIPTION}`,
    parameters: {
      site: siteParameter,
      project: {
        type: 'string', required: true,
        description: 'Repository on GitHub, e.g. owner/repo.',
      },
      title: { type: 'string', required: true, description: 'Issue title.' },
      body: { type: 'string', description: 'Issue body (Markdown).' },
    },
    output: {
      schema: createdEntrySchema,
      render: (_args, created: { id: number; title: string; webUrl: string }) => [
        { type: 'text', text: `Created issue #${created.id}: ${created.title} — ${created.webUrl}` },
      ],
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Create issue in ${args.project}`, kind: 'edit' }
    },
    async execute(args, exec) {
      const client = clientFor(args.site, 'github_create_issue', 'github') as GitHubClient
      return client.createIssue({ ...args, signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'github_create_pull_request',
    description: `Create a pull request in a GitHub repository (write operation). Use when the user asks to open a PR — the token is injected per site.${SITE_DESCRIPTION}`,
    parameters: {
      site: siteParameter,
      project: {
        type: 'string',
        description: 'Repository on GitHub, e.g. owner/repo; defaults to the site defaultProject when configured.',
      },
      title: { type: 'string', required: true, description: 'Pull-request title.' },
      head: { type: 'string', required: true, description: 'Head branch (the changes).' },
      base: { type: 'string', required: true, description: 'Base branch (often main or master).' },
      body: { type: 'string', description: 'Pull-request body (Markdown).' },
    },
    output: {
      schema: createdEntrySchema,
      render: (_args, created: { id: number; title: string; webUrl: string }) => [
        { type: 'text', text: `Created pull request #${created.id}: ${created.title} — ${created.webUrl}` },
      ],
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Create pull request in ${args.project ?? 'default project'}`,
        kind: 'edit',
      }
    },
    async execute(args, exec) {
      const client = clientFor(args.site, 'github_create_pull_request', 'github') as GitHubClient
      return client.createPullRequest({ ...args, signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'github_create_repo',
    description: `Create a repository under the token owner on GitHub (write operation). Use when the user asks to create a new repository — the token is injected per site.${SITE_DESCRIPTION}`,
    parameters: {
      site: siteParameter,
      name: { type: 'string', required: true, description: 'Repository name.' },
      description: { type: 'string', description: 'Repository description.' },
      private: { type: 'boolean', description: 'Create a private repository; defaults to the account default.' },
    },
    output: {
      schema: createdRepoSchema,
      render: (_args, created: { path: string; webUrl: string }) => [
        { type: 'text', text: `Created repository ${created.path} — ${created.webUrl}` },
      ],
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Create GitHub repository ${args.name}`, kind: 'edit' }
    },
    async execute(args, exec) {
      const client = clientFor(args.site, 'github_create_repo', 'github') as GitHubClient
      return client.createRepo({ ...args, signal: exec.signal })
    },
  }))

  // Gitee, Gitea, and Bitbucket share one tool shape (repos / file / issues /
  // pull_requests) with per-provider naming and project vocabulary, so a
  // small factory registers all three providers' tools from the same
  // definitions. GitLab and GitHub above stay spelled out: their argument
  // sets (membership, iid vs number) differ from this uniform shape.
  interface ForgeClient {
    listRepos(options: {
      readonly search?: string
      readonly perPage?: number
      readonly signal?: AbortSignal
    }): Promise<Array<{ path: string; visibility: string; webUrl: string }>>
    readFile(options: {
      readonly project: string
      readonly path: string
      readonly ref?: string
      readonly maxBytes: number
      readonly signal?: AbortSignal
    }): Promise<{ path: string; ref: string; content: string; truncated: boolean }>
    listIssues(options: {
      readonly project?: string
      readonly state?: string
      readonly perPage?: number
      readonly signal?: AbortSignal
    }): Promise<Array<{ number: number; title: string; state: string; webUrl: string; authorName: string }>>
    listPullRequests(options: {
      readonly project?: string
      readonly state?: string
      readonly perPage?: number
      readonly signal?: AbortSignal
    }): Promise<Array<{ number: number; title: string; state: string; webUrl: string; authorName: string }>>
    createIssue(options: {
      readonly project?: string
      readonly title: string
      readonly body?: string
      readonly signal?: AbortSignal
    }): Promise<{ id: number; title: string; webUrl: string }>
    createPullRequest(options: {
      readonly project?: string
      readonly title: string
      readonly head: string
      readonly base: string
      readonly body?: string
      readonly signal?: AbortSignal
    }): Promise<{ id: number; title: string; webUrl: string }>
    createRepo(options: {
      readonly name: string
      readonly description?: string
      readonly private?: boolean
      readonly signal?: AbortSignal
    }): Promise<{ path: string; webUrl: string }>
  }

  const registerForgeTools = (
    prefix: 'gitee' | 'gitea' | 'bitbucket',
    provider: ForgeProvider,
    label: string,
    projectHint: string,
  ): void => {
    const named = (kind: string): string => `${prefix}_${kind}`
    const client = (args: { site?: string }, tool: string): ForgeClient =>
      clientFor(args.site, tool, provider) as unknown as ForgeClient

    ctx.tools.register(defineTool({
      name: named('repos'),
      description: `List or search repositories on ${label}. Use to locate a repository (${projectHint}) by name before reading files or listing issues/PRs from it — the token is injected per site.${SITE_DESCRIPTION}`,
      parameters: {
        site: siteParameter,
        search: { type: 'string', description: 'Filter repositories by name.' },
        perPage: { type: 'integer', description: 'Maximum number of repositories to return (1-100).' },
      },
      output: {
        schema: { type: 'array', items: repoSchema },
        render: (_args, repos: Array<{ path: string; visibility: string; webUrl: string }>) => repos.length === 0
          ? [{ type: 'text', text: 'No repositories found.' }]
          : [{
            type: 'text',
            text: repos.map(repo => `${repo.path} (${repo.visibility}) — ${repo.webUrl}`).join('\n'),
          }],
      },
      presentCall(args): GenericCallView {
        return {
          card: 'generic',
          title: `${label} repositories${args.search === undefined ? '' : ` matching ${args.search}`}`,
          kind: 'search',
        }
      },
      async execute(args, exec) {
        return client(args, named('repos')).listRepos({ ...args, signal: exec.signal })
      },
    }))

    ctx.tools.register(defineTool({
      name: named('file'),
      description: `Read one file from a ${label} repository. Use whenever an answer may live in a ${label} repo the user mentions — the token is injected automatically and never enters the model context.${SITE_DESCRIPTION}`,
      parameters: {
        site: siteParameter,
        project: {
          type: 'string', required: true,
          description: `Repository on ${label}, e.g. ${projectHint}.`,
        },
        path: {
          type: 'string', required: true,
          description: 'File path within the repository, e.g. src/index.ts.',
        },
        ref: {
          type: 'string',
          description: 'Branch or tag to read from; defaults to the repository default branch.',
        },
      },
      output: {
        schema: fileSchema,
        render: (_args, file: { path: string; ref: string; content: string; truncated: boolean }) => [
          { type: 'text', text: file.truncated ? `(truncated) ${file.path}@${file.ref}` : `${file.path}@${file.ref}` },
          { type: 'text', text: file.content },
        ],
      },
      presentCall(args): GenericCallView {
        return {
          card: 'generic',
          title: `Read ${args.path}@${args.ref ?? 'default branch'} in ${args.project}`,
          kind: 'read',
        }
      },
      async execute(args, exec) {
        return client(args, named('file')).readFile({ ...args, maxBytes: config.fileReadMaxBytes, signal: exec.signal })
      },
    }))

    ctx.tools.register(defineTool({
      name: named('issues'),
      description: `List issues of a ${label} repository. Use when the user references an issue or asks about open issues — the token is injected per site.${SITE_DESCRIPTION}`,
      parameters: {
        site: siteParameter,
        project: {
          type: 'string',
          description: `Repository on ${label}, e.g. ${projectHint}; defaults to the site defaultProject when configured.`,
        },
        state: {
          type: 'string', enum: ['open', 'closed', 'all'],
          description: 'Filter by state; defaults to open.',
        },
        perPage: { type: 'integer', description: 'Maximum number of entries to return (1-100).' },
      },
      output: {
        schema: { type: 'array', items: githubEntrySchema },
        render: (_args, entries: Array<{ number: number; title: string; state: string; webUrl: string; authorName: string }>) =>
          entries.length === 0
            ? [{ type: 'text', text: 'No issues found.' }]
            : [{
              type: 'text',
              text: entries.map(entry => `#${entry.number} [${entry.state}] ${entry.title} — ${entry.authorName} — ${entry.webUrl}`)
                .join('\n'),
            }],
      },
      presentCall(args): GenericCallView {
        return {
          card: 'generic',
          title: `Issues of ${args.project ?? 'default project'}`,
          kind: 'search',
        }
      },
      async execute(args, exec) {
        return client(args, named('issues')).listIssues({ ...args, signal: exec.signal })
      },
    }))

    ctx.tools.register(defineTool({
      name: named('pull_requests'),
      description: `List pull requests of a ${label} repository. Use when the user references a PR, a code review, or asks about open/closed PRs — the token is injected per site.${SITE_DESCRIPTION}`,
      parameters: {
        site: siteParameter,
        project: {
          type: 'string',
          description: `Repository on ${label}, e.g. ${projectHint}; defaults to the site defaultProject when configured.`,
        },
        state: {
          type: 'string', enum: ['open', 'closed', 'all'],
          description: 'Filter by state; defaults to open.',
        },
        perPage: { type: 'integer', description: 'Maximum number of entries to return (1-100).' },
      },
      output: {
        schema: { type: 'array', items: githubEntrySchema },
        render: (_args, entries: Array<{ number: number; title: string; state: string; webUrl: string; authorName: string }>) =>
          entries.length === 0
            ? [{ type: 'text', text: 'No pull requests found.' }]
            : [{
              type: 'text',
              text: entries.map(entry => `#${entry.number} [${entry.state}] ${entry.title} — ${entry.authorName} — ${entry.webUrl}`)
                .join('\n'),
            }],
      },
      presentCall(args): GenericCallView {
        return {
          card: 'generic',
          title: `Pull requests of ${args.project ?? 'default project'}`,
          kind: 'search',
        }
      },
      async execute(args, exec) {
        return client(args, named('pull_requests')).listPullRequests({ ...args, signal: exec.signal })
      },
    }))

    ctx.tools.register(defineTool({
      name: named('create_issue'),
      description: `Create an issue in a ${label} repository (write operation). Use when the user asks to file a new issue — the token is injected per site.${SITE_DESCRIPTION}`,
      parameters: {
        site: siteParameter,
        project: {
          type: 'string',
          description: `Repository on ${label}, e.g. ${projectHint}; defaults to the site defaultProject when configured.`,
        },
        title: { type: 'string', required: true, description: 'Issue title.' },
        body: { type: 'string', description: 'Issue description (Markdown).' },
      },
      output: {
        schema: createdEntrySchema,
        render: (_args, created: { id: number; title: string; webUrl: string }) => [
          { type: 'text', text: `Created issue #${created.id}: ${created.title} — ${created.webUrl}` },
        ],
      },
      presentCall(args): GenericCallView {
        return {
          card: 'generic',
          title: `Create issue in ${args.project ?? 'default project'}`,
          kind: 'edit',
        }
      },
      async execute(args, exec) {
        return client(args, named('create_issue')).createIssue({ ...args, signal: exec.signal })
      },
    }))

    ctx.tools.register(defineTool({
      name: named('create_pull_request'),
      description: `Create a pull request in a ${label} repository (write operation). Use when the user asks to open a PR — the token is injected per site.${SITE_DESCRIPTION}`,
      parameters: {
        site: siteParameter,
        project: {
          type: 'string',
          description: `Repository on ${label}, e.g. ${projectHint}; defaults to the site defaultProject when configured.`,
        },
        title: { type: 'string', required: true, description: 'Pull-request title.' },
        head: { type: 'string', required: true, description: 'Head branch (the changes).' },
        base: { type: 'string', required: true, description: 'Base branch (often main or master).' },
        body: { type: 'string', description: 'Pull-request description (Markdown).' },
      },
      output: {
        schema: createdEntrySchema,
        render: (_args, created: { id: number; title: string; webUrl: string }) => [
          { type: 'text', text: `Created pull request #${created.id}: ${created.title} — ${created.webUrl}` },
        ],
      },
      presentCall(args): GenericCallView {
        return {
          card: 'generic',
          title: `Create pull request in ${args.project ?? 'default project'}`,
          kind: 'edit',
        }
      },
      async execute(args, exec) {
        return client(args, named('create_pull_request')).createPullRequest({ ...args, signal: exec.signal })
      },
    }))

    ctx.tools.register(defineTool({
      name: named('create_repo'),
      description: `Create a repository under the token owner on ${label} (write operation). Use when the user asks to create a new repository — the token is injected per site.${SITE_DESCRIPTION}`,
      parameters: {
        site: siteParameter,
        name: { type: 'string', required: true, description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Create a private repository; defaults to the account default.' },
      },
      output: {
        schema: createdRepoSchema,
        render: (_args, created: { path: string; webUrl: string }) => [
          { type: 'text', text: `Created repository ${created.path} — ${created.webUrl}` },
        ],
      },
      presentCall(args): GenericCallView {
        return { card: 'generic', title: `Create ${label} repository ${args.name}`, kind: 'edit' }
      },
      async execute(args, exec) {
        return client(args, named('create_repo')).createRepo({ ...args, signal: exec.signal })
      },
    }))
  }

  registerForgeTools('gitee', 'gitee', 'Gitee', 'owner/repo')
  registerForgeTools('gitea', 'gitea', 'Gitea', 'owner/repo')
  registerForgeTools('bitbucket', 'bitbucket', 'Bitbucket', 'workspace/repo')
}
