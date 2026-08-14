/**
 * Package-owned invariant companion for `dsh-git-credentials`.
 * @module dsh-git-credentials/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-git-credentials'

/** Cordis companion plugin name. */
export const name = 'git-credentials-plugin-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: an out-of-tree personal plugin — every effect it
 * registers (tools, admin routes) is owned by its own fiber, and it owns no
 * cross-plugin mutable relation.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
