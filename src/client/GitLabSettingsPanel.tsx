/**
 * The Settings → Git 凭据 management panel: add, edit, and delete sites
 * (base URL + token reference) for every supported forge provider, and store
 * or clear each site's token value. All writes go to the plugin's own
 * `/git-credentials-admin/*` routes, which the host half registers on the GUI
 * webserver; token values never appear in any response — the panel only ever
 * shows configured state.
 *
 * The panel is a `settings.section` list entry of the current slot standard:
 * it receives the composed section props (owner `close` plus the standard
 * kit) and injects nothing. A failed admin read renders its error with a
 * retry affordance instead of a permanently blank content column.
 * @module dsh-git-credentials/client
 */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { ComposedProps, EntryKeyOf } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/** The composed props of one settings.section entry (the panel consumes none of them). */
export type GitLabSettingsPanelProps = ComposedProps<
  'settings.section', EntryKeyOf<'settings.section'>, never, undefined, object
>

/** One supported forge provider. */
type ProviderId = 'gitlab' | 'github' | 'gitee' | 'gitea' | 'bitbucket'

/** Display label per provider. */
const PROVIDER_LABELS: Record<ProviderId, string> = {
  gitlab: 'GitLab',
  github: 'GitHub',
  gitee: 'Gitee',
  gitea: 'Gitea',
  bitbucket: 'Bitbucket',
}

/** Default token reference per provider. */
const DEFAULT_TOKEN_REFS: Record<ProviderId, string> = {
  gitlab: 'GITLAB_TOKEN',
  github: 'GITHUB_TOKEN',
  gitee: 'GITEE_TOKEN',
  gitea: 'GITEA_TOKEN',
  bitbucket: 'BITBUCKET_TOKEN',
}

/** Default API base URL per provider (empty = user must fill it in). */
const DEFAULT_BASE_URLS: Record<ProviderId, string> = {
  gitlab: '',
  github: 'https://api.github.com',
  gitee: 'https://gitee.com/api/v5',
  gitea: '',
  bitbucket: 'https://api.bitbucket.org/2.0',
}

/** Base-URL input placeholder per provider. */
const BASE_URL_PLACEHOLDERS: Record<ProviderId, string> = {
  gitlab: 'GitLab 地址，如 https://gitlab.example.com',
  github: 'https://api.github.com',
  gitee: 'https://gitee.com/api/v5',
  gitea: 'Gitea 地址，如 https://gitea.example.com/api/v1',
  bitbucket: 'https://api.bitbucket.org/2.0',
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

const buttonStyle: CSSProperties = {
  padding: '4px 12px',
  borderRadius: 4,
  border: '1px solid #8884',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  marginRight: 8,
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  padding: '8px 0',
  borderBottom: '1px solid #8882',
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
 * The Git 凭据 settings section. The composed section props are unused — the
 * panel talks to the admin routes directly.
 * @param _props - the composed settings.section props (unused).
 * @returns the panel.
 */
export function GitLabSettingsPanel(_props: GitLabSettingsPanelProps): ReactNode {
  return <Loaded />
}

/** The mounted panel body: local state only, every write via the admin routes. */
function Loaded(): ReactNode {
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
      setError(`Git 凭据管理暂不可用：${caught instanceof Error ? caught.message : String(caught)}`)
    }
  }, [])

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

  // While the first read is in flight show a loading line; once a read has
  // failed, show the error WITH a retry instead of a blank content column —
  // a silent blank here is indistinguishable from a broken registration.
  if (state === null) {
    if (error === null) return <p style={{ maxWidth: 760, color: '#888', fontSize: 14 }}>加载中…</p>
    return (
      <div style={{ maxWidth: 760, fontSize: 14, lineHeight: 1.6 }}>
        <p style={{ color: '#e5484d' }}>{error}</p>
        <div style={rowStyle}>
          <button style={buttonStyle} onClick={() => void load()} disabled={busy}>重试</button>
        </div>
      </div>
    )
  }

  const siteIds = Object.keys(state.sites)
  return (
    <div style={{ maxWidth: 760, fontSize: 14, lineHeight: 1.6 }}>
      <p style={{ color: '#888' }}>
        在这里管理 Git 凭据（GitLab / GitHub / Gitee / Gitea / Bitbucket）：
        站点地址与 token 保存在插件自己的加密文件（AES-256-GCM，密钥独立
        文件，0600）中，token 值不会进入模型上下文。修改即时生效，无需重启。
      </p>
      <div style={rowStyle}>
        <button style={buttonStyle} onClick={() => void load()} disabled={busy}>刷新</button>
        {busy && <span>保存中…</span>}
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
            {token?.configured === true ? `token 已配置（${token.source ?? '?'}）` : 'token 未配置'}
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
              <span style={fieldStyle} title="API 地址">{site.baseUrl}</span>
              <span style={fieldStyle} title="token 引用名">{site.tokenRef}</span>
              <span style={{ ...fieldStyle, width: 120, color: site.defaultProject === undefined ? '#888' : 'inherit' }}>
                {site.defaultProject ?? '默认项目：—'}
              </span>
              {status}
              <button style={buttonStyle} disabled={busy} onClick={beginEdit}>编辑</button>
            </div>
          )
        }
        return (
          <div key={id} style={rowStyle}>
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
              <option value="bitbucket">Bitbucket</option>
            </select>
            <input
              style={{ ...fieldStyle, width: 200 }}
              value={draft.baseUrl}
              onChange={event => setDrafts({ ...drafts, [id]: { ...draft, baseUrl: event.target.value } })}
            />
            <input
              style={{ ...fieldStyle, width: 150 }}
              title="token 引用名"
              value={draft.tokenRef}
              onChange={event => setDrafts({ ...drafts, [id]: { ...draft, tokenRef: event.target.value } })}
            />
            <input
              style={{ ...fieldStyle, width: 120 }}
              title="默认项目（可选）"
              placeholder="默认项目"
              value={draft.defaultProject}
              onChange={event => setDrafts({ ...drafts, [id]: { ...draft, defaultProject: event.target.value } })}
            />
            {status}
            <button
              style={buttonStyle}
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
              保存
            </button>
            <button
              style={buttonStyle}
              disabled={busy}
              onClick={cancelEdit}
            >
              取消
            </button>
            <input
              style={{ ...fieldStyle, width: 200 }}
              type="password"
              placeholder="输入 token 值（可选）"
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
              保存 Token
            </button>
            {token?.configured === true && (
              <button
                style={buttonStyle}
                disabled={busy}
                onClick={() => void run(async () => {
                  await adminWrite('DELETE', '/git-credentials-admin/token', { ref: site.tokenRef })
                })}
              >
                清除 Token
              </button>
            )}
            <button
              style={{ ...buttonStyle, color: '#e5484d' }}
              disabled={busy}
              onClick={() => void run(async () => {
                await adminWrite('DELETE', `/git-credentials-admin/sites/${encodeURIComponent(id)}`)
              })}
            >
              删除站点
            </button>
          </div>
        )
      })}

      {siteIds.length === 0 && (
        <p style={{ color: '#888' }}>还没有站点。在下方添加第一个 Git 凭据站点。</p>
      )}

      <div style={{ ...rowStyle, borderTop: '1px solid #8884', marginTop: 8 }}>
        <input
          style={{ ...fieldStyle, width: 100 }}
          placeholder="站点 id，如 corp"
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
          <option value="bitbucket">Bitbucket</option>
        </select>
        <input
          style={{ ...fieldStyle, width: 200 }}
          placeholder={BASE_URL_PLACEHOLDERS[newProvider]}
          value={newBaseUrl}
          onChange={event => setNewBaseUrl(event.target.value)}
        />
        <input
          style={{ ...fieldStyle, width: 150 }}
          placeholder="token 引用名"
          value={newTokenRef}
          onChange={event => setNewTokenRef(event.target.value)}
        />
        <input
          style={{ ...fieldStyle, width: 200 }}
          type="password"
          placeholder="token 值（可选）"
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
          保存 Token
        </button>
        <input
          style={{ ...fieldStyle, width: 120 }}
          placeholder="默认项目（可选）"
          value={newDefaultProject}
          onChange={event => setNewDefaultProject(event.target.value)}
        />
        <button
          style={buttonStyle}
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
          添加站点
        </button>
      </div>
    </div>
  )
}
