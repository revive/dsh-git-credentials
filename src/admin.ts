/**
 * The plugin's management HTTP surface: JSON routes under /gitlab-admin/*
 * served by the same webserver as the GUI, so the Settings → GitLab panel
 * manages the plugin's own encrypted store (sites and token values) without
 * depending on any product wire channel. The routes are registered only when
 * a webserver exists (web composition), never in headless. Token values
 * never appear in any response — only configured state.
 *
 * Endpoints:
 *   GET    /gitlab-admin/state        sites + per-token configured state
 *   POST   /gitlab-admin/sites        { id, site } — add or update one site
 *   DELETE /gitlab-admin/sites/:id    remove one site
 *   POST   /gitlab-admin/token        { ref, value } — store one token
 *   DELETE /gitlab-admin/token        { ref } — clear one token
 * @module gitlab-admin
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GitStore, SiteConfig } from './store.ts'
import { refOf, type ForgeProvider } from './store.ts'

/** Structural slice of the webserver route API. */
interface WebRouteRegistrar {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  }): () => void
}

/** The admin surface's dependencies, owned by the plugin's apply closure. */
export interface GitLabAdminDeps {
  /** The plugin's encrypted store (reads + writes). */
  readonly store: GitStore
}

/** Route prefix under which the admin endpoints live. */
const ADMIN_PREFIX = '/git-credentials-admin'

/** The site id pattern. */
const SITE_ID_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * Register the management routes; a no-op where no webserver exists.
 * @param ctx - plugin context (web composition only reaches this branch).
 * @param deps - the store from the apply closure.
 */
export function registerGitLabAdmin(ctx: Context, deps: GitLabAdminDeps): void {
  ctx.inject(['webServer'], (sctx) => {
    const webServer = sctx.get('webServer') as WebRouteRegistrar | undefined
    if (webServer === undefined) return
    sctx.effect(() => webServer.register({
      kind: 'prefix',
      path: ADMIN_PREFIX,
      handler: (req, res) => void handle(req, res, deps),
    }), 'gitlab: admin routes')
  })
}

/** One JSON response; never carries a token value. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Read and parse a JSON request body; undefined for an empty body. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** One validated site write from the panel. */
interface ParsedSite {
  readonly id: string
  readonly site: SiteConfig
}

/** Validate a site write body; returns the normalized write or the problem text. */
function parseSite(body: unknown): ParsedSite | string {
  if (typeof body !== 'object' || body === null) return 'request body must be a JSON object'
  const record = body as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!SITE_ID_PATTERN.test(id)) {
    return `site id must match ${String(SITE_ID_PATTERN)}`
  }
  const site = record.site
  if (typeof site !== 'object' || site === null) return 'site must be a JSON object'
  const fields = site as Record<string, unknown>
  const baseUrl = fields.baseUrl
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') return 'site.baseUrl must be a non-empty string'
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return `site.baseUrl is not a valid URL: ${baseUrl}`
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'site.baseUrl must be http(s)'
  const providerRaw = fields.provider
  let provider: ForgeProvider
  if (providerRaw === undefined) provider = 'gitlab'
  else if (providerRaw === 'gitlab' || providerRaw === 'github') provider = providerRaw
  else return `site.provider must be "gitlab" or "github", got ${JSON.stringify(providerRaw)}`
  const tokenRef = typeof fields.tokenRef === 'string' && fields.tokenRef.trim() !== ''
    ? fields.tokenRef.trim()
    : provider === 'github' ? 'GITHUB_TOKEN' : 'GITLAB_TOKEN'
  try {
    refOf(tokenRef)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  const defaultProject = typeof fields.defaultProject === 'string' && fields.defaultProject.trim() !== ''
    ? fields.defaultProject.trim()
    : undefined
  return {
    id,
    site: {
      provider,
      baseUrl: baseUrl.trim(),
      tokenRef,
      ...defaultProject === undefined ? {} : { defaultProject },
    },
  }
}

/** Dispatch one admin request. */
async function handle(req: IncomingMessage, res: ServerResponse, deps: GitLabAdminDeps): Promise<void> {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  try {
    if (req.method === 'GET' && pathname === `${ADMIN_PREFIX}/state`) {
      const value = deps.store.read()
      const tokens: Record<string, { configured: boolean }> = {}
      for (const site of Object.values(value.sites)) {
        tokens[site.tokenRef] = { configured: deps.store.configured(site.tokenRef) }
      }
      sendJson(res, 200, { defaultSite: value.defaultSite, sites: value.sites, tokens })
      return
    }
    if (req.method === 'POST' && pathname === `${ADMIN_PREFIX}/sites`) {
      const parsed = parseSite(await readJson(req))
      if (typeof parsed === 'string') {
        sendJson(res, 400, { error: parsed })
        return
      }
      const value = deps.store.read()
      await deps.store.write({
        ...value,
        sites: { ...value.sites, [parsed.id]: parsed.site },
      })
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'DELETE' && pathname.startsWith(`${ADMIN_PREFIX}/sites/`)) {
      const id = decodeURIComponent(pathname.slice(`${ADMIN_PREFIX}/sites/`.length))
      const value = deps.store.read()
      if (!(id in value.sites)) {
        sendJson(res, 404, { error: `no such site: ${id}` })
        return
      }
      const sites = { ...value.sites }
      delete sites[id]
      await deps.store.write({ ...value, sites })
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && pathname === `${ADMIN_PREFIX}/token`) {
      const body = (await readJson(req)) as Record<string, unknown> | undefined
      const ref = typeof body?.ref === 'string' ? body.ref : ''
      const value = typeof body?.value === 'string' ? body.value : ''
      let branded: ReturnType<typeof refOf>
      try {
        branded = refOf(ref)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      if (value === '') {
        sendJson(res, 400, { error: 'token value must be a non-empty string' })
        return
      }
      const current = deps.store.read()
      await deps.store.write({ ...current, tokens: { ...current.tokens, [branded]: value } })
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'DELETE' && pathname === `${ADMIN_PREFIX}/token`) {
      const body = (await readJson(req)) as Record<string, unknown> | undefined
      const ref = typeof body?.ref === 'string' ? body.ref : ''
      let branded: ReturnType<typeof refOf>
      try {
        branded = refOf(ref)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      const current = deps.store.read()
      const tokens = { ...current.tokens }
      delete tokens[branded]
      await deps.store.write({ ...current, tokens })
      sendJson(res, 200, { ok: true })
      return
    }
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    return
  }
  sendJson(res, 404, { error: `no such admin endpoint: ${req.method} ${pathname}` })
}
