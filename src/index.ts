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
 *
 * Tool layout: one resource tool per provider (repos / projects, file,
 * issues, pull requests / merge requests, releases where the platform has
 * them), with an `action` parameter that selects list, create, or modify
 * behaviour — issue and pull-request tools cover create/close/reopen/comment
 * and create/merge/close respectively, so the model-side tool table stays
 * compact.
 * @module dsh-git-credentials
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool, type GenericCallView } from '@deepseek-ai/dsh-tools'
import { GitLabClient, type GitLabFile } from './gitlab.ts'
import { GitHubClient, type GitHubFile } from './github.ts'
import { GiteeClient } from './gitee.ts'
import { GiteaClient } from './gitea.ts'
import { BitbucketClient } from './bitbucket.ts'
import { GitStore, refOf, adapterFor, type ForgeProvider } from './store.ts'
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

/** Canonical shape of one repository/project summary (all providers). */
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

/** Canonical shape of one GitLab merge-request or issue summary (iid-keyed). */
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

/** Canonical shape of one GitHub / Gitee / Gitea / Bitbucket issue or PR summary (number-keyed). */
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

/** Canonical shape of one file read (all providers). */
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

/** Canonical shape of one release summary (all providers). */
const releaseSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    tag: { type: 'string' },
    name: { type: 'string' },
    webUrl: { type: 'string' },
    draft: { type: 'boolean' },
    prerelease: { type: 'boolean' },
  },
  additionalProperties: false,
} as const

/** One entry as the loop sees it (iid and number are the two key spellings). */
interface IterationEntry {
  readonly number?: number
  readonly iid?: number
  readonly title: string
  readonly state: string
  readonly webUrl: string
  readonly authorName: string
}

/** One release as the loop sees it (id absent on GitLab, which keys releases by tag). */
interface ReleaseEntry {
  readonly id?: number
  readonly tag: string
  readonly name: string
  readonly webUrl: string
  readonly draft: boolean
  readonly prerelease: boolean
}

/** One repo as the loop sees it. */
interface IterationRepo {
  readonly path: string
  readonly visibility: string
  readonly webUrl: string
}

export function apply(ctx: Context, config: PluginConfig): void {
  const store = GitStore.create(config)

  // One operation, one decrypted snapshot: sites and tokens are read per
  // call, so Settings → Git 凭据 changes reach the next call immediately.
  // Tools are provider-scoped: a gitlab tool only sees gitlab sites.
  const clientFor = (siteArg: string | undefined, tool: string, provider: ForgeProvider):
    GitLabClient | GitHubClient | GiteeClient | GiteaClient | BitbucketClient => {
    const state = store.read()
    // Forgejo sites are wire-compatible with Gitea and share its tool family
    // (registered under provider "gitea"), so match on the effective adapter.
    const candidates = Object.entries(state.sites).filter(([, site]) => adapterFor(site.provider) === provider)
    const defaultSiteId = state.defaultSite
    const fallback = defaultSiteId !== undefined
      ? (state.sites[defaultSiteId] !== undefined && adapterFor(state.sites[defaultSiteId]!.provider) === provider ? defaultSiteId : undefined)
      : undefined
    const id = siteArg ?? (candidates.length === 1 ? candidates[0]![0] : undefined) ?? fallback
    if (id === undefined) {
      const hint = candidates.length === 0
        ? `no ${provider} site configured; add one in Settings → Git 凭据`
        : `no ${provider} site configured; add one in Settings → Git 凭据 (or pass a site argument)`
      throw new Error(`git-credentials: ${hint}`)
    }
    const site = state.sites[id]
    if (site === undefined || adapterFor(site.provider) !== provider) {
      const ids = candidates.map(([candidateId]) => candidateId).join(', ') || '(none)'
      throw new Error(`git-credentials: unknown ${provider} site "${id}" for ${tool}; configured ${provider} sites: ${ids}`)
    }
    const base = {
      id,
      baseUrl: site.baseUrl,
      tokenRef: refOf(site.tokenRef),
      ...site.defaultProject === undefined ? {} : { defaultProject: site.defaultProject },
    }
    switch (adapterFor(site.provider)) {
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

  /** Throw a loud error unless the argument is a non-empty string. */
  const needString = (args: Record<string, unknown>, key: string, tool: string): string => {
    const value = args[key]
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${tool}: the "${key}" argument is required for this action`)
    }
    return value
  }

  /** Throw a loud error unless the argument is a positive integer (issue/PR number). */
  const needNumber = (args: Record<string, unknown>, tool: string): number => {
    const value = args.number
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new Error(`${tool}: a positive integer "number" argument is required (the issue/PR number)`)
    }
    return value
  }

  /** The entry id for display (iid on GitLab, number elsewhere). */
  const entryId = (entry: IterationEntry): number => entry.number ?? entry.iid ?? 0

  /** Read an optional array-of-strings argument, dropping non-string/blank entries. */
  const stringArray = (args: Record<string, unknown>, key: string): string[] | undefined => {
    const value = args[key]
    if (!Array.isArray(value)) return undefined
    const filtered = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    return filtered.length === 0 ? undefined : filtered
  }

  /** Render one issues/pulls action result. */
  const renderEntryAction = (label: string, plural: string) =>
    (args: { action?: string }, entries: IterationEntry[]): Array<{ type: 'text'; text: string }> => {
      const action = args.action ?? 'list'
      const entry = entries[0]
      if (entry === undefined) {
        if (action === 'list') return [{ type: 'text', text: `No ${plural} found.` }]
        return [{ type: 'text', text: `${label} updated (no summary returned)` }]
      }
      switch (action) {
        case 'create': return [{ type: 'text', text: `Created ${label} #${entryId(entry)}: ${entry.title} — ${entry.webUrl}` }]
        case 'close': return [{ type: 'text', text: `Closed ${label} #${entryId(entry)} — ${entry.webUrl}` }]
        case 'reopen': return [{ type: 'text', text: `Reopened ${label} #${entryId(entry)} — ${entry.webUrl}` }]
        case 'comment': return [{ type: 'text', text: `Commented on ${label} #${entryId(entry)}: ${entry.title} — ${entry.webUrl}` }]
        case 'label': return [{ type: 'text', text: `Updated labels on ${label} #${entryId(entry)}: ${entry.title} — ${entry.webUrl}` }]
        case 'merge': return [{ type: 'text', text: `Merged ${label} #${entryId(entry)}: ${entry.title} — ${entry.webUrl}` }]
        default: return [{
          type: 'text',
          text: entries.map(item => `#${entryId(item)} [${item.state}] ${item.title} — ${item.authorName} — ${item.webUrl}`).join('\n'),
        }]
      }
    }

  /** Render one repos/projects action result. */
  const renderRepoAction = (args: { action?: string }, repos: IterationRepo[]): Array<{ type: 'text'; text: string }> => {
    if (args.action === 'create') {
      const repo = repos[0]
      return repo === undefined
        ? [{ type: 'text', text: 'Created repository (no summary returned)' }]
        : [{ type: 'text', text: `Created repository ${repo.path} — ${repo.webUrl}` }]
    }
    return repos.length === 0
      ? [{ type: 'text', text: 'No repositories found.' }]
      : [{ type: 'text', text: repos.map(repo => `${repo.path} (${repo.visibility}) — ${repo.webUrl}`).join('\n') }]
  }

  /** Render one releases action result. */
  const renderReleaseAction = (args: { action?: string }, releases: ReleaseEntry[]): Array<{ type: 'text'; text: string }> => {
    const action = args.action ?? 'list'
    const release = releases[0]
    if (release === undefined) {
      if (action === 'list') return [{ type: 'text', text: 'No releases found.' }]
      return [{ type: 'text', text: `${action === 'create' ? 'Created' : 'Deleted'} release (no summary returned)` }]
    }
    if (action === 'create') return [{ type: 'text', text: `Created release ${release.tag}: ${release.name} — ${release.webUrl}` }]
    if (action === 'delete') {
      return [{ type: 'text', text: `Deleted release ${release.id !== undefined ? `#${release.id}` : release.tag}` }]
    }
    return [{
      type: 'text',
      text: releases.map(item =>
        `${item.tag}${item.draft ? ' [draft]' : ''}${item.prerelease ? ' [pre]' : ''} — ${item.name} — ${item.webUrl}`,
      ).join('\n'),
    }]
  }

  /**
   * The structural client surface every forge client satisfies: read tools
   * plus create/modify operations, all returning the canonical shapes.
   */
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
    }): Promise<IterationEntry[]>
    listPullRequests(options: {
      readonly project?: string
      readonly state?: string
      readonly perPage?: number
      readonly signal?: AbortSignal
    }): Promise<IterationEntry[]>
    createRepo(options: {
      readonly name: string
      readonly description?: string
      readonly private?: boolean
      readonly signal?: AbortSignal
    }): Promise<{ path: string; visibility: string; webUrl: string }>
    createIssue(options: {
      readonly project?: string
      readonly title: string
      readonly body?: string
      readonly signal?: AbortSignal
    }): Promise<IterationEntry>
    createPullRequest(options: {
      readonly project?: string
      readonly title: string
      readonly head: string
      readonly base: string
      readonly body?: string
      readonly signal?: AbortSignal
    }): Promise<IterationEntry>
    closeIssue(options: { readonly project?: string; readonly number: number; readonly signal?: AbortSignal }): Promise<IterationEntry>
    reopenIssue(options: { readonly project?: string; readonly number: number; readonly signal?: AbortSignal }): Promise<IterationEntry>
    commentIssue(options: { readonly project?: string; readonly number: number; readonly body: string; readonly signal?: AbortSignal }): Promise<IterationEntry>
    labelIssue(options: {
      readonly project?: string
      readonly number: number
      readonly add?: readonly string[]
      readonly remove?: readonly string[]
      readonly signal?: AbortSignal
    }): Promise<IterationEntry>
    mergePull(options: { readonly project?: string; readonly number: number; readonly signal?: AbortSignal }): Promise<IterationEntry>
    closePull(options: { readonly project?: string; readonly number: number; readonly signal?: AbortSignal }): Promise<IterationEntry>
    listReleases(options: {
      readonly project?: string
      readonly perPage?: number
      readonly signal?: AbortSignal
    }): Promise<ReleaseEntry[]>
    createRelease(options: {
      readonly project?: string
      readonly tagName: string
      readonly name?: string
      readonly body?: string
      readonly draft?: boolean
      readonly prerelease?: boolean
      readonly signal?: AbortSignal
    }): Promise<ReleaseEntry>
    deleteRelease(options: {
      readonly project?: string
      readonly number?: number
      readonly tag?: string
      readonly signal?: AbortSignal
    }): Promise<ReleaseEntry>
  }

  /** Per-provider registration facts. */
  interface ForgeSpec {
    readonly prefix: string
    readonly provider: ForgeProvider
    readonly label: string
    readonly projectHint: string
    /** The list/create tool's kind name: "projects" (GitLab) or "repos" (others). */
    readonly reposKind: string
    /** The pull-request tool's kind name: "merge_requests" (GitLab) or "pull_requests" (others). */
    readonly pullsKind: string
    /** Which entry schema the provider's issues/PR tools emit. */
    readonly entrySchema: typeof listEntrySchema | typeof githubEntrySchema
    /** The default list state name ("opened" on GitLab, "open" elsewhere). */
    readonly defaultState: string
    /** GitLab: membership filter on project listing + path/visibility on create. */
    readonly gitlabExtras?: boolean
    /** Whether the platform has a releases API (Bitbucket does not). */
    readonly releases?: boolean
  }

  const registerForgeTools = (spec: ForgeSpec): void => {
    const { prefix, provider, label, projectHint, reposKind, pullsKind } = spec
    const named = (kind: string): string => `${prefix}_${kind}`
    const client = (args: { site?: string }, tool: string): ForgeClient =>
      clientFor(args.site, tool, provider) as unknown as ForgeClient

    ctx.tools.register(defineTool({
      name: named(reposKind),
      description: `List/search or create ${label} ${reposKind}. action "list" lists or searches (search?, perPage?${spec.gitlabExtras === true ? ', membership?' : ''}); action "create" creates one (name, description?${spec.gitlabExtras === true ? ', path?, visibility?' : ', private?'}) — the token is injected per site. Only use "search" to find a repository when you do NOT already know both the owner and the repo name. If you already have "${projectHint}", skip this tool entirely and pass it as "project" directly to the issues, pull-request, file, or release tools instead — those work straight from "owner/repo" with no lookup step, and this search action requires broader repository-read scope that a least-privilege (e.g. issue-only) token may not have.${SITE_DESCRIPTION}`,
      parameters: {
        site: siteParameter,
        action: {
          type: 'string', enum: ['list', 'create'],
          description: 'What to do; defaults to "list".',
        },
        search: {
          type: 'string',
          description: 'Filter repositories whose name or path contains this text. Only needed when the repository is not already known as '
            + `"${projectHint}" — do not call this just to confirm a repo you can already name; pass it straight to another tool's "project" argument instead.`,
        },
        ...spec.gitlabExtras === true
          ? { membership: { type: 'boolean', description: 'Only list projects the token owner belongs to.' } }
          : {},
        perPage: { type: 'integer', description: 'Maximum number of repositories to return (1-100).' },
        name: { type: 'string', description: 'Repository/project name (required for create).' },
        description: { type: 'string', description: 'Repository/project description.' },
        ...spec.gitlabExtras === true
          ? {
            path: { type: 'string', description: 'Project path (defaults to the name).' },
            visibility: {
              type: 'string', enum: ['private', 'internal', 'public'],
              description: 'Project visibility; defaults to the instance default.',
            },
          }
          : { private: { type: 'boolean', description: 'Create a private repository; defaults to the account default.' } },
      },
      output: {
        schema: { type: 'array', items: repoSchema },
        render: renderRepoAction,
      },
      presentCall(args): GenericCallView {
        return {
          card: 'generic',
          title: args.action === 'create'
            ? `Create ${label} ${reposKind.slice(0, -1)} ${args.name ?? ''}`
            : `${label} ${reposKind}${args.search === undefined ? '' : ` matching ${args.search}`}`,
          kind: args.action === 'create' ? 'edit' : 'search',
        }
      },
      async execute(args, exec) {
        const c = client(args, named(reposKind))
        if (args.action === 'create') {
          const name = needString(args, 'name', named(reposKind))
          // GitLab spells the create extras path/visibility; the others use private.
          const repoInput: Record<string, unknown> = {
            name,
            ...(args.description === undefined ? {} : { description: args.description }),
            ...(spec.gitlabExtras === true
              ? {
                ...((args as { path?: string }).path === undefined ? {} : { path: (args as { path?: string }).path }),
                ...((args as { visibility?: string }).visibility === undefined ? {} : { visibility: (args as { visibility?: string }).visibility }),
              }
              : { ...(((args as { private?: boolean }).private) === undefined ? {} : { private: (args as { private?: boolean }).private }) }),
            signal: exec.signal,
          }
          return [await c.createRepo(repoInput as unknown as Parameters<ForgeClient['createRepo']>[0])]
        }
        return c.listRepos({ ...(args.search === undefined ? {} : { search: args.search }), ...(args.perPage === undefined ? {} : { perPage: args.perPage }), signal: exec.signal })
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
        render: (_args, file: GitLabFile | GitHubFile) => [
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
        const c = client(args, named('file'))
        return c.readFile({ ...args, maxBytes: config.fileReadMaxBytes, signal: exec.signal })
      },
    }))

    ctx.tools.register(defineTool({
      name: named('issues'),
      description: `List, create, or modify ${label} issues. action: "list" (project?, state?, perPage?), "create" (title, body?), "close" (number), "reopen" (number), "comment" (number, body), "label" (number, addLabels? and/or removeLabels?) — the token is injected per site. Pass "project" directly as "${projectHint}" when known; this tool calls the issues API straight from that, with no repository search or lookup step, so it needs no broader repository-read scope beyond issues.${SITE_DESCRIPTION}`,
      parameters: {
        site: siteParameter,
        action: {
          type: 'string', enum: ['list', 'create', 'close', 'reopen', 'comment', 'label'],
          description: 'What to do; defaults to "list".',
        },
        project: {
          type: 'string',
          description: `Repository on ${label}, e.g. ${projectHint}; defaults to the site defaultProject when configured. Pass it directly — no need to look the repository up with the ${reposKind} tool's "search" action first.`,
        },
        state: {
          type: 'string',
          description: `Filter by state (${spec.defaultState === 'opened' ? 'opened/closed/all' : 'open/closed/all'}); only for action "list".`,
        },
        perPage: { type: 'integer', description: 'Maximum number of entries to return (1-100).' },
        number: { type: 'integer', description: 'Issue number (required for close/reopen/comment/label).' },
        title: { type: 'string', description: 'Issue title (required for create).' },
        body: { type: 'string', description: 'Issue body or comment text (Markdown).' },
        addLabels: {
          type: 'array', items: { type: 'string' },
          description: 'Label names to add to the issue; only for action "label". At least one of addLabels/removeLabels is required for "label".',
        },
        removeLabels: {
          type: 'array', items: { type: 'string' },
          description: 'Label names to remove from the issue; only for action "label". At least one of addLabels/removeLabels is required for "label".',
        },
      },
      output: {
        schema: { type: 'array', items: spec.entrySchema },
        render: renderEntryAction('issue', 'issues'),
      },
      presentCall(args): GenericCallView {
        return {
          card: 'generic',
          title: `${(args.action ?? 'list') === 'list' ? 'Issues of' : 'Issue operation on'} ${args.project ?? 'default project'}`,
          kind: (args.action ?? 'list') === 'list' ? 'search' : 'edit',
        }
      },
      async execute(args, exec) {
        const c = client(args, named('issues'))
        switch (args.action ?? 'list') {
          case 'list':
            return c.listIssues({ ...(args.project === undefined ? {} : { project: args.project }), ...(args.state === undefined ? {} : { state: args.state }), ...(args.perPage === undefined ? {} : { perPage: args.perPage }), signal: exec.signal })
          case 'create':
            return [await c.createIssue({
              ...(args.project === undefined ? {} : { project: args.project }),
              title: needString(args, 'title', named('issues')),
              ...(args.body === undefined ? {} : { body: args.body }),
              signal: exec.signal,
            })]
          case 'close':
            return [await c.closeIssue({ ...(args.project === undefined ? {} : { project: args.project }), number: needNumber(args, named('issues')), signal: exec.signal })]
          case 'reopen':
            return [await c.reopenIssue({ ...(args.project === undefined ? {} : { project: args.project }), number: needNumber(args, named('issues')), signal: exec.signal })]
          case 'comment':
            return [await c.commentIssue({
              ...(args.project === undefined ? {} : { project: args.project }),
              number: needNumber(args, named('issues')),
              body: needString(args, 'body', named('issues')),
              signal: exec.signal,
            })]
          case 'label': {
            const add = stringArray(args, 'addLabels')
            const remove = stringArray(args, 'removeLabels')
            if (add === undefined && remove === undefined) {
              throw new Error(`${named('issues')}: action "label" requires at least one of "addLabels" or "removeLabels"`)
            }
            return [await c.labelIssue({
              ...(args.project === undefined ? {} : { project: args.project }),
              number: needNumber(args, named('issues')),
              ...(add === undefined ? {} : { add }),
              ...(remove === undefined ? {} : { remove }),
              signal: exec.signal,
            })]
          }
          default:
            throw new Error(`${named('issues')}: unknown action ${JSON.stringify(args.action)}; valid: list, create, close, reopen, comment, label`)
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: named(pullsKind),
      description: `List, create, or modify ${label} ${pullsKind === 'merge_requests'
        ? 'merge requests'
        : 'pull requests'}. action: "list" (project?, state?, perPage?), "create" (title, head/sourceBranch, base/targetBranch, body?), "merge" (number), "close" (number) — the token is injected per site.${SITE_DESCRIPTION}`,
      parameters: {
        site: siteParameter,
        action: {
          type: 'string', enum: ['list', 'create', 'merge', 'close'],
          description: 'What to do; defaults to "list".',
        },
        project: {
          type: 'string',
          description: `Repository on ${label}, e.g. ${projectHint}; defaults to the site defaultProject when configured.`,
        },
        state: {
          type: 'string',
          description: `Filter by state (${spec.defaultState === 'opened' ? 'opened/closed/all/merged' : 'open/closed/all'}); only for action "list".`,
        },
        perPage: { type: 'integer', description: 'Maximum number of entries to return (1-100).' },
        number: { type: 'integer', description: 'PR/MR number (required for merge/close).' },
        title: { type: 'string', description: 'PR/MR title (required for create).' },
        ...(spec.gitlabExtras === true
          ? {
            sourceBranch: { type: 'string', description: 'Source branch (the changes) (required for create).' },
            targetBranch: { type: 'string', description: 'Target branch, often main or master (required for create).' },
          }
          : {
            head: { type: 'string', description: 'Head/source branch (required for create).' },
            base: { type: 'string', description: 'Base/target branch, often main or master (required for create).' },
          }),
        body: { type: 'string', description: 'PR/MR description (Markdown).' },
      },
      output: {
        schema: { type: 'array', items: spec.entrySchema },
        render: renderEntryAction(pullsKind === 'merge_requests' ? 'merge request' : 'pull request', pullsKind === 'merge_requests' ? 'merge requests' : 'pull requests'),
      },
      presentCall(args): GenericCallView {
        return {
          card: 'generic',
          title: `${(args.action ?? 'list') === 'list' ? 'Pull requests of' : 'Pull-request operation on'} ${args.project ?? 'default project'}`,
          kind: (args.action ?? 'list') === 'list' ? 'search' : 'edit',
        }
      },
      async execute(args, exec) {
        const c = client(args, named(pullsKind))
        switch (args.action ?? 'list') {
          case 'list':
            return c.listPullRequests({ ...(args.project === undefined ? {} : { project: args.project }), ...(args.state === undefined ? {} : { state: args.state }), ...(args.perPage === undefined ? {} : { perPage: args.perPage }), signal: exec.signal })
          case 'create': {
            // GitLab spells the branches sourceBranch/targetBranch; the others use head/base.
            const branches = spec.gitlabExtras === true
              ? {
                sourceBranch: needString(args as Record<string, unknown>, 'sourceBranch', named(pullsKind)),
                targetBranch: needString(args as Record<string, unknown>, 'targetBranch', named(pullsKind)),
              }
              : {
                head: needString(args as Record<string, unknown>, 'head', named(pullsKind)),
                base: needString(args as Record<string, unknown>, 'base', named(pullsKind)),
              }
            const pullInput: Record<string, unknown> = {
              ...(args.project === undefined ? {} : { project: args.project }),
              title: needString(args, 'title', named(pullsKind)),
              ...branches,
              ...(args.body === undefined ? {} : { body: args.body }),
              signal: exec.signal,
            }
            return [await c.createPullRequest(pullInput as unknown as Parameters<ForgeClient['createPullRequest']>[0])]
          }
          case 'merge':
            return [await c.mergePull({ ...(args.project === undefined ? {} : { project: args.project }), number: needNumber(args, named(pullsKind)), signal: exec.signal })]
          case 'close':
            return [await c.closePull({ ...(args.project === undefined ? {} : { project: args.project }), number: needNumber(args, named(pullsKind)), signal: exec.signal })]
          default:
            throw new Error(`${named(pullsKind)}: unknown action ${JSON.stringify(args.action)}; valid: list, create, merge, close`)
        }
      },
    }))

    if (spec.releases !== false) {
      ctx.tools.register(defineTool({
        name: named('releases'),
        description: `List, create, or delete ${label} releases. action: "list" (project?, perPage?), "create" (tag, name?, body?, draft?, prerelease?), "delete" (${spec.gitlabExtras === true ? 'tag' : 'number'}) — the token is injected per site.${SITE_DESCRIPTION}`,
        parameters: {
          site: siteParameter,
          action: {
            type: 'string', enum: ['list', 'create', 'delete'],
            description: 'What to do; defaults to "list".',
          },
          project: {
            type: 'string',
            description: `Repository on ${label}, e.g. ${projectHint}; defaults to the site defaultProject when configured.`,
          },
          perPage: { type: 'integer', description: 'Maximum number of entries to return (1-100).' },
          ...(spec.gitlabExtras === true
            ? { tag: { type: 'string', description: 'Release tag (required for create; delete deletes by tag on GitLab).' } }
            : {
              tag: { type: 'string', description: 'Release tag (required for create).' },
              number: { type: 'integer', description: 'Release id (required for delete).' },
            }),
          name: { type: 'string', description: 'Release name (defaults to the tag).' },
          body: { type: 'string', description: 'Release description/body (Markdown).' },
          draft: { type: 'boolean', description: 'Create as a draft release.' },
          prerelease: { type: 'boolean', description: 'Mark as a prerelease.' },
        },
        output: {
          schema: { type: 'array', items: releaseSchema },
          render: renderReleaseAction,
        },
        presentCall(args): GenericCallView {
          return {
            card: 'generic',
            title: `${(args.action ?? 'list') === 'list' ? 'Releases of' : 'Release operation on'} ${args.project ?? 'default project'}`,
            kind: (args.action ?? 'list') === 'list' ? 'search' : 'edit',
          }
        },
        async execute(args, exec) {
          const c = client(args, named('releases'))
          switch (args.action ?? 'list') {
            case 'list':
              return c.listReleases({
                ...(args.project === undefined ? {} : { project: args.project }),
                ...(args.perPage === undefined ? {} : { perPage: args.perPage }),
                signal: exec.signal,
              })
            case 'create': {
              const input: Record<string, unknown> = {
                ...(args.project === undefined ? {} : { project: args.project }),
                tagName: needString(args, 'tag', named('releases')),
                ...(args.name === undefined ? {} : { name: args.name }),
                ...(args.body === undefined ? {} : { body: args.body }),
                ...(args.draft === undefined ? {} : { draft: args.draft }),
                ...(args.prerelease === undefined ? {} : { prerelease: args.prerelease }),
                signal: exec.signal,
              }
              return [await c.createRelease(input as unknown as Parameters<ForgeClient['createRelease']>[0])]
            }
            case 'delete': {
              const input: Record<string, unknown> = {
                ...(args.project === undefined ? {} : { project: args.project }),
                ...(spec.gitlabExtras === true
                  ? { tag: needString(args as Record<string, unknown>, 'tag', named('releases')) }
                  : { number: needNumber(args, named('releases')) }),
                signal: exec.signal,
              }
              return [await c.deleteRelease(input as unknown as Parameters<ForgeClient['deleteRelease']>[0])]
            }
            default:
              throw new Error(`${named('releases')}: unknown action ${JSON.stringify(args.action)}; valid: list, create, delete`)
          }
        },
      }))
    }
  }

  registerForgeTools({
    prefix: 'gitlab',
    provider: 'gitlab',
    label: 'GitLab',
    projectHint: 'group/subgroup/project',
    reposKind: 'projects',
    pullsKind: 'merge_requests',
    entrySchema: listEntrySchema,
    defaultState: 'opened',
    gitlabExtras: true,
  })
  registerForgeTools({
    prefix: 'github',
    provider: 'github',
    label: 'GitHub',
    projectHint: 'owner/repo',
    reposKind: 'repos',
    pullsKind: 'pull_requests',
    entrySchema: githubEntrySchema,
    defaultState: 'open',
  })
  registerForgeTools({
    prefix: 'gitee',
    provider: 'gitee',
    label: 'Gitee',
    projectHint: 'owner/repo',
    reposKind: 'repos',
    pullsKind: 'pull_requests',
    entrySchema: githubEntrySchema,
    defaultState: 'open',
  })
  registerForgeTools({
    prefix: 'gitea',
    provider: 'gitea',
    label: 'Gitea',
    projectHint: 'owner/repo',
    reposKind: 'repos',
    pullsKind: 'pull_requests',
    entrySchema: githubEntrySchema,
    defaultState: 'open',
  })
  registerForgeTools({
    prefix: 'bitbucket',
    provider: 'bitbucket',
    label: 'Bitbucket',
    projectHint: 'workspace/repo',
    reposKind: 'repos',
    pullsKind: 'pull_requests',
    entrySchema: githubEntrySchema,
    defaultState: 'open',
    releases: false,
  })
}