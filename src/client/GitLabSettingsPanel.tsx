/**
 * The Settings → GitLab management panel: add, edit, and delete sites (base
 * URL + token reference) and store or clear each site's token value. All
 * writes go to the plugin's own `/gitlab-admin/*` routes, which the host
 * half registers on the GUI webserver; token values never appear in any
 * response — the panel only ever shows configured state.
 * @module dsh-gitlab-plugin/client
 */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { loadLocale, messagesFor, saveLocale, SUPPORTED_LOCALES, type Locale } from './locale.ts'

/** The panel receives no injected values; it talks to the admin routes directly. */
export interface GitLabSettingsPanelInjected {
  /** Marker: no wire face is injected; the panel uses same-origin fetch. */
  children?: never
}

/**
 * One supported forge provider, as offered in the dropdown. "forgejo" is a
 * distinct dropdown identity for self-hosted Forgejo users (who don't
 * recognize "Gitea" as their platform) but is wire-compatible with Gitea and
 * reuses the GiteaClient adapter server-side — see `adapterFor` in store.ts.
 */
type ProviderId = 'gitlab' | 'github' | 'gitee' | 'gitea' | 'forgejo' | 'bitbucket'

/** Display label per provider. */
const PROVIDER_LABELS: Record<ProviderId, string> = {
  gitlab: 'GitLab',
  github: 'GitHub',
  gitee: 'Gitee',
  gitea: 'Gitea',
  forgejo: 'Forgejo',
  bitbucket: 'Bitbucket',
}

/** Default token reference per provider. */
const DEFAULT_TOKEN_REFS: Record<ProviderId, string> = {
  gitlab: 'GITLAB_TOKEN',
  github: 'GITHUB_TOKEN',
  gitee: 'GITEE_TOKEN',
  gitea: 'GITEA_TOKEN',
  forgejo: 'FORGEJO_TOKEN',
  bitbucket: 'BITBUCKET_TOKEN',
}

/** Default API base URL per provider (empty = user must fill it in). */
const DEFAULT_BASE_URLS: Record<ProviderId, string> = {
  gitlab: '',
  github: 'https://api.github.com',
  gitee: 'https://gitee.com/api/v5',
  gitea: '',
  forgejo: '',
  bitbucket: 'https://api.bitbucket.org/2.0',
}

/** Base-URL input placeholder per provider, per locale. */
const BASE_URL_PLACEHOLDERS: Record<Locale, Record<ProviderId, string>> = {
  en: {
    gitlab: 'GitLab URL, e.g. https://gitlab.example.com',
    github: 'https://api.github.com',
    gitee: 'https://gitee.com/api/v5',
    gitea: 'Gitea URL, e.g. https://gitea.example.com/api/v1',
    forgejo: 'Forgejo URL, e.g. https://forgejo.example.com/api/v1',
    bitbucket: 'https://api.bitbucket.org/2.0',
  },
  zh: {
    gitlab: 'GitLab 地址，如 https://gitlab.example.com',
    github: 'https://api.github.com',
    gitee: 'https://gitee.com/api/v5',
    gitea: 'Gitea 地址，如 https://gitea.example.com/api/v1',
    forgejo: 'Forgejo 地址，如 https://forgejo.example.com/api/v1',
    bitbucket: 'https://api.bitbucket.org/2.0',
  },
}

/** One site as the admin state reports it. */
interface AdminSite {
  provider: ProviderId
  baseUrl: string
  tokenRef: string
  defaultProject?: string
}

/** Token state of one reference, as the admin state reports it. */
interface AdminToken {
  configured: boolean
  source?: string
}

/** The loaded admin state. */
interface AdminState {
  defaultSite?: string
  sites: Record<string, AdminSite>
  tokens: Record<string, AdminToken>
}

/** One site's editable draft (local state; token never round-trips). */
interface SiteDraft {
  provider: ProviderId
  baseUrl: string
  tokenRef: string
  defaultProject: string
  token: string
}

/** Field style shared by every input and button row. */
const fieldStyle: CSSProperties = {
  marginRight: 8,
  padding: '4px 8px',
  borderRadius: 4,
  border: '1px solid #8884',
  background: 'transparent',
  color: 'inherit',
}

/** Secondary action: edit, cancel, save-token, clear-token — outlined, same visual weight as before. */
const buttonStyle: CSSProperties = {
  padding: '4px 12px',
  borderRadius: 4,
  border: '1px solid #8884',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
}

/** Primary action: the one commit button per row (Save / Add site) — visually distinct from secondary actions. */
const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  border: '1px solid #2f6feb99',
  background: '#2f6feb1f',
  color: '#2f6feb',
  fontWeight: 600,
}

/** Destructive action: delete a site — kept visually separate (color + right alignment) from routine actions. */
const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  border: '1px solid #e5484d88',
  color: '#e5484d',
  marginLeft: 'auto',
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  padding: '8px 0',
  borderBottom: '1px solid #8882',
}

/** One site's block: fields row + actions row stacked, bordered as a unit. */
const siteBlockStyle: CSSProperties = {
  padding: '8px 0',
  borderBottom: '1px solid #8882',
}

/** A row of inputs/selects within a site block (no border — the block carries it). */
const fieldsRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
}

/** A row of buttons within a site block, visually separated from the fields above it. */
const actionsRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  marginTop: 8,
}

/** GET one admin endpoint. */
async function adminGet(path: string): Promise<unknown> {
  const response = await fetch(path)
  const body = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP ${response.status}`
    throw new Error(message)
  }
  return body
}

/** POST or DELETE one admin endpoint with a JSON body. */
async function adminWrite(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<void> {
  const response = await fetch(path, {
    method,
    ...body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined)
    const message = typeof payload === 'object' && payload !== null && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : `HTTP ${response.status}`
    throw new Error(message)
  }
}

/**
 * The GitLab settings section. Slot-delivered injected props arrive spread
 * flat; the shell injects asynchronously, so render nothing until the inject
 * face lands.
 * @param props - the slot-delivered inject face (marker only).
 * @returns the panel, or null while the shell has not injected yet.
 */
export function GitLabSettingsPanel(props: GitLabSettingsPanelInjected): ReactNode {
  if (props === undefined) return null
  return <Loaded />
}

/** The mounted panel body: local state only, every write via the admin routes. */
function Loaded(): ReactNode {
  const [locale, setLocale] = useState<Locale>(() => loadLocale())
  const t = messagesFor(locale)
  const [state, setState] = useState<AdminState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, SiteDraft>>({})
  // Which site rows are in edit mode (read-only text by default).
  const [editing, setEditing] = useState<Record<string, boolean>>({})
  // New-site form state.
  const [newId, setNewId] = useState('')
  const [newProvider, setNewProvider] = useState<ProviderId>('gitlab')
  const [newBaseUrl, setNewBaseUrl] = useState('')
  const [newTokenRef, setNewTokenRef] = useState('GITLAB_TOKEN')
  const [newToken, setNewToken] = useState('')
  const [newDefaultProject, setNewDefaultProject] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      setState(await adminGet('/git-credentials-admin/state') as AdminState)
    } catch (caught) {
      setState(null)
      setError(t.loadFailed(caught instanceof Error ? caught.message : String(caught)))
    }
  }, [locale])

  useEffect(() => { void load() }, [load])

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [load])

  if (state === null) return null

  const siteIds = Object.keys(state.sites)
  return (
    <div style={{ maxWidth: 760, fontSize: 14, lineHeight: 1.6 }}>
      <div style={{ ...rowStyle, justifyContent: 'flex-end', borderBottom: 'none', padding: 0 }}>
        <select
          style={{ ...fieldStyle, marginRight: 0 }}
          value={locale}
          onChange={event => {
            const next = event.target.value as Locale
            setLocale(next)
            saveLocale(next)
          }}
        >
          {SUPPORTED_LOCALES.map(code => (
            <option key={code} value={code}>{code === 'en' ? 'English' : '中文'}</option>
          ))}
        </select>
      </div>
      <p style={{ color: '#888' }}>{t.intro}</p>
      <div style={rowStyle}>
        <button style={buttonStyle} onClick={() => void load()} disabled={busy}>{t.refresh}</button>
        {busy && <span>{t.saving}</span>}
        {error !== null && <span style={{ color: '#e5484d' }}>{error}</span>}
      </div>

      {siteIds.map(id => {
        const site = state.sites[id]!
        const token = state.tokens[site.tokenRef]
        const draft = drafts[id] ?? {
          provider: site.provider,
          baseUrl: site.baseUrl,
          tokenRef: site.tokenRef,
          defaultProject: site.defaultProject ?? '',
          token: '',
        }
        const isEditing = editing[id] === true
        const status = (
          <span style={{ color: token?.configured === true ? '#30a46c' : '#e5484d', fontSize: 12 }}>
            {token?.configured === true ? t.tokenConfigured(token.source ?? '?') : t.tokenNotConfigured}
          </span>
        )
        const beginEdit = (): void => setEditing({ ...editing, [id]: true })
        const cancelEdit = (): void => {
          const next = { ...drafts }
          delete next[id]
          setDrafts(next)
          setEditing({ ...editing, [id]: false })
        }
        if (!isEditing) {
          return (
            <div key={id} style={rowStyle}>
              <strong style={{ minWidth: 80 }}>{id}</strong>
              <span style={{ minWidth: 60 }}>{PROVIDER_LABELS[site.provider]}</span>
              <span style={fieldStyle} title={t.apiUrlTitle}>{site.baseUrl}</span>
              <span style={fieldStyle} title={t.tokenRefTitle}>{site.tokenRef}</span>
              <span style={{ ...fieldStyle, width: 120, color: site.defaultProject === undefined ? '#888' : 'inherit' }}>
                {site.defaultProject ?? t.defaultProjectFallback}
              </span>
              {status}
              <button style={{ ...buttonStyle, marginLeft: 'auto' }} disabled={busy} onClick={beginEdit}>{t.edit}</button>
            </div>
          )
        }
        return (
          <div key={id} style={siteBlockStyle}>
            <div style={fieldsRowStyle}>
              <strong style={{ minWidth: 80 }}>{id}</strong>
              <select
                style={fieldStyle}
                value={draft.provider}
                onChange={event => {
                  const provider = event.target.value as ProviderId
                  setDrafts({
                    ...drafts,
                    [id]: { ...draft, provider, tokenRef: DEFAULT_TOKEN_REFS[provider] },
                  })
                }}
              >
                <option value="gitlab">GitLab</option>
                <option value="github">GitHub</option>
                <option value="gitee">Gitee</option>
                <option value="gitea">Gitea</option>
                <option value="forgejo">Forgejo</option>
                <option value="bitbucket">Bitbucket</option>
              </select>
              <input
                style={{ ...fieldStyle, width: 200 }}
                value={draft.baseUrl}
                onChange={event => setDrafts({ ...drafts, [id]: { ...draft, baseUrl: event.target.value } })}
              />
              <input
                style={{ ...fieldStyle, width: 150 }}
                title={t.tokenRefTitle}
                value={draft.tokenRef}
                onChange={event => setDrafts({ ...drafts, [id]: { ...draft, tokenRef: event.target.value } })}
              />
              <input
                style={{ ...fieldStyle, width: 120 }}
                title={t.defaultProjectPlaceholder}
                placeholder={t.defaultProjectPlaceholder}
                value={draft.defaultProject}
                onChange={event => setDrafts({ ...drafts, [id]: { ...draft, defaultProject: event.target.value } })}
              />
              {status}
            </div>
            <div style={actionsRowStyle}>
              <button
                style={primaryButtonStyle}
                disabled={busy}
                onClick={() => void run(async () => {
                  await adminWrite('POST', '/git-credentials-admin/sites', {
                    id,
                    site: {
                      provider: draft.provider,
                      baseUrl: draft.baseUrl.trim(),
                      tokenRef: draft.tokenRef.trim(),
                      ...draft.defaultProject.trim() === '' ? {} : { defaultProject: draft.defaultProject.trim() },
                    },
                  })
                  if (draft.token.trim() !== '') {
                    await adminWrite('POST', '/git-credentials-admin/token', { ref: draft.tokenRef.trim(), value: draft.token })
                  }
                  setDrafts({ ...drafts, [id]: { ...draft, token: '' } })
                  setEditing({ ...editing, [id]: false })
                })}
              >
                {t.save}
              </button>
              <button
                style={buttonStyle}
                disabled={busy}
                onClick={cancelEdit}
              >
                {t.cancel}
              </button>
              <span style={{ width: 1, alignSelf: 'stretch', background: '#8882' }} />
              <input
                style={{ ...fieldStyle, width: 200, marginRight: 0 }}
                type="password"
                placeholder={t.tokenValuePlaceholder}
                value={draft.token}
                onChange={event => setDrafts({ ...drafts, [id]: { ...draft, token: event.target.value } })}
              />
              <button
                style={buttonStyle}
                disabled={busy || draft.token.trim() === ''}
                onClick={() => void run(async () => {
                  await adminWrite('POST', '/git-credentials-admin/token', {
                    ref: draft.tokenRef.trim(),
                    value: draft.token,
                  })
                  setDrafts({ ...drafts, [id]: { ...draft, token: '' } })
                })}
              >
                {t.saveToken}
              </button>
              {token?.configured === true && (
                <button
                  style={buttonStyle}
                  disabled={busy}
                  onClick={() => void run(async () => {
                    await adminWrite('DELETE', '/git-credentials-admin/token', { ref: site.tokenRef })
                  })}
                >
                  {t.clearToken}
                </button>
              )}
              <button
                style={dangerButtonStyle}
                disabled={busy}
                onClick={() => void run(async () => {
                  await adminWrite('DELETE', `/git-credentials-admin/sites/${encodeURIComponent(id)}`)
                })}
              >
                {t.deleteSite}
              </button>
            </div>
          </div>
        )
      })}

      {siteIds.length === 0 && (
        <p style={{ color: '#888' }}>{t.noSites}</p>
      )}

      <div style={{ borderTop: '1px solid #8884', marginTop: 8, paddingTop: 8 }}>
        <div style={fieldsRowStyle}>
          <input
            style={{ ...fieldStyle, width: 100 }}
            placeholder={t.siteIdPlaceholder}
            value={newId}
            onChange={event => setNewId(event.target.value)}
          />
          <select
            style={fieldStyle}
            value={newProvider}
            onChange={event => {
              const provider = event.target.value as ProviderId
              setNewProvider(provider)
              setNewBaseUrl(DEFAULT_BASE_URLS[provider])
              setNewTokenRef(DEFAULT_TOKEN_REFS[provider])
            }}
          >
            <option value="gitlab">GitLab</option>
            <option value="github">GitHub</option>
            <option value="gitee">Gitee</option>
            <option value="gitea">Gitea</option>
            <option value="forgejo">Forgejo</option>
            <option value="bitbucket">Bitbucket</option>
          </select>
          <input
            style={{ ...fieldStyle, width: 200 }}
            placeholder={BASE_URL_PLACEHOLDERS[locale][newProvider]}
            value={newBaseUrl}
            onChange={event => setNewBaseUrl(event.target.value)}
          />
          <input
            style={{ ...fieldStyle, width: 150 }}
            placeholder={t.tokenRefPlaceholder}
            value={newTokenRef}
            onChange={event => setNewTokenRef(event.target.value)}
          />
          <input
            style={{ ...fieldStyle, width: 120 }}
            placeholder={t.defaultProjectPlaceholder}
            value={newDefaultProject}
            onChange={event => setNewDefaultProject(event.target.value)}
          />
        </div>
        <div style={actionsRowStyle}>
          <input
            style={{ ...fieldStyle, width: 200 }}
            type="password"
            placeholder={t.tokenValuePlaceholder}
            value={newToken}
            onChange={event => setNewToken(event.target.value)}
          />
          <button
            style={buttonStyle}
            disabled={busy || newToken.trim() === ''}
            onClick={() => void run(async () => {
              await adminWrite('POST', '/git-credentials-admin/token', { ref: newTokenRef.trim(), value: newToken })
              setNewToken('')
            })}
          >
            {t.saveToken}
          </button>
          <button
            style={{ ...primaryButtonStyle, marginLeft: 'auto' }}
            disabled={busy || newId.trim() === '' || newBaseUrl.trim() === ''}
            onClick={() => void run(async () => {
              await adminWrite('POST', '/git-credentials-admin/sites', {
                id: newId.trim(),
                site: {
                  provider: newProvider,
                  baseUrl: newBaseUrl.trim(),
                  tokenRef: newTokenRef.trim(),
                  ...newDefaultProject.trim() === '' ? {} : { defaultProject: newDefaultProject.trim() },
                },
              })
              if (newToken.trim() !== '') {
                await adminWrite('POST', '/git-credentials-admin/token', { ref: newTokenRef.trim(), value: newToken })
              }
              setNewId('')
              setNewProvider('gitlab')
              setNewBaseUrl('')
              setNewTokenRef('GITLAB_TOKEN')
              setNewToken('')
              setNewDefaultProject('')
            })}
          >
            {t.addSite}
          </button>
        </div>
      </div>
    </div>
  )
}
