/**
 * The Settings → Git 凭据 management panel: add, edit, and delete sites
 * (provider + API base URL + token reference) and store or clear each site's
 * token value. Every write goes to the plugin's own `/git-credentials-admin/*`
 * routes, which the host half registers on the GUI webserver; token values never
 * appear in any response, so the panel only ever shows configured state.
 *
 * The panel is a `settings.section` list entry of the current slot standard: it
 * receives the composed section props and injects nothing. A failed admin read
 * renders its error with a retry affordance instead of a permanently blank
 * content column.
 *
 * Styling follows the Host page the panel sits beside (see ./panel-css.ts):
 * controls are the plugin's own markup and CSS, and the only thing shared with
 * the Host is the `--dsw-*` theme tokens.
 * @module dsh-git-credentials/client
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ComposedProps, EntryKeyOf } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { adminGet, adminWrite } from './admin-api.ts'
import type { AdminSite, AdminState, AdminToken, ProviderId } from './admin-api.ts'
import {
  BASE_URL_PLACEHOLDERS, DEFAULT_BASE_URLS, DEFAULT_TOKEN_REFS, PROVIDER_LABELS, PROVIDER_ORDER,
  SITE_ID_HELP, TOKEN_REF_HELP, baseUrlProblem, isStockBaseUrl, isStockTokenRef, siteIdProblem,
  tokenRefProblem,
} from './site-model.ts'
import { PANEL_CSS } from './panel-css.ts'

/** The composed props of one settings.section entry (the panel consumes none of them). */
export type GitLabSettingsPanelProps = ComposedProps<
  'settings.section', EntryKeyOf<'settings.section'>, never, undefined, object
>

/** One site's editable draft (the token value never round-trips from the server). */
interface SiteDraft {
  provider: ProviderId
  baseUrl: string
  tokenRef: string
  defaultProject: string
  token: string
}

/** The add-site draft: a configured site's fields plus the id it will be stored under. */
interface AddDraft extends SiteDraft {
  id: string
}

/** The pristine add-site draft. */
const EMPTY_ADD: AddDraft = {
  id: '',
  provider: 'gitlab',
  baseUrl: '',
  tokenRef: DEFAULT_TOKEN_REFS.gitlab,
  token: '',
  defaultProject: '',
}

/** A no-op edit handler for the read-only sites. */
const noop = (): void => {}

/** The editable draft of a configured site. */
function draftOf(site: AdminSite): SiteDraft {
  return {
    provider: site.provider,
    baseUrl: site.baseUrl,
    tokenRef: site.tokenRef,
    defaultProject: site.defaultProject ?? '',
    token: '',
  }
}

/** The message of an unknown thrown value. */
function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught)
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
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, SiteDraft>>({})
  // Which site cards are in edit mode (read-only facts by default).
  const [editing, setEditing] = useState<Record<string, boolean>>({})
  const [add, setAdd] = useState<AddDraft>(EMPTY_ADD)
  // The add form reports problems once something has been typed, so its rules
  // read as help on first sight instead of as errors.
  const [addTouched, setAddTouched] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      setState(await adminGet('/git-credentials-admin/state') as AdminState)
    } catch (caught) {
      setState(null)
      setError(`Git 凭据管理暂不可用：${messageOf(caught)}`)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const run = useCallback(async (action: () => Promise<void>, done: string): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      await load()
      setNotice(done)
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }, [load])

  /** Write one site and, when the draft carries a fresh token, that token too. */
  const writeSite = async (id: string, draft: SiteDraft): Promise<void> => {
    const tokenRef = draft.tokenRef.trim()
    await adminWrite('POST', '/git-credentials-admin/sites', {
      id,
      site: {
        provider: draft.provider,
        baseUrl: draft.baseUrl.trim(),
        tokenRef,
        ...draft.defaultProject.trim() === '' ? {} : { defaultProject: draft.defaultProject.trim() },
      },
    })
    if (draft.token !== '') {
      await adminWrite('POST', '/git-credentials-admin/token', { ref: tokenRef, value: draft.token })
    }
  }

  const editAdd = useCallback((patch: Partial<AddDraft>): void => {
    setAddTouched(true)
    setAdd(previous => ({ ...previous, ...patch }))
  }, [])

  const pickAddProvider = useCallback((provider: ProviderId): void => {
    setAddTouched(true)
    setAdd(previous => ({
      ...previous,
      provider,
      // Only a stock value is replaced: what the user typed stays.
      baseUrl: isStockBaseUrl(previous.baseUrl) ? DEFAULT_BASE_URLS[provider] : previous.baseUrl,
      tokenRef: isStockTokenRef(previous.tokenRef) ? DEFAULT_TOKEN_REFS[provider] : previous.tokenRef,
    }))
  }, [])

  const addSite = (): void => {
    const id = add.id.trim()
    void run(async () => {
      await writeSite(id, add)
      setAdd(EMPTY_ADD)
      setAddTouched(false)
    }, `已保存站点 ${id}`)
  }

  const updateSite = (id: string, draft: SiteDraft): void => {
    void run(async () => {
      await writeSite(id, draft)
      setDrafts(previous => {
        const next = { ...previous }
        delete next[id]
        return next
      })
      setEditing(previous => ({ ...previous, [id]: false }))
    }, `已保存站点 ${id}`)
  }

  const deleteSite = (id: string): void => {
    void run(async () => {
      await adminWrite('DELETE', `/git-credentials-admin/sites/${encodeURIComponent(id)}`)
      setDrafts(previous => {
        const next = { ...previous }
        delete next[id]
        return next
      })
      setEditing(previous => ({ ...previous, [id]: false }))
    }, `已删除站点 ${id}`)
  }

  const clearToken = (ref: string): void => {
    void run(async () => {
      await adminWrite('DELETE', '/git-credentials-admin/token', { ref })
    }, `已清除 ${ref} 的 token`)
  }

  const startEdit = (id: string, site: AdminSite): void => {
    setNotice(null)
    setDrafts(previous => ({ ...previous, [id]: draftOf(site) }))
    setEditing(previous => ({ ...previous, [id]: true }))
  }

  const cancelEdit = (id: string): void => {
    setDrafts(previous => {
      const next = { ...previous }
      delete next[id]
      return next
    })
    setEditing(previous => ({ ...previous, [id]: false }))
  }

  const pickDraftProvider = (id: string, provider: ProviderId): void => {
    setDrafts(previous => {
      const draft = previous[id]
      if (draft === undefined) return previous
      return {
        ...previous,
        [id]: {
          ...draft,
          provider,
          baseUrl: isStockBaseUrl(draft.baseUrl) ? DEFAULT_BASE_URLS[provider] : draft.baseUrl,
          tokenRef: isStockTokenRef(draft.tokenRef) ? DEFAULT_TOKEN_REFS[provider] : draft.tokenRef,
        },
      }
    })
  }

  // While the first read is in flight show a loading line; once a read has
  // failed, show the error WITH a retry instead of a blank content column — a
  // silent blank here is indistinguishable from a broken registration.
  if (state === null) {
    return (
      <Panel>
        {error === null
          ? <p className="dshgc-muted">加载中…</p>
          : (
            <>
              <p className="dshgc-error" role="alert">{error}</p>
              <div className="dshgc-actions">
                <Button disabled={busy} onClick={() => void load()}>重试</Button>
              </div>
            </>
          )}
      </Panel>
    )
  }

  const ids = Object.keys(state.sites)
  const addIdProblem = siteIdProblem(add.id, ids)
  const addUrlProblem = baseUrlProblem(add.baseUrl)
  const addRefProblem = tokenRefProblem(add.tokenRef)
  const addBlocked = addIdProblem !== null || addUrlProblem !== null || addRefProblem !== null

  return (
    <Panel>
      <p className="dshgc-intro">
        GitLab、GitHub、Gitee、Gitea、Bitbucket 的站点（API 地址与凭据）。token 值只写入本地加密存储，任何响应都不回显。
      </p>
      <div className="dshgc-status">
        <Button disabled={busy} onClick={() => void load()}>刷新</Button>
        {busy && <span className="dshgc-muted">处理中…</span>}
        {!busy && error === null && notice !== null && <span className="dshgc-ok">{notice}</span>}
        {error !== null && <span className="dshgc-error" role="alert">{error}</span>}
      </div>

      <h3 className="dshgc-heading">已配置的站点{ids.length === 0 ? '' : ` · ${ids.length}`}</h3>
      {ids.length === 0
        ? <p className="dshgc-empty">还没有站点。用下面的「新增站点」添加第一个。</p>
        : (
          <ul className="dshgc-cards">
            {ids.map(id => {
              const site = state.sites[id]
              if (site === undefined) return null
              const token = state.tokens[site.tokenRef]
              const draft = drafts[id]
              return (
                <li className="dshgc-card" key={id}>
                  {editing[id] === true && draft !== undefined
                    ? (
                      <SiteEditor
                        id={id}
                        draft={draft}
                        token={token}
                        busy={busy}
                        onChange={patch => setDrafts(previous => {
                          const current = previous[id]
                          if (current === undefined) return previous
                          return { ...previous, [id]: { ...current, ...patch } }
                        })}
                        onPickProvider={provider => pickDraftProvider(id, provider)}
                        onSave={() => updateSite(id, draft)}
                        onCancel={() => cancelEdit(id)}
                        onDelete={() => deleteSite(id)}
                        onClearToken={() => clearToken(draft.tokenRef.trim())}
                      />
                    )
                    : (
                      <SiteFacts
                        id={id}
                        site={site}
                        token={token}
                        isDefault={state.defaultSite === id}
                        busy={busy}
                        onEdit={() => startEdit(id, site)}
                        onDelete={() => deleteSite(id)}
                      />
                    )}
                </li>
              )
            })}
          </ul>
        )}

      <h3 className="dshgc-heading">新增站点</h3>
      <div className="dshgc-card">
        <Field
          id="dshgc-add-id" label="站点 id" text={add.id} disabled={busy}
          hint={SITE_ID_HELP} placeholder="corp"
          problem={addTouched ? addIdProblem : null}
          onEdit={value => editAdd({ id: value })}
        />
        <ProviderField id="dshgc-add-provider" value={add.provider} disabled={busy} onChange={pickAddProvider} />
        <Field
          id="dshgc-add-url" label="API 地址" text={add.baseUrl} disabled={busy}
          hint="该平台的 API 根地址" placeholder={BASE_URL_PLACEHOLDERS[add.provider]}
          problem={addTouched ? addUrlProblem : null}
          onEdit={value => editAdd({ baseUrl: value })}
        />
        <Field
          id="dshgc-add-ref" label="token 引用名" text={add.tokenRef} disabled={busy}
          hint={TOKEN_REF_HELP} problem={addTouched ? addRefProblem : null}
          onEdit={value => editAdd({ tokenRef: value })}
        />
        <Field
          id="dshgc-add-token" label="token 值" type="password" text={add.token} disabled={busy}
          hint="可选：留空表示暂不设置，之后可在站点卡片里补上" problem={null}
          onEdit={value => editAdd({ token: value })}
        />
        <Field
          id="dshgc-add-project" label="默认项目（可选）" text={add.defaultProject} disabled={busy}
          hint="工具调用未传 project 时使用，例如 owner/repo" problem={null}
          onEdit={value => editAdd({ defaultProject: value })}
        />
        <div className="dshgc-actions dshgc-actionsEnd dshgc-divider">
          <Button variant="primary" disabled={busy || addBlocked} onClick={addSite}>保存</Button>
        </div>
      </div>
    </Panel>
  )
}

/** The section shell: the stylesheet travels with the panel. */
function Panel(props: { children: ReactNode }): ReactNode {
  return (
    <div className="dshgc-section">
      <style>{PANEL_CSS}</style>
      {props.children}
    </div>
  )
}

/** One site in read-only form: the facts, the token state, and the row actions. */
function SiteFacts(props: {
  id: string
  site: AdminSite
  token: AdminToken | undefined
  isDefault: boolean
  busy: boolean
  onEdit: () => void
  onDelete: () => void
}): ReactNode {
  return (
    <>
      <div className="dshgc-cardHead">
        <span className="dshgc-siteId">{props.id}</span>
        <span className="dshgc-tag">{PROVIDER_LABELS[props.site.provider]}</span>
        {props.isDefault && <span className="dshgc-tag">默认站点</span>}
        <span className="dshgc-spacer" />
        <StatusTag configured={props.token?.configured === true} />
      </div>
      <dl className="dshgc-facts">
        <dt className="dshgc-factKey">API 地址</dt>
        <dd className="dshgc-factValue">{props.site.baseUrl}</dd>
        <dt className="dshgc-factKey">token 引用</dt>
        <dd className="dshgc-factValue">{props.site.tokenRef}</dd>
        <dt className="dshgc-factKey">默认项目</dt>
        <dd className="dshgc-factValue">{props.site.defaultProject ?? '—'}</dd>
      </dl>
      <div className="dshgc-actions dshgc-actionsEnd">
        <Button size="sm" disabled={props.busy} onClick={props.onEdit}>编辑</Button>
        <Button size="sm" danger disabled={props.busy} onClick={props.onDelete}>删除站点</Button>
      </div>
    </>
  )
}

/** One site in edit form: every field in one column, one save for all of them. */
function SiteEditor(props: {
  id: string
  draft: SiteDraft
  token: AdminToken | undefined
  busy: boolean
  onChange: (patch: Partial<SiteDraft>) => void
  onPickProvider: (provider: ProviderId) => void
  onSave: () => void
  onCancel: () => void
  onDelete: () => void
  onClearToken: () => void
}): ReactNode {
  const urlProblem = baseUrlProblem(props.draft.baseUrl)
  const refProblem = tokenRefProblem(props.draft.tokenRef)
  const configured = props.token?.configured === true
  return (
    <>
      <div className="dshgc-cardHead">
        <span className="dshgc-siteId">{props.id}</span>
        <span className="dshgc-tag">编辑中</span>
      </div>
      <Field
        id={`dshgc-site-${props.id}-id`} label="站点 id" text={props.id} disabled
        hint="站点 id 是存储键，不可修改；需要改名请删除后重新添加" problem={null} onEdit={noop}
      />
      <ProviderField
        id={`dshgc-site-${props.id}-provider`} value={props.draft.provider}
        disabled={props.busy} onChange={props.onPickProvider}
      />
      <Field
        id={`dshgc-site-${props.id}-url`} label="API 地址" text={props.draft.baseUrl} disabled={props.busy}
        hint="该平台的 API 根地址" placeholder={BASE_URL_PLACEHOLDERS[props.draft.provider]}
        problem={urlProblem} onEdit={value => props.onChange({ baseUrl: value })}
      />
      <Field
        id={`dshgc-site-${props.id}-ref`} label="token 引用名" text={props.draft.tokenRef}
        disabled={props.busy} hint={TOKEN_REF_HELP} problem={refProblem}
        onEdit={value => props.onChange({ tokenRef: value })}
      />
      <Field
        id={`dshgc-site-${props.id}-token`} label="token 值" type="password" text={props.draft.token}
        disabled={props.busy} problem={null}
        hint={configured ? '已配置；留空表示保持当前值不变' : '尚未配置；填写后随「保存」一起写入'}
        onEdit={value => props.onChange({ token: value })}
        head={(
          <>
            <StatusTag configured={configured} />
            {configured && (
              <Button size="sm" danger disabled={props.busy} onClick={props.onClearToken}>清除 Token</Button>
            )}
          </>
        )}
      />
      <Field
        id={`dshgc-site-${props.id}-project`} label="默认项目（可选）" text={props.draft.defaultProject}
        disabled={props.busy} problem={null} hint="工具调用未传 project 时使用"
        onEdit={value => props.onChange({ defaultProject: value })}
      />
      <div className="dshgc-actions dshgc-actionsEnd dshgc-divider">
        <Button size="sm" danger disabled={props.busy} onClick={props.onDelete}>删除站点</Button>
        <span className="dshgc-spacer" />
        <Button size="sm" disabled={props.busy} onClick={props.onCancel}>取消</Button>
        <Button
          variant="primary" disabled={props.busy || urlProblem !== null || refProblem !== null}
          onClick={props.onSave}
        >保存</Button>
      </div>
    </>
  )
}

/**
 * One host-metric labelled field: label, control, and a single message line that
 * shows the problem when there is one and the hint otherwise.
 */
function Field(props: {
  id: string
  label: string
  text: string
  disabled: boolean
  hint: string
  problem: string | null
  onEdit: (text: string) => void
  placeholder?: string
  type?: 'text' | 'password'
  head?: ReactNode
}): ReactNode {
  const messageId = `${props.id}-message`
  const secret = props.type === 'password'
  return (
    <div className="dshgc-field">
      <div className="dshgc-fieldHead">
        <label className="dshgc-label" htmlFor={props.id}>{props.label}</label>
        {props.head}
      </div>
      <input
        id={props.id}
        className="dshgc-input"
        type={secret ? 'password' : 'text'}
        autoComplete={secret ? 'new-password' : 'off'}
        value={props.text}
        disabled={props.disabled}
        aria-invalid={props.problem !== null}
        aria-describedby={messageId}
        {...props.placeholder === undefined ? {} : { placeholder: props.placeholder }}
        onChange={event => props.onEdit(event.target.value)}
      />
      <p
        id={messageId}
        className={props.problem === null ? 'dshgc-hint' : 'dshgc-invalid'}
        {...props.problem === null ? {} : { role: 'status' }}
      >
        {props.problem ?? props.hint}
      </p>
    </div>
  )
}

/** The provider picker, laid out on the same rhythm as every other field. */
function ProviderField(props: {
  id: string
  value: ProviderId
  disabled: boolean
  onChange: (provider: ProviderId) => void
}): ReactNode {
  return (
    <div className="dshgc-field">
      <div className="dshgc-fieldHead">
        <label className="dshgc-label" htmlFor={props.id}>提供方</label>
      </div>
      <select
        id={props.id}
        className="dshgc-select"
        value={props.value}
        disabled={props.disabled}
        onChange={event => props.onChange(event.target.value as ProviderId)}
      >
        {PROVIDER_ORDER.map(provider => (
          <option key={provider} value={provider}>{PROVIDER_LABELS[provider]}</option>
        ))}
      </select>
    </div>
  )
}

/** Whether one token reference is configured, as a status capsule. */
function StatusTag(props: { configured: boolean }): ReactNode {
  return (
    <span className={props.configured ? 'dshgc-tag dshgc-tagOk' : 'dshgc-tag dshgc-tagWarn'}>
      {props.configured ? 'token 已配置' : 'token 未配置'}
    </span>
  )
}

/** One button of the panel, matching the Host's control metrics and states. */
function Button(props: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  variant?: 'primary' | 'ghost'
  size?: 'md' | 'sm'
  danger?: boolean
}): ReactNode {
  const classes = ['dshgc-button', props.variant === 'primary' ? 'dshgc-buttonPrimary' : 'dshgc-buttonGhost']
  if (props.size === 'sm') classes.push('dshgc-buttonSm')
  if (props.danger === true) classes.push('dshgc-buttonDanger')
  return (
    <button type="button" className={classes.join(' ')} disabled={props.disabled === true} onClick={props.onClick}>
      {props.children}
    </button>
  )
}
