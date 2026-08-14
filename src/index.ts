/**
 * The git-credentials plugin: model-facing GitLab and GitHub tools whose
 * tokens never enter the model context. Sites and token values live in the
 * plugin's own encrypted store (AES-256-GCM, separate key file), managed
 * from the Settings → Git 凭据 page through the plugin's own admin routes.
 * Each tool call reads one decrypted snapshot, so editing a site or rotating
 * a token reaches the next call without a restart. The plugin is a pure
 * out-of-tree bolt-on: it uses no product wire channel and mounts/unmounts
 * dynamically through the home-level patch layer.
 * @module dsh-git-credentials
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool, type GenericCallView } from '@deepseek-ai/dsh-tools'
import { GitLabClient, type GitLabFile, type GitLabListEntry, type GitLabProject } from './gitlab.ts'
import { GitHubClient, type GitHubEntry, type GitHubFile, type GitHubRepo } from './github.ts'
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

export function apply(ctx: Context, config: PluginConfig): void {
  const store = GitStore.create(config)

  // One operation, one decrypted snapshot: sites and tokens are read per
  // call, so Settings → Git 凭据 changes reach the next call immediately.
  // Tools are provider-scoped: a gitlab tool only sees gitlab sites.
  const clientFor = (siteArg: string | undefined, tool: string, provider: ForgeProvider): GitLabClient | GitHubClient => {
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
    return site.provider === 'github' ? new GitHubClient(state.tokens, base) : new GitLabClient(state.tokens, base)
  }
  const SITE_DESCRIPTION = ' Site ids are managed in Settings → Git 凭据.'

  ctx.logger('git-credentials').info('git-credentials plugin loaded')
  registerGitLabAdmin(ctx, { store })

  ctx.tools.register(defineTool({
    name: 'gitlab_projects',
    description: `List or search projects on a self-hosted GitLab.${SITE_DESCRIPTION}`,
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
    description: `Read one file from a repository on a self-hosted GitLab.${SITE_DESCRIPTION}`,
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
    description: `List merge requests of one project on a self-hosted GitLab.${SITE_DESCRIPTION}`,
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
    description: `List issues of one project on a self-hosted GitLab.${SITE_DESCRIPTION}`,
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
    name: 'github_repos',
    description: `List or search repositories on GitHub.${SITE_DESCRIPTION}`,
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
    description: `Read one file from a repository on GitHub.${SITE_DESCRIPTION}`,
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
    description: `List issues of one repository on GitHub (pull requests excluded).${SITE_DESCRIPTION}`,
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
    description: `List pull requests of one repository on GitHub.${SITE_DESCRIPTION}`,
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
}
