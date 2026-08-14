/**
 * Keyless boot smoke: composes the base bundle plus this plugin's patch over
 * an empty root, asserts the gitlab tools register, the encrypted store
 * round-trips (ciphertext on disk, no plaintext), and an unconfigured token
 * fails loud. No network calls and no model key are involved.
 *
 * Run from the plugin checkout (DSH_REPO points at the harness checkout;
 * the repo's own tsconfig drives tsx path resolution):
 *   DSH_REPO=/path/to/deepseek-harness \
 *     TSX_TSCONFIG_PATH="$DSH_REPO/tsconfig.json" \
 *     node --import "$DSH_REPO/node_modules/tsx/dist/esm/index.mjs" smoke.ts
 * @module git-credentials-smoke
 */

import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { GitLabClient } from './src/gitlab.ts'
import { GitStore, refOf } from './src/store.ts'

// The harness checkout comes from the environment, never from a baked-in
// machine path. The plugin root is derived from this script's own location.
const REPO = process.env.DSH_REPO
if (!REPO) {
  throw new Error(
    'DSH_REPO must point at a deepseek-harness checkout, e.g. DSH_REPO=/path/to/deepseek-harness',
  )
}
const PLUGIN = fileURLToPath(new URL('.', import.meta.url))

/** Structural slice of the tool registry the smoke asserts against. */
interface ToolRegistry {
  get(name: string): { readonly name: string } | undefined
}

// Isolate the smoke from any live harness home (the running GUI shares ~/.dsh).
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'git-credentials-smoke-'))
// Mirror the real deployment: the root config lives under profiles/<name>,
// so the loader's parent walk finds the plugin through the profiles
// node_modules fallback, exactly as a profile boot would.
mkdirSync(join(process.env.DSH_HOME, 'profiles', 'node_modules'), { recursive: true })
symlinkSync(PLUGIN, join(process.env.DSH_HOME, 'profiles', 'node_modules', 'dsh-git-credentials'), 'dir')
const profileDir = join(process.env.DSH_HOME, 'profiles', 'smoke')
mkdirSync(profileDir, { recursive: true })
const rootConfig = join(profileDir, 'cordis.yml')
writeFileSync(rootConfig, '[]\n')

// The encrypted store round-trips through explicit paths inside the temp home.
const storeDir = join(process.env.DSH_HOME, 'store-test')
mkdirSync(storeDir, { recursive: true })
const dataPath = join(storeDir, 'data.json')
const keyPath = join(storeDir, 'key.bin')
const store = GitStore.create({ dataPath, keyPath })
store.write({
  defaultSite: 'corp',
  sites: {
    corp: { provider: 'gitlab', baseUrl: 'https://gitlab.example.com', tokenRef: 'GITLAB_SMOKE_TOKEN' },
    gh: { provider: 'github', baseUrl: 'https://api.github.com', tokenRef: 'GITHUB_SMOKE_TOKEN' },
  },
  tokens: { GITLAB_SMOKE_TOKEN: 'glpat-smoke-secret', GITHUB_SMOKE_TOKEN: 'ghp-smoke-secret' },
})
const roundTrip = store.read()
if (roundTrip.sites.corp?.provider !== 'gitlab' || roundTrip.sites.gh?.provider !== 'github'
  || roundTrip.tokens['GITHUB_SMOKE_TOKEN'] !== 'ghp-smoke-secret') {
  throw new Error(`store round-trip mismatch: ${JSON.stringify(roundTrip)}`)
}
const onDisk = readFileSync(dataPath, 'utf8')
if (onDisk.includes('glpat-smoke-secret') || onDisk.includes('gitlab.example.com')) {
  throw new Error('store data file contains plaintext')
}
if (!onDisk.includes('"cipher":"aes-256-gcm"')) {
  throw new Error('store data file is not the encrypted envelope')
}
console.log('ok: encrypted store round-trips with ciphertext at rest')

const ctx = await boot('gitlab-smoke', rootConfig, [
  ...loadOverlayPatches('gitlab-smoke', join(REPO, 'packages/bundle/base/cordis.patch.yml')),
  ...loadOverlayPatches('gitlab-smoke', join(PLUGIN, 'cordis.yml')),
])

try {
  const tools = ctx.get('tools') as ToolRegistry | undefined
  if (tools === undefined) throw new Error('tools service is not registered')
  for (const name of [
    'gitlab_projects', 'gitlab_file', 'gitlab_merge_requests', 'gitlab_issues',
    'github_repos', 'github_file', 'github_issues', 'github_pull_requests',
  ]) {
    if (tools.get(name) === undefined) throw new Error(`tool ${name} is not registered`)
    console.log(`ok: ${name} registered`)
  }

  // Fail-loud without a configured token: the model must get a clear error,
  // never a crash and never a network call.
  const bare = new GitLabClient({}, {
    id: 'smoke',
    baseUrl: 'https://gitlab.example.com',
    tokenRef: refOf('GITLAB_NOT_CONFIGURED'),
  })
  let failed = false
  try {
    await bare.listProjects({})
  } catch (error) {
    failed = true
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('GITLAB_NOT_CONFIGURED') || !message.includes('not configured')) {
      throw new Error(`unexpected failure text: ${message}`)
    }
  }
  if (!failed) throw new Error('listProjects must fail loud without a configured token')
  console.log('ok: unconfigured token fails loud with a clear message')

  console.log('SMOKE OK')
} finally {
  await ctx.fiber.dispose()
}
