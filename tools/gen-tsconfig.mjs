/**
 * Regenerates tsconfig.json's `paths` from the repo's tsconfig.base.json so
 * this out-of-tree plugin typechecks against the same workspace source the
 * repo itself compiles. Vendored packages (@deepseek-ai/cordis, cosmokit,
 * schemastery, cordis-plugin-*) and the native addon resolve to their BUILT
 * declaration outputs instead of src, because those sources compile under
 * relaxed per-package tsconfigs that a strict consumer program must not
 * re-check; the native addon also cannot be loaded by Node from src.
 *
 * Run from anywhere (DSH_REPO must point at a deepseek-harness checkout):
 *   DSH_REPO=/path/to/deepseek-harness node tools/gen-tsconfig.mjs
 * @module gen-tsconfig
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Out-of-tree development needs the harness checkout explicitly; no
// machine-specific default is baked in.
const REPO = process.env.DSH_REPO
if (!REPO) {
  throw new Error(
    'DSH_REPO must point at a deepseek-harness checkout, e.g. DSH_REPO=/path/to/deepseek-harness',
  )
}
// The plugin root: this script lives in tools/. `fileURLToPath`, not
// `URL.pathname` — on Windows the latter yields a leading-slash path
// ("/C:/plugin/") that `join` then turns into "C:\C:\plugin\".
const HERE = fileURLToPath(new URL('..', import.meta.url))

const base = JSON.parse(
  readFileSync(join(REPO, 'tsconfig.base.json'), 'utf8')
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n'),
)
const basePaths = base.compilerOptions.paths

/** Exact subpath entries the repo resolves through per-package node_modules; spelled for this out-of-tree consumer. */
const EXTRA_PATHS = {
  '@deepseek-ai/dsh-client-ui-settings/client': [`${REPO}/packages/client/ui-settings/src/client/index.ts`],
}

/** Groups whose sources compile under repo face aggregates (client face, remotes split); an out-of-tree program must consume their BUILT declarations instead of src. */
const FACE_GROUPS = ['packages/client/', 'packages/host/', 'packages/api/gateway', 'packages/api/remotes']

const paths = {}
for (const [key, targets] of Object.entries(basePaths)) {
  paths[key] = targets.map(target => {
    const rest = target.replace(/^\.\//, '')
    if (rest.startsWith('vendor/')) {
      const name = rest.split('/')[1]
      return `${REPO}/vendor/${name}/lib/types`
    }
    if (rest.startsWith('native/')) {
      return `${REPO}/native/landlock-run/packages/entry/lib`
    }
    if (FACE_GROUPS.some(group => rest.startsWith(group))) {
      // Any src/ subtree (package root, subpath file, or subpath directory)
      // maps to the matching built declaration subtree under lib/types.
      return `${REPO}/${rest.replace('/src/', '/lib/types/').replace(/\.ts$/, '.d.ts')}`
    }
    return `${REPO}/${rest}`
  })
}
Object.assign(paths, EXTRA_PATHS)

const tsconfig = {
  extends: `${REPO}/tsconfig.base.json`,
  include: ['src', 'smoke.ts'],
  compilerOptions: {
    composite: false,
    incremental: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    noEmit: true,
    // Browser half: the settings panel is React.
    jsx: 'react-jsx',
    typeRoots: [`${REPO}/node_modules/@types`],
    paths,
  },
}

writeFileSync(join(HERE, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`)
console.log(`wrote tsconfig.json (${Object.keys(paths).length} path entries)`)
