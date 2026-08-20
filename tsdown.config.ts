/**
 * Out-of-tree bundle build: node half + browser half, fully self-contained —
 * no imports from the deepseek-harness checkout, no workspace membership
 * needed. The browser half mirrors the repo's clientBundle contract: the
 * platform modules stay external (the shell's frozen module table answers
 * them via the injected require) and the artifact is a closure-factory that
 * calls `window.__ModuleLoader__.load`.
 *
 * Build from the plugin directory with any tsdown:
 *   pnpm build     # or: node "$DSH_REPO/node_modules/.bin/tsdown"
 * @module dsh-git-credentials/tsdown
 */

/** Node half: keep the runtime @deepseek-ai/* peers external — the dsh
 * installation provides them through its flat fallback; builtins are handled
 * by the bundler; everything else (the plugin's own source) bundles. */
const nodeExternal = (specifier: string): boolean =>
  /^@deepseek-ai\/(cordis|schemastery|dsh-tools)(\/|$)/.test(specifier)

/** Browser half: the shell's platform module table (mirrors the repo preset's
 * PLATFORM_MODULES + the preloaded runtime row). Our browser code imports only
 * React and type-only dsh contracts, so these externals are all it needs. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

const ID = 'dsh-git-credentials'

export default [
  {
    name: ID,
    entry: ['src/index.ts', 'src/invariant.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      neverBundle: nodeExternal,
    },
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: (specifier: string) => CLIENT_EXTERNALS.includes(specifier),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]
