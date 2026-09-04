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

/**
 * ── Styling contract ───────────────────────────────────────────────────
 *
 * This panel renders inside the host's Settings dialog, right beside the
 * host's own sections (General, Models, Plugins), so it has to read as one
 * of them. Every value below mirrors the host's own settings-section CSS:
 *
 *   - section: max-width 760, column, 12px gap; 18px/600 heading over a
 *     13px tertiary intro paragraph
 *   - card: 12px radius, 1px `--dsw-alias-border-l2` on
 *     `--dsw-alias-bg-layer-3`, 14px/16px padding, 10px between cards
 *   - type scale: 15px/600 card title, 13px body, 12px captions
 *   - controls: 32px tall, 8px radius, 13px text
 *   - color: `--dsw-*` design tokens only (each with a hex fallback so the
 *     panel still renders if the host renames a token), never raw hexes
 *
 * Two rules carry the layout. Read-only values render as plain text (the
 * host's code font for URLs and token references), never as input-shaped
 * boxes — a disabled-looking box invites a click that does nothing. And
 * value columns are a responsive auto-fit grid with `minWidth: 0`, not
 * fixed pixel widths, so a long base URL such as
 * `https://git.example.org/api/v1` stays fully readable.
 */
const COLOR = {
  text: 'var(--dsw-alias-label-primary, #cdd6f4)',
  secondary: 'var(--dsw-alias-label-secondary, #a6adc8)',
  tertiary: 'var(--dsw-alias-label-tertiary, #9399b2)',
  border: 'var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12))',
  card: 'var(--dsw-alias-bg-layer-3, #313244)',
  field: 'var(--dsw-specific-input-major, #1e1e2e)',
  success: 'var(--dsw-alias-state-success-primary, #a6e3a1)',
  danger: 'var(--dsw-alias-state-error-primary, #f38ba8)',
} as const

/** The host's code font, for URLs and token reference names. */
const CODE_FONT = 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace)'

/** Control height matching the host's 13px/8px-radius buttons. */
const CONTROL_HEIGHT = 32

/** The whole panel: the host's settings-section box. */
const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  maxWidth: 760,
  color: COLOR.text,
}

/** Heading row: section title on the left, locale switcher pinned right. */
const headingRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
}

/** Section title, matching the host's `<h2>`. */
const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 600,
}

/** Intro paragraph, matching the host's section intro. */
const introStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.5,
  color: COLOR.tertiary,
}

/** Field style shared by every input and select; `height` (not `minHeight`) so inputs, selects, and buttons line up exactly. */
const fieldStyle: CSSProperties = {
  height: CONTROL_HEIGHT,
  minWidth: 0,
  padding: '0 10px',
  boxSizing: 'border-box',
  borderRadius: 8,
  border: `1px solid ${COLOR.border}`,
  background: COLOR.field,
  color: COLOR.text,
  fontSize: 13,
  lineHeight: '20px',
}

/** Secondary action: refresh, edit, cancel, save-token, clear-token — the host's outlined button. */
const buttonStyle: CSSProperties = {
  height: CONTROL_HEIGHT,
  padding: '0 14px',
  boxSizing: 'border-box',
  borderRadius: 8,
  border: `1px solid ${COLOR.border}`,
  background: 'transparent',
  color: COLOR.secondary,
  cursor: 'pointer',
  fontSize: 13,
  whiteSpace: 'nowrap',
}

/** Primary action: the one commit button per card (Save / Add site) — the host's filled button. */
const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  border: '1px solid transparent',
  background: COLOR.text,
  color: 'var(--dsw-alias-bg-layer-3, #313244)',
  fontWeight: 500,
}

/** Destructive action: delete a site — same shape, danger-toned. */
const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  color: COLOR.danger,
}

/** The toolbar above the list: refresh plus transient saving/error text. */
const toolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 12,
}

/** The card list: one column, the host's 10px card gap. */
const cardsStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}

/** One site's card, and the add-site form. */
const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '14px 16px',
  borderRadius: 12,
  border: `1px solid ${COLOR.border}`,
  background: COLOR.card,
}

/** Card header: title on the left, actions pinned right. */
const cardHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 12,
}

/** The card title: the site id, or the add-site heading. */
const cardTitleStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  lineHeight: 1.4,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/** Actions cluster, pinned to the right of whatever row it sits in. */
const actionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginLeft: 'auto',
}

/** The value columns: responsive, so nothing is clipped at a fixed pixel width. */
const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 12,
}

/** One labelled column inside `gridStyle`. */
const cellStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minWidth: 0,
}

/** The caption above each value. */
const labelStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: '18px',
  color: COLOR.tertiary,
}

/**
 * A read-only value: plain text, never an input-shaped box. It wraps rather
 * than truncating — a base URL or token reference is the thing the user came
 * to check, so hiding its tail behind an ellipsis defeats the panel.
 */
const valueStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: '20px',
  paddingTop: 6,
  minWidth: 0,
  overflowWrap: 'anywhere',
}

/** A read-only value that is machine text (URL, token reference). */
const codeValueStyle: CSSProperties = { ...valueStyle, fontFamily: CODE_FONT }

/** Small supporting text: the token-configured line, the saving/error notes. */
const metaStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: COLOR.tertiary,
}

/** The card footer, separated the way the host separates a card's footer. */
const footerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  paddingTop: 12,
  borderTop: `1px solid ${COLOR.border}`,
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
    <div style={sectionStyle}>
      <div style={headingRowStyle}>
        <h2 style={headingStyle}>{t.heading}</h2>
        <select
          style={{ ...fieldStyle, marginLeft: 'auto' }}
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
      <p style={introStyle}>{t.intro}</p>
      <div style={toolbarStyle}>
        <button style={buttonStyle} onClick={() => void load()} disabled={busy}>{t.refresh}</button>
        {busy && <span style={metaStyle}>{t.saving}</span>}
        {error !== null && <span style={{ ...metaStyle, color: COLOR.danger }}>{error}</span>}
      </div>

      <div style={cardsStyle}>
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
            <span style={{ ...metaStyle, color: token?.configured === true ? COLOR.success : COLOR.danger }}>
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
              <div key={id} style={cardStyle}>
                <div style={cardHeaderStyle}>
                  <span style={cardTitleStyle}>{id}</span>
                  <span style={metaStyle}>{PROVIDER_LABELS[site.provider]}</span>
                  <div style={actionsStyle}>
                    {status}
                    <button style={buttonStyle} disabled={busy} onClick={beginEdit}>{t.edit}</button>
                  </div>
                </div>
                <div style={gridStyle}>
                  <div style={cellStyle}>
                    <span style={labelStyle}>{t.apiUrlTitle}</span>
                    <span style={codeValueStyle} title={site.baseUrl}>{site.baseUrl}</span>
                  </div>
                  <div style={cellStyle}>
                    <span style={labelStyle}>{t.tokenRefTitle}</span>
                    <span style={codeValueStyle} title={site.tokenRef}>{site.tokenRef}</span>
                  </div>
                  <div style={cellStyle}>
                    <span style={labelStyle}>{t.defaultProjectPlaceholder}</span>
                    <span
                      style={{ ...valueStyle, color: site.defaultProject === undefined ? COLOR.tertiary : COLOR.text }}
                      title={site.defaultProject ?? ''}
                    >
                      {site.defaultProject ?? t.emptyValue}
                    </span>
                  </div>
                </div>
              </div>
            )
          }
          return (
            <div key={id} style={cardStyle}>
              <div style={cardHeaderStyle}>
                <span style={cardTitleStyle}>{id}</span>
                <div style={actionsStyle}>
                  {status}
                  <button style={dangerButtonStyle} disabled={busy} onClick={() => void run(async () => {
                    await adminWrite('DELETE', `/git-credentials-admin/sites/${encodeURIComponent(id)}`)
                  })}
                  >
                    {t.deleteSite}
                  </button>
                </div>
              </div>
              <div style={gridStyle}>
                <div style={cellStyle}>
                  <span style={labelStyle}>{t.providerLabel}</span>
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
                </div>
                <div style={cellStyle}>
                  <span style={labelStyle}>{t.apiUrlTitle}</span>
                  <input
                    style={fieldStyle}
                    value={draft.baseUrl}
                    onChange={event => setDrafts({ ...drafts, [id]: { ...draft, baseUrl: event.target.value } })}
                  />
                </div>
                <div style={cellStyle}>
                  <span style={labelStyle}>{t.tokenRefTitle}</span>
                  <input
                    style={fieldStyle}
                    value={draft.tokenRef}
                    onChange={event => setDrafts({ ...drafts, [id]: { ...draft, tokenRef: event.target.value } })}
                  />
                </div>
                <div style={cellStyle}>
                  <span style={labelStyle}>{t.defaultProjectPlaceholder}</span>
                  <input
                    style={fieldStyle}
                    placeholder={t.defaultProjectPlaceholder}
                    value={draft.defaultProject}
                    onChange={event => setDrafts({ ...drafts, [id]: { ...draft, defaultProject: event.target.value } })}
                  />
                </div>
                <div style={cellStyle}>
                  <span style={labelStyle}>{t.tokenValueLabel}</span>
                  <input
                    style={fieldStyle}
                    type="password"
                    placeholder={t.tokenValuePlaceholder}
                    value={draft.token}
                    onChange={event => setDrafts({ ...drafts, [id]: { ...draft, token: event.target.value } })}
                  />
                </div>
              </div>
              <div style={footerStyle}>
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
                <div style={actionsStyle}>
                  <button style={buttonStyle} disabled={busy} onClick={cancelEdit}>{t.cancel}</button>
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
                </div>
              </div>
            </div>
          )
        })}

        {siteIds.length === 0 && <p style={introStyle}>{t.noSites}</p>}

        <div style={cardStyle}>
          <div style={cardHeaderStyle}>
            <span style={cardTitleStyle}>{t.addSiteHeading}</span>
          </div>
          <div style={gridStyle}>
            <div style={cellStyle}>
              <span style={labelStyle}>{t.siteIdLabel}</span>
              <input
                style={fieldStyle}
                placeholder={t.siteIdPlaceholder}
                value={newId}
                onChange={event => setNewId(event.target.value)}
              />
            </div>
            <div style={cellStyle}>
              <span style={labelStyle}>{t.providerLabel}</span>
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
            </div>
            <div style={cellStyle}>
              <span style={labelStyle}>{t.apiUrlTitle}</span>
              <input
                style={fieldStyle}
                placeholder={BASE_URL_PLACEHOLDERS[locale][newProvider]}
                value={newBaseUrl}
                onChange={event => setNewBaseUrl(event.target.value)}
              />
            </div>
            <div style={cellStyle}>
              <span style={labelStyle}>{t.tokenRefTitle}</span>
              <input
                style={fieldStyle}
                placeholder={t.tokenRefPlaceholder}
                value={newTokenRef}
                onChange={event => setNewTokenRef(event.target.value)}
              />
            </div>
            <div style={cellStyle}>
              <span style={labelStyle}>{t.defaultProjectPlaceholder}</span>
              <input
                style={fieldStyle}
                placeholder={t.defaultProjectPlaceholder}
                value={newDefaultProject}
                onChange={event => setNewDefaultProject(event.target.value)}
              />
            </div>
            <div style={cellStyle}>
              <span style={labelStyle}>{t.tokenValueLabel}</span>
              <input
                style={fieldStyle}
                type="password"
                placeholder={t.tokenValuePlaceholder}
                value={newToken}
                onChange={event => setNewToken(event.target.value)}
              />
            </div>
          </div>
          <div style={footerStyle}>
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
            <div style={actionsStyle}>
              <button
                style={primaryButtonStyle}
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
      </div>
    </div>
  )
}
