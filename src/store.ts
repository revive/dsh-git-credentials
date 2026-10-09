/**
 * Plugin-owned encrypted storage: sites and token values live in one
 * AES-256-GCM encrypted file with a separate random key file, so a human
 * copying or backing up the data file alone gets ciphertext only. The
 * encryption protects the data at rest from humans — not from same-UID
 * processes (the key file sits beside the data file, and any process the
 * user can run can read both).
 * @module gitlab-store
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Supported forge providers. */
export type ForgeProvider = 'gitlab' | 'github' | 'gitee' | 'gitea' | 'bitbucket'

/** One configured site: one site carries exactly one token. */
export interface SiteConfig {
  /** Which provider's API this site speaks. */
  provider: ForgeProvider
  baseUrl: string
  defaultProject?: string
}

/** The complete decrypted store state. */
export interface StoreState {
  defaultSite?: string
  sites: Record<string, SiteConfig>
  /** Token values keyed by site id; the only secret material. */
  tokens: Record<string, string>
}

/** The on-disk envelope: everything but the format fields is ciphertext. */
interface EncryptedFile {
  version: 1
  cipher: 'aes-256-gcm'
  iv: string
  tag: string
  data: string
}

const CIPHER = 'aes-256-gcm'
const DATA_VERSION = 1
const KEY_BYTES = 32
const IV_BYTES = 12

/** Resolved storage paths. */
export interface GitStorePaths {
  readonly dataPath: string
  readonly keyPath: string
}

/**
 * Derive the default storage paths under the harness home.
 * @param config - optional explicit paths from plugin config.
 * @returns the data and key file paths.
 */
export function defaultStorePaths(config: { dataPath?: string; keyPath?: string } = {}): GitStorePaths {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return {
    dataPath: config.dataPath ?? join(home, 'git-credentials.json'),
    keyPath: config.keyPath ?? join(home, 'git-credentials.key'),
  }
}

/**
 * The encrypted store. Reads decrypt per call (rotation reaches the next
 * operation without any caching); writes encrypt and persist atomically.
 */
export class GitStore {
  private constructor(
    private readonly paths: GitStorePaths,
  ) {}

  /** Create the store for one plugin instance. */
  static create(config: { dataPath?: string; keyPath?: string } = {}): GitStore {
    return new GitStore(defaultStorePaths(config))
  }

  /**
   * Read and decrypt the current state; an empty state when no data file
   * exists yet.
   * @returns the decrypted state.
   */
  read(): StoreState {
    if (!existsSync(this.paths.dataPath)) return { sites: {}, tokens: {} }
    const key = this.readKey()
    let file: EncryptedFile
    try {
      file = JSON.parse(readFileSync(this.paths.dataPath, 'utf8')) as EncryptedFile
    } catch (error) {
      throw new Error(
        `gitlab-plugin: ${this.paths.dataPath} is not a readable encrypted store: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    if (file.version !== DATA_VERSION || file.cipher !== CIPHER) {
      throw new Error(
        `gitlab-plugin: ${this.paths.dataPath} uses an unsupported format (${file.cipher ?? 'unknown'} v${file.version ?? '?'})`,
      )
    }
    let plain: Buffer
    try {
      const decipher = createDecipheriv(CIPHER, key, Buffer.from(file.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(file.tag, 'base64'))
      plain = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()])
    } catch (error) {
      throw new Error(
        `gitlab-plugin: decryption failed for ${this.paths.dataPath} — wrong key file or corrupted data: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    try {
      return normalizeState(JSON.parse(plain.toString('utf8')))
    } catch (error) {
      throw new Error(`gitlab-plugin: decrypted payload is not valid JSON: ${errorMessage(error)}`, { cause: error })
    }
  }

  /**
   * Encrypt and persist one state atomically (tmp file + rename), owner-only.
   * @param state - the complete next state.
   */
  write(state: StoreState): void {
    const key = this.ensureKey()
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(CIPHER, key, iv)
    const plain = Buffer.from(JSON.stringify(state), 'utf8')
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
    const file: EncryptedFile = {
      version: DATA_VERSION,
      cipher: CIPHER,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64'),
    }
    const tmp = `${this.paths.dataPath}.tmp`
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 })
    renameSync(tmp, this.paths.dataPath)
  }

  /** Whether one site currently holds a non-empty token. */
  configured(siteId: string): boolean {
    const value = this.read().tokens[siteId]
    return value !== undefined && value !== ''
  }

  /** Read the existing key file; fails loud when it is gone. */
  private readKey(): Buffer {
    if (!existsSync(this.paths.keyPath)) {
      throw new Error(
        `gitlab-plugin: key file ${this.paths.keyPath} is missing — the data file cannot be decrypted; keep a backup of the key`,
      )
    }
    return readFileSync(this.paths.keyPath)
  }

  /** Load or create the key file (owner-only). */
  private ensureKey(): Buffer {
    if (existsSync(this.paths.keyPath)) return this.readKey()
    const key = randomBytes(KEY_BYTES)
    mkdirSync(dirname(this.paths.keyPath), { recursive: true, mode: 0o700 })
    writeFileSync(this.paths.keyPath, key, { mode: 0o600 })
    return key
  }
}

/**
 * Normalize one decrypted document into the current state shape.
 *
 * Sites used to name a shared token through a `tokenRef`, with values keyed by
 * that reference. A site now owns its token, keyed by the site id, so a legacy
 * document is migrated on read: each site's referenced value is copied onto the
 * site id and the `tokenRef` field is dropped. Reference-keyed values that no
 * site referenced are not carried over — nothing could ever have read them.
 * @param raw - the decrypted document.
 * @returns the normalized state.
 */
export function normalizeState(raw: unknown): StoreState {
  const document = isRecord(raw) ? raw : {}
  const rawSites = isRecord(document.sites) ? document.sites : {}
  const rawTokens = isRecord(document.tokens) ? document.tokens : {}
  const sites: Record<string, SiteConfig> = {}
  const legacy: Array<readonly [string, string]> = []
  for (const [id, value] of Object.entries(rawSites)) {
    if (!isRecord(value)) continue
    const provider = typeof value.provider === 'string' ? value.provider as ForgeProvider : 'gitlab'
    const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl : ''
    const defaultProject = value.defaultProject
    sites[id] = {
      provider,
      baseUrl,
      ...typeof defaultProject === 'string' && defaultProject !== '' ? { defaultProject } : {},
    }
    if (typeof value.tokenRef === 'string' && value.tokenRef !== '') legacy.push([id, value.tokenRef])
  }
  const tokens: Record<string, string> = {}
  for (const id of Object.keys(sites)) {
    const own = rawTokens[id]
    if (typeof own === 'string') tokens[id] = own
  }
  for (const [id, ref] of legacy) {
    if (tokens[id] !== undefined) continue
    const referenced = rawTokens[ref]
    if (typeof referenced === 'string' && referenced !== '') tokens[id] = referenced
  }
  const defaultSite = document.defaultSite
  return {
    ...typeof defaultSite === 'string' ? { defaultSite } : {},
    sites,
    tokens,
  }
}

/** Whether one unknown value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Human-readable failure text for any thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
