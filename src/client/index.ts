/**
 * The gitlab plugin's browser half: registers the Settings → GitLab section
 * (site management: base URL, token reference, token value, add/delete).
 * All writes go to the plugin's own `/gitlab-admin/*` routes (registered by
 * the host half on the GUI webserver), so no product wire surface needs
 * extending; the host rebuilds its site registry on every committed change.
 * @module dsh-gitlab-plugin/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Merges the SlotRegistry onto the cordis Context (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { GitLabSettingsPanel } from './GitLabSettingsPanel.tsx'
import type { GitLabSettingsPanelInjected } from './GitLabSettingsPanel.tsx'
import { loadLocale } from './locale.ts'

export type { GitLabSettingsPanelInjected } from './GitLabSettingsPanel.tsx'

/** Required services (cordis fiber inject). */
export const inject = ['slots']

/** The nav entry label per locale; English default/fallback, Chinese alternate. */
const SECTION_LABEL = { en: 'Git Credentials', zh: 'Git 凭据' } as const

/**
 * Register the Git credentials section once the `settings.section` declaration is on
 * the ledger; the panel talks to the admin routes directly, so the inject
 * face carries nothing. dsh's own third-party-interface-language support
 * only exists from 0.1.2-rc.1 onward, so the nav label reads the plugin's
 * own stored locale choice (set inside the panel) rather than a host API,
 * keeping it correct on the pinned 0.1.1-rc.2 too.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const injected = (): GitLabSettingsPanelInjected => ({})
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'git-credentials',
    order: 20,
    label: () => SECTION_LABEL[loadLocale()],
    inject: injected,
  }, GitLabSettingsPanel))
}
