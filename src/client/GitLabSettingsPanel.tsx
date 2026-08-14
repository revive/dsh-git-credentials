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

/** The panel receives no injected values; it talks to the admin routes directly. */
export interface GitLabSettingsPanelInjected {
  /** Marker: no wire face is injected; the panel uses same-origin fetch. */
  children?: never
}

/** One site as the admin state reports it. */
interface AdminSite {
  provider: 'gitlab' | 'github'
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
  provider: 'gitlab' | 'github'
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
  const [state, setState] = useState<AdminState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, SiteDraft>>({})
  // Which site rows are in edit mode (read-only text by default).
  const [editing, setEditing] = useState<Record<string, boolean>>({})
  // New-site form state.
  const [newId, setNewId] = useState('')
  const [newProvider, setNewProvider] = useState<'gitlab' | 'github'>('gitlab')
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
      setError(`GitLab 插件未加载：${caught instanceof Error ? caught.message : String(caught)}`)
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

  if (state === null) return null

  const siteIds = Object.keys(state.sites)
  return (
    <div style={{ maxWidth: 760, fontSize: 14, lineHeight: 1.6 }}>
      <p style={{ color: '#888' }}>
        在这里管理 Git 凭据（GitLab / GitHub）：站点地址与 token 保存在插件
        自己的加密文件（AES-256-GCM，密钥独立文件，0600）中，token 值不会
        进入模型上下文。修改即时生效，无需重启。
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
              <span style={{ minWidth: 60 }}>{site.provider === 'github' ? 'GitHub' : 'GitLab'}</span>
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
              onChange={event => setDrafts({
                ...drafts,
                [id]: {
                  ...draft,
                  provider: event.target.value === 'github' ? 'github' : 'gitlab',
                  tokenRef: event.target.value === 'github' ? 'GITHUB_TOKEN' : 'GITLAB_TOKEN',
                },
              })}
            >
              <option value="gitlab">GitLab</option>
              <option value="github">GitHub</option>
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
            const provider = event.target.value === 'github' ? 'github' : 'gitlab'
            setNewProvider(provider)
            setNewBaseUrl(provider === 'github' ? 'https://api.github.com' : '')
            setNewTokenRef(provider === 'github' ? 'GITHUB_TOKEN' : 'GITLAB_TOKEN')
          }}
        >
          <option value="gitlab">GitLab</option>
          <option value="github">GitHub</option>
        </select>
        <input
          style={{ ...fieldStyle, width: 200 }}
          placeholder={newProvider === 'github' ? 'https://api.github.com' : 'GitLab 地址，如 https://gitlab.example.com'}
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
