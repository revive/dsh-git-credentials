/**
 * The Settings → Git Credentials panel's copy, in both shipped locales, and the
 * key union the panel is typed against.
 *
 * The namespace is declared into `LocaleNamespaceMap` by the plugin's client
 * entry, so the framework-injected `t` of the panel and the registration's
 * `locale` option are both typed to these keys; a missing or extra key in either
 * dictionary is a compile error.
 * @module dsh-git-credentials/client/locales
 */

/** Every copy key the panel uses. */
export type GitCredentialsKey =
  | 'nav'
  | 'intro'
  | 'refresh'
  | 'busy'
  | 'loading'
  | 'retry'
  | 'sitesHeading'
  | 'addHeading'
  | 'empty'
  | 'siteId'
  | 'provider'
  | 'apiUrl'
  | 'token'
  | 'defaultProject'
  | 'labelDefaultProject'
  | 'save'
  | 'cancel'
  | 'edit'
  | 'delete'
  | 'clearToken'
  | 'editing'
  | 'defaultSite'
  | 'tokenConfigured'
  | 'tokenMissing'
  | 'none'
  | 'hintSiteId'
  | 'hintSiteIdReadonly'
  | 'hintApiUrl'
  | 'hintTokenAdd'
  | 'hintTokenKeep'
  | 'hintTokenSet'
  | 'hintDefaultProject'
  | 'problemIdEmpty'
  | 'problemIdCharset'
  | 'problemIdTaken'
  | 'problemUrlEmpty'
  | 'problemUrlMalformed'
  | 'problemUrlScheme'
  | 'noticeSaved'
  | 'noticeDeleted'
  | 'noticeTokenCleared'
  | 'loadFailed'

/** The Chinese dictionary. */
export const zh: Record<GitCredentialsKey, string> = {
  nav: 'Git 凭据',
  intro: '站点与 token 存在本机加密文件里，任何响应都不回显 token。',
  refresh: '刷新',
  busy: '处理中…',
  loading: '加载中…',
  retry: '重试',
  sitesHeading: '已配置的站点',
  addHeading: '新增站点',
  empty: '还没有站点，用下面的「新增站点」添加第一个。',
  siteId: '站点 id',
  provider: '提供方',
  apiUrl: 'API 地址',
  token: 'token',
  defaultProject: '默认项目',
  labelDefaultProject: '默认项目（可选）',
  save: '保存',
  cancel: '取消',
  edit: '编辑',
  delete: '删除站点',
  clearToken: '清除 token',
  editing: '编辑中',
  defaultSite: '默认站点',
  tokenConfigured: 'token 已配置',
  tokenMissing: 'token 未配置',
  none: '—',
  hintSiteId: '小写字母开头，可含小写字母、数字、连字符',
  hintSiteIdReadonly: '站点 id 不可修改，改名请删除后重新添加',
  hintApiUrl: '该平台的 API 根地址',
  hintTokenAdd: '留空则稍后再设',
  hintTokenKeep: '留空表示不变',
  hintTokenSet: '尚未设置',
  hintDefaultProject: '如 owner/repo',
  problemIdEmpty: '请填写站点 id',
  problemIdCharset: '只能用小写字母、数字和连字符，且必须以字母开头',
  problemIdTaken: '该站点 id 已存在',
  problemUrlEmpty: '请填写 API 地址',
  problemUrlMalformed: '请填写合法的 URL，例如 https://api.github.com',
  problemUrlScheme: '必须以 http:// 或 https:// 开头',
  noticeSaved: '已保存站点 {site}',
  noticeDeleted: '已删除站点 {site}',
  noticeTokenCleared: '已清除 {site} 的 token',
  loadFailed: 'Git 凭据管理暂不可用：{reason}',
}

/** The English dictionary. */
export const en: Record<GitCredentialsKey, string> = {
  nav: 'Git Credentials',
  intro: 'Sites and tokens live in the plugin’s encrypted file; no response ever carries a token.',
  refresh: 'Refresh',
  busy: 'Working…',
  loading: 'Loading…',
  retry: 'Retry',
  sitesHeading: 'Configured sites',
  addHeading: 'Add a site',
  empty: 'No sites yet. Add the first one below.',
  siteId: 'Site id',
  provider: 'Provider',
  apiUrl: 'API base URL',
  token: 'Token',
  defaultProject: 'Default project',
  labelDefaultProject: 'Default project (optional)',
  save: 'Save',
  cancel: 'Cancel',
  edit: 'Edit',
  delete: 'Delete site',
  clearToken: 'Clear token',
  editing: 'Editing',
  defaultSite: 'Default site',
  tokenConfigured: 'Token configured',
  tokenMissing: 'No token',
  none: '—',
  hintSiteId: 'Starts with a letter; lowercase letters, digits, and hyphens',
  hintSiteIdReadonly: 'A site id is its storage key; delete and re-add to rename',
  hintApiUrl: 'API root of this provider',
  hintTokenAdd: 'Leave empty to set it later',
  hintTokenKeep: 'Leave empty to keep it',
  hintTokenSet: 'Not set yet',
  hintDefaultProject: 'e.g. owner/repo',
  problemIdEmpty: 'Enter a site id',
  problemIdCharset: 'Lowercase letters, digits, and hyphens only, starting with a letter',
  problemIdTaken: 'That site id already exists',
  problemUrlEmpty: 'Enter the API base URL',
  problemUrlMalformed: 'Enter a valid URL, e.g. https://api.github.com',
  problemUrlScheme: 'Must start with http:// or https://',
  noticeSaved: 'Saved site {site}',
  noticeDeleted: 'Deleted site {site}',
  noticeTokenCleared: 'Cleared the token of {site}',
  loadFailed: 'Git credentials management is unavailable: {reason}',
}
