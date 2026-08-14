/**
 * Out-of-tree bundle build: reuses the deepseek-harness repository's
 * clientBundle preset so the browser artifact follows the same
 * closure-factory contract the client module system serves. The node half
 * bundles straight from source (tsdown auto-externalizes the @deepseek-ai/*
 * package dependencies, which resolve at runtime through the harness
 * fallback or the repo's tsx paths). Run from the plugin directory with the
 * repository's tsdown binary:
 *   DSH_REPO=/path/to/deepseek-harness node "$DSH_REPO/node_modules/.bin/tsdown"
 * @module dsh-git-credentials/tsdown
 */

import { join } from 'node:path'

// The harness checkout comes from the environment, never from a baked-in
// machine path.
const REPO = process.env.DSH_REPO
if (!REPO) {
  throw new Error(
    'DSH_REPO must point at a deepseek-harness checkout, e.g. DSH_REPO=/path/to/deepseek-harness',
  )
}

const { clientBundle } = await import(join(REPO, 'packages/client/tsdown.client.ts'))

export default clientBundle('dsh-git-credentials', ['src/index.ts', 'src/invariant.ts'])
