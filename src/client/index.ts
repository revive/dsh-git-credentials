/**
 * The git-credentials plugin's browser half: registers the Settings → Git
 * Credentials section (site management: provider, API base URL, token value)
 * and the panel's dictionaries. All writes go to the plugin's own
 * `/git-credentials-admin/*` routes (registered by the host half on the GUI
 * webserver), so no product wire surface needs extending; the host rebuilds its
 * site registry on every committed change.
 * @module dsh-git-credentials/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Merges the SlotRegistry onto the cordis Context (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Merges the locale service onto the cordis Context (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { GitLabSettingsPanel } from './GitLabSettingsPanel.tsx'
import { en, zh, type GitCredentialsKey } from './locales.ts'

/** The panel's locale namespace. */
const NS = 'git-credentials'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Settings → Git Credentials panel copy. */
    'git-credentials': GitCredentialsKey
  }
}

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/**
 * Register the panel's dictionaries, then the Git Credentials section once the
 * `settings.section` declaration is on the ledger; the panel talks to the admin
 * routes directly, so the entry carries no inject face. The nav label and every
 * string inside the panel follow the active locale.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-git-credentials: panel dictionaries')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'git-credentials',
    order: 20,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
  }, GitLabSettingsPanel))
}
