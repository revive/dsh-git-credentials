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

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Whether one mapped target is a declaration the program can actually consume:
 * a file, or a directory carrying an `index.d.ts`. A source directory exists
 * but is not a built face.
 * @param path - the mapped path.
 * @returns true when the path resolves as declarations.
 */
function usable(path) {
  if (!existsSync(path)) return false
  return statSync(path).isDirectory() ? existsSync(join(path, 'index.d.ts')) : true
}

// Out-of-tree development needs the harness checkout explicitly; no
// machine-specific default is baked in.
const REPO = process.env.DSH_REPO
if (!REPO) {
  throw new Error(
    'DSH_REPO must point at a deepseek-harness checkout, e.g. DSH_REPO=/path/to/deepseek-harness',
  )
}
// The plugin root: this script lives in tools/.
const HERE = new URL('..', import.meta.url).pathname

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
  // The session-projection registry reaches this program through the boot
  // chain (smoke.ts). Its src is compiled by the repo with every domain
  // declaration merge present; an out-of-tree program sees only the subset
  // its own imports pull in, so the registry's generic map constraints fail
  // on the missing keys. Consume the BUILT declarations instead, for the
  // entry and its merge-bearing types module alike, so the domain
  // augmentations (also consumed as built declarations) attach to the same
  // module the registry reads — and skipLibCheck keeps the package's own
  // source consistency out of this program's diagnostics.
  '@deepseek-ai/dsh-session-projection': [`${REPO}/packages/session/session-projection/lib/types`],
  '@deepseek-ai/dsh-session-projection/types': [`${REPO}/packages/session/session-projection/lib/types/types.d.ts`],
}

/** Groups whose sources compile under repo face aggregates (client face, remotes split); an out-of-tree program must consume their BUILT declarations instead of src. */
const FACE_GROUPS = ['packages/client/', 'packages/host/', 'packages/api/gateway', 'packages/api/remotes']

const paths = {}
for (const [key, targets] of Object.entries(basePaths)) {
  paths[key] = targets.flatMap(target => {
    const rest = target.replace(/^\.\//, '')
    if (rest.startsWith('vendor/')) {
      const name = rest.split('/')[1]
      return [`${REPO}/vendor/${name}/lib/types`]
    }
    if (rest.startsWith('native/')) {
      return [`${REPO}/native/landlock-run/packages/entry/lib`]
    }
    if (FACE_GROUPS.some(group => rest.startsWith(group))) {
      // Any src/ subtree (package root directory, subpath file, or subpath
      // directory) maps to the matching built declaration subtree under
      // lib/types. A checkout that has not built its client face yet has no
      // such file (only some faces emit lib/types/client/**), so fall back to
      // that face's source: the program then still resolves the import and
      // still receives the face's own Context/Event declaration merges.
      // Consuming a face's SOURCE is a last resort: its CSS-module imports have
      // no declarations outside the harness's own build, so a built face is
      // always preferred where one exists.
      const built = `${REPO}/${rest.replace(/\/src(\/|$)/, '/lib/types$1').replace(/\.ts$/, '.d.ts')}`
      // A wildcard target names many packages and cannot be probed one by one:
      // prefer the built pattern and keep the source pattern as the target TS
      // tries next for a package that has no built face.
      if (rest.includes('*')) return [built, `${REPO}/${rest}`]
      return [usable(built) ? built : `${REPO}/${rest}`]
    }
    return [`${REPO}/${rest}`]
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
