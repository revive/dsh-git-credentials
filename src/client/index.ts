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

export type { GitLabSettingsPanelInjected } from './GitLabSettingsPanel.tsx'

/** Required services (cordis fiber inject). */
export const inject = ['slots']

/**
 * Register the Git credentials section once the `settings.section` declaration is on
 * the ledger; the panel talks to the admin routes directly, so the inject
 * face carries nothing.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const injected = (): GitLabSettingsPanelInjected => ({})
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'git-credentials',
    order: 20,
    label: () => 'Git 凭据',
    inject: injected,
  }, GitLabSettingsPanel))
}
