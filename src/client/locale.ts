/**
 * Self-contained i18n for the Git Credentials settings panel: a key-based
 * locale table, English default/fallback, Chinese selectable. dsh's own
 * third-party-interface-language support only shipped in 0.1.2-rc.1
 * ("Support third-party interface languages"); this plugin also targets the
 * pinned 0.1.1-rc.2 (kept for an unrelated client-modules loader bug in
 * 0.1.2-rc.1), so it can't depend on that host API yet. A plugin-owned table
 * works identically on both and stays forward-compatible.
 * @module dsh-git-credentials-plugin/locale
 */

export type Locale = 'en' | 'zh'

const STORAGE_KEY = 'git-credentials:locale'

/** All panel strings, keyed by the ids used throughout the component. */
export interface Messages {
  intro: string
  refresh: string
  saving: string
  loadFailed: (message: string) => string
  tokenConfigured: (source: string) => string
  tokenNotConfigured: string
  apiUrlTitle: string
  tokenRefTitle: string
  defaultProjectFallback: string
  edit: string
  save: string
  cancel: string
  tokenRefPlaceholder: string
  defaultProjectPlaceholder: string
  tokenValuePlaceholder: string
  saveToken: string
  clearToken: string
  deleteSite: string
  noSites: string
  siteIdPlaceholder: string
  addSite: string
}

const en: Messages = {
  intro: 'Manage Git credentials (GitLab / GitHub / Gitea / Forgejo / Gitee / Bitbucket) here: '
    + "site addresses and tokens are kept in the plugin's own encrypted file "
    + '(AES-256-GCM, separate key file, 0600); token values never enter the model context. '
    + 'Changes apply immediately, no restart needed.',
  refresh: 'Refresh',
  saving: 'Saving…',
  loadFailed: message => `Git credentials plugin failed to load: ${message}`,
  tokenConfigured: source => `token configured (${source})`,
  tokenNotConfigured: 'token not configured',
  apiUrlTitle: 'API URL',
  tokenRefTitle: 'token reference name',
  defaultProjectFallback: 'default project: —',
  edit: 'Edit',
  save: 'Save',
  cancel: 'Cancel',
  tokenRefPlaceholder: 'token reference name',
  defaultProjectPlaceholder: 'default project',
  tokenValuePlaceholder: 'token value (optional)',
  saveToken: 'Save token',
  clearToken: 'Clear token',
  deleteSite: 'Delete site',
  noSites: 'No sites yet. Add your first Git credentials site below.',
  siteIdPlaceholder: 'site id, e.g. corp',
  addSite: 'Add site',
}

const zh: Messages = {
  intro: '在这里管理 Git 凭据（GitLab / GitHub / Gitea / Forgejo / Gitee / Bitbucket）：站点地址与 token 保存在插件'
    + '自己的加密文件（AES-256-GCM，密钥独立文件，0600）中，token 值不会'
    + '进入模型上下文。修改即时生效，无需重启。',
  refresh: '刷新',
  saving: '保存中…',
  loadFailed: message => `Git 凭据插件未加载：${message}`,
  tokenConfigured: source => `token 已配置（${source}）`,
  tokenNotConfigured: 'token 未配置',
  apiUrlTitle: 'API 地址',
  tokenRefTitle: 'token 引用名',
  defaultProjectFallback: '默认项目：—',
  edit: '编辑',
  save: '保存',
  cancel: '取消',
  tokenRefPlaceholder: 'token 引用名',
  defaultProjectPlaceholder: '默认项目',
  tokenValuePlaceholder: '输入 token 值（可选）',
  saveToken: '保存 Token',
  clearToken: '清除 Token',
  deleteSite: '删除站点',
  noSites: '还没有站点。在下方添加第一个 Git 凭据站点。',
  siteIdPlaceholder: '站点 id，如 corp',
  addSite: '添加站点',
}

const MESSAGES: Record<Locale, Messages> = { en, zh }

/** English is the default/fallback; Chinese is the only selectable alternative. */
export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'zh']

/** The user's last-picked locale, if any; falls back to English (never the browser language). */
export function loadLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'en' || stored === 'zh') return stored
  } catch {
    // Storage unavailable (private mode, disabled site data); fall through to the default.
  }
  return 'en'
}

/** Persist the user's locale choice; a storage failure just means it resets next visit. */
export function saveLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // Ignored — the panel still works, it just won't remember the choice.
  }
}

/** Resolve the message table for one locale, falling back to English. */
export function messagesFor(locale: Locale): Messages {
  return MESSAGES[locale] ?? en
}
