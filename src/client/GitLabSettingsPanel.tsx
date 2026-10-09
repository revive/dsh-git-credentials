/**
 * The Settings → Git Credentials management panel: add, edit, and delete sites
 * (provider, API base URL, and the site's own token — one site carries exactly
 * one token). Every write goes to the plugin's own `/git-credentials-admin/*`
 * routes, which the host half registers on the GUI webserver; token values never
 * appear in any response, so the panel only ever shows configured state.
 *
 * The panel is a `settings.section` list entry of the current slot standard: it
 * receives the composed section props — the section owner's `close` plus the
 * standard kit, including the locale-bound `t` its registration declared — and
 * injects nothing. A failed admin read renders its error with a retry
 * affordance instead of a permanently blank content column.
 *
 * Styling follows the Host page the panel sits beside (see ./panel-css.ts):
 * controls are the plugin's own markup and CSS, and the only thing shared with
 * the Host is the `--dsw-*` theme tokens.
 * @module dsh-git-credentials/client
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ComposedProps, EntryKeyOf, Translate } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { adminGet, adminWrite } from './admin-api.ts'
import type { AdminSite, AdminState, AdminToken, ProviderId } from './admin-api.ts'
import type { GitCredentialsKey } from './locales.ts'
import {
  BASE_URL_PLACEHOLDERS, DEFAULT_BASE_URLS, PROVIDER_LABELS, PROVIDER_ORDER,
  baseUrlProblem, isStockBaseUrl, siteIdProblem, type SiteProblemKey,
} from './site-model.ts'
import { PANEL_CSS } from './panel-css.ts'

/** The panel's translate function, bound to its locale namespace. */
type PanelTranslate = Translate<GitCredentialsKey>

/** The composed props of one settings.section entry (the panel reads only `t`). */
export type GitLabSettingsPanelProps = ComposedProps<
  'settings.section', EntryKeyOf<'settings.section'>, never, undefined, object, never, 'git-credentials'
>

/** One site's editable draft (the token value never round-trips from the server). */
interface SiteDraft {
  provider: ProviderId
  baseUrl: string
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
  defaultProject: '',
  token: '',
}

/** A no-op edit handler for the read-only sites. */
const noop = (): void => {}

/** The editable draft of a configured site. */
function draftOf(site: AdminSite): SiteDraft {
  return {
    provider: site.provider,
    baseUrl: site.baseUrl,
    defaultProject: site.defaultProject ?? '',
    token: '',
  }
}

/** The message of an unknown thrown value. */
function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught)
}

/**
 * The Git Credentials settings section.
 * @param props - the composed settings.section props (only `t` is read).
 * @returns the panel.
 */
export function GitLabSettingsPanel({ t }: GitLabSettingsPanelProps): ReactNode {
  return <Loaded t={t} />
}

/** The mounted panel body: local state only, every write via the admin routes. */
function Loaded({ t }: { t: PanelTranslate }): ReactNode {
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
      setError(t('loadFailed', { reason: messageOf(caught) }))
    }
  }, [t])

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

  /** Write one site in one request: its fields and, when typed, its token. */
  const writeSite = async (id: string, draft: SiteDraft): Promise<void> => {
    await adminWrite('POST', '/git-credentials-admin/sites', {
      id,
      site: {
        provider: draft.provider,
        baseUrl: draft.baseUrl.trim(),
        ...draft.defaultProject.trim() === '' ? {} : { defaultProject: draft.defaultProject.trim() },
      },
      ...draft.token === '' ? {} : { token: draft.token },
    })
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
    }))
  }, [])

  const addSite = (): void => {
    const id = add.id.trim()
    void run(async () => {
      await writeSite(id, add)
      setAdd(EMPTY_ADD)
      setAddTouched(false)
    }, t('noticeSaved', { site: id }))
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
    }, t('noticeSaved', { site: id }))
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
    }, t('noticeDeleted', { site: id }))
  }

  const clearToken = (id: string): void => {
    void run(async () => {
      await adminWrite('DELETE', '/git-credentials-admin/token', { site: id })
    }, t('noticeTokenCleared', { site: id }))
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
          ? <p className="dshgc-muted">{t('loading')}</p>
          : (
            <>
              <p className="dshgc-error" role="alert">{error}</p>
              <div className="dshgc-actions">
                <Button disabled={busy} onClick={() => void load()}>{t('retry')}</Button>
              </div>
            </>
          )}
      </Panel>
    )
  }

  const ids = Object.keys(state.sites)
  const addIdProblem = siteIdProblem(add.id, ids)
  const addUrlProblem = baseUrlProblem(add.baseUrl)
  const addBlocked = addIdProblem !== null || addUrlProblem !== null

  return (
    <Panel>
      <p className="dshgc-intro">{t('intro')}</p>
      <div className="dshgc-status">
        <Button disabled={busy} onClick={() => void load()}>{t('refresh')}</Button>
        {busy && <span className="dshgc-muted">{t('busy')}</span>}
        {!busy && error === null && notice !== null && <span className="dshgc-ok">{notice}</span>}
        {error !== null && <span className="dshgc-error" role="alert">{error}</span>}
      </div>

      <h3 className="dshgc-heading">{t('sitesHeading')}{ids.length === 0 ? '' : ` · ${ids.length}`}</h3>
      {ids.length === 0
        ? <p className="dshgc-empty">{t('empty')}</p>
        : (
          <ul className="dshgc-cards">
            {ids.map(id => {
              const site = state.sites[id]
              if (site === undefined) return null
              const token = state.tokens[id]
              const draft = drafts[id]
              return (
                <li className="dshgc-card" key={id}>
                  {editing[id] === true && draft !== undefined
                    ? (
                      <SiteEditor
                        t={t}
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
                        onClearToken={() => clearToken(id)}
                      />
                    )
                    : (
                      <SiteFacts
                        t={t}
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

      <h3 className="dshgc-heading">{t('addHeading')}</h3>
      <div className="dshgc-card">
        <Field
          t={t} id="dshgc-add-id" label={t('siteId')} text={add.id} disabled={busy}
          hint={t('hintSiteId')} placeholder="corp"
          problem={addTouched ? addIdProblem : null}
          onEdit={value => editAdd({ id: value })}
        />
        <ProviderField t={t} id="dshgc-add-provider" value={add.provider} disabled={busy} onChange={pickAddProvider} />
        <Field
          t={t} id="dshgc-add-url" label={t('apiUrl')} text={add.baseUrl} disabled={busy}
          hint={t('hintApiUrl')} placeholder={BASE_URL_PLACEHOLDERS[add.provider]}
          problem={addTouched ? addUrlProblem : null}
          onEdit={value => editAdd({ baseUrl: value })}
        />
        <Field
          t={t} id="dshgc-add-token" label={t('token')} type="password" text={add.token} disabled={busy}
          hint={t('hintTokenAdd')} problem={null}
          onEdit={value => editAdd({ token: value })}
        />
        <Field
          t={t} id="dshgc-add-project" label={t('labelDefaultProject')} text={add.defaultProject}
          disabled={busy} hint={t('hintDefaultProject')} problem={null}
          onEdit={value => editAdd({ defaultProject: value })}
        />
        <div className="dshgc-actions dshgc-actionsEnd dshgc-divider">
          <Button variant="primary" disabled={busy || addBlocked} onClick={addSite}>{t('save')}</Button>
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
  t: PanelTranslate
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
        {props.isDefault && <span className="dshgc-tag">{props.t('defaultSite')}</span>}
        <span className="dshgc-spacer" />
        <StatusTag t={props.t} configured={props.token?.configured === true} />
      </div>
      <dl className="dshgc-facts">
        <dt className="dshgc-factKey">{props.t('apiUrl')}</dt>
        <dd className="dshgc-factValue">{props.site.baseUrl}</dd>
        <dt className="dshgc-factKey">{props.t('defaultProject')}</dt>
        <dd className="dshgc-factValue">{props.site.defaultProject ?? props.t('none')}</dd>
      </dl>
      <div className="dshgc-actions dshgc-actionsEnd">
        <Button size="sm" disabled={props.busy} onClick={props.onEdit}>{props.t('edit')}</Button>
        <Button size="sm" danger disabled={props.busy} onClick={props.onDelete}>{props.t('delete')}</Button>
      </div>
    </>
  )
}

/** One site in edit form: every field in one column, one save for all of them. */
function SiteEditor(props: {
  t: PanelTranslate
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
  const configured = props.token?.configured === true
  return (
    <>
      <div className="dshgc-cardHead">
        <span className="dshgc-siteId">{props.id}</span>
        <span className="dshgc-tag">{props.t('editing')}</span>
      </div>
      <Field
        t={props.t} id={`dshgc-site-${props.id}-id`} label={props.t('siteId')} text={props.id} disabled
        hint={props.t('hintSiteIdReadonly')} problem={null} onEdit={noop}
      />
      <ProviderField
        t={props.t} id={`dshgc-site-${props.id}-provider`} value={props.draft.provider}
        disabled={props.busy} onChange={props.onPickProvider}
      />
      <Field
        t={props.t} id={`dshgc-site-${props.id}-url`} label={props.t('apiUrl')} text={props.draft.baseUrl}
        disabled={props.busy} hint={props.t('hintApiUrl')} placeholder={BASE_URL_PLACEHOLDERS[props.draft.provider]}
        problem={urlProblem} onEdit={value => props.onChange({ baseUrl: value })}
      />
      <Field
        t={props.t} id={`dshgc-site-${props.id}-token`} label={props.t('token')} type="password"
        text={props.draft.token} disabled={props.busy} problem={null}
        hint={configured ? props.t('hintTokenKeep') : props.t('hintTokenSet')}
        onEdit={value => props.onChange({ token: value })}
        head={(
          <>
            <StatusTag t={props.t} configured={configured} />
            {configured && (
              <Button size="sm" danger disabled={props.busy} onClick={props.onClearToken}>
                {props.t('clearToken')}
              </Button>
            )}
          </>
        )}
      />
      <Field
        t={props.t} id={`dshgc-site-${props.id}-project`} label={props.t('labelDefaultProject')}
        text={props.draft.defaultProject} disabled={props.busy} problem={null}
        hint={props.t('hintDefaultProject')}
        onEdit={value => props.onChange({ defaultProject: value })}
      />
      <div className="dshgc-actions dshgc-actionsEnd dshgc-divider">
        <Button size="sm" danger disabled={props.busy} onClick={props.onDelete}>{props.t('delete')}</Button>
        <span className="dshgc-spacer" />
        <Button size="sm" disabled={props.busy} onClick={props.onCancel}>{props.t('cancel')}</Button>
        <Button variant="primary" disabled={props.busy || urlProblem !== null} onClick={props.onSave}>
          {props.t('save')}
        </Button>
      </div>
    </>
  )
}

/**
 * One host-metric labelled field: label, control, and a single message line that
 * shows the problem when there is one and the hint otherwise.
 */
function Field(props: {
  t: PanelTranslate
  id: string
  label: string
  text: string
  disabled: boolean
  hint: string
  problem: SiteProblemKey | null
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
        {props.problem === null ? props.hint : props.t(props.problem)}
      </p>
    </div>
  )
}

/** The provider picker, laid out on the same rhythm as every other field. */
function ProviderField(props: {
  t: PanelTranslate
  id: string
  value: ProviderId
  disabled: boolean
  onChange: (provider: ProviderId) => void
}): ReactNode {
  return (
    <div className="dshgc-field">
      <div className="dshgc-fieldHead">
        <label className="dshgc-label" htmlFor={props.id}>{props.t('provider')}</label>
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

/** Whether the site's token is configured, as a status capsule. */
function StatusTag(props: { t: PanelTranslate; configured: boolean }): ReactNode {
  return (
    <span className={props.configured ? 'dshgc-tag dshgc-tagOk' : 'dshgc-tag dshgc-tagWarn'}>
      {props.configured ? props.t('tokenConfigured') : props.t('tokenMissing')}
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
