import { EventEmitter } from 'node:events'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppConfigurationData, ConfigSnapshot } from '../../../src/contracts'
import { atomicWriteFile, fileExists } from './atomic'
import { ConfigSchema, DEFAULT_CONFIG, isMaskedSecret, normalizeConfig, redactConfigForRenderer } from './schema'

interface StoredConfig {
  schemaVersion: 1
  revision: number
  config: AppConfigurationData
}

export class RevisionConflictError extends Error {
  constructor(public readonly current: ConfigSnapshot) {
    super('configuration revision conflict')
  }
}

export class ConfigService extends EventEmitter {
  private readonly path: string
  private readonly backupPath: string
  private stored: StoredConfig = {
    schemaVersion: 1,
    revision: 0,
    config: structuredClone(DEFAULT_CONFIG)
  }
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(private readonly userData: string) {
    super()
    this.path = join(userData, 'config.v1.json')
    this.backupPath = `${this.path}.bak`
  }

  async initialize(): Promise<void> {
    await mkdir(this.userData, { recursive: true, mode: 0o700 })
    const loaded = await this.tryRead(this.path) ?? await this.tryRead(this.backupPath)
    if (loaded) {
      this.stored = loaded
      return
    }
    this.stored = { schemaVersion: 1, revision: 1, config: structuredClone(DEFAULT_CONFIG) }
    await this.persist()
  }

  snapshot(includeSecrets: boolean): ConfigSnapshot {
    return {
      schemaVersion: 1,
      revision: this.stored.revision,
      config: includeSecrets
        ? structuredClone(this.stored.config)
        : redactConfigForRenderer(this.stored.config)
    }
  }

  value(): Readonly<AppConfigurationData> {
    return this.stored.config
  }

  serviceById(type: 'translate' | 'ocr', id: string) {
    const list = type === 'translate' ? this.stored.config.trans_services : this.stored.config.ocr_services
    return list.find(service => service.id === id)
  }

  patch(expectedRevision: number, patch: Partial<AppConfigurationData>): Promise<ConfigSnapshot> {
    // Serialize the complete compare/validate/write/publish transaction. Merely
    // queuing persist() is insufficient because a later caller could mutate
    // this.stored while an earlier revision is being flushed and verified.
    const operation = this.mutationQueue.then(() => this.applyPatch(expectedRevision, patch))
    this.mutationQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async applyPatch(expectedRevision: number, patch: Partial<AppConfigurationData>): Promise<ConfigSnapshot> {
    if (expectedRevision !== this.stored.revision) {
      throw new RevisionConflictError(this.snapshot(false))
    }
    const keys = Object.keys(patch)
    if (keys.length === 0 || keys.length > 8) throw new Error('configuration patch has invalid key count')
    for (const key of keys) {
      if (!(key in DEFAULT_CONFIG)) throw new Error(`unsupported configuration key: ${key}`)
    }

    const merged = structuredClone(this.stored.config) as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(patch)) {
      merged[key] = mergeMaskedSecrets(value, merged[key])
    }
    const config = normalizeConfig(merged)
    const previous = this.stored
    this.stored = { schemaVersion: 1, revision: previous.revision + 1, config }
    try {
      await this.persist()
    } catch (error) {
      this.stored = previous
      throw error
    }
    const snapshot = this.snapshot(false)
    this.emit('changed', snapshot)
    return snapshot
  }

  private async persist(): Promise<void> {
    if (await fileExists(this.path)) {
      await copyFile(this.path, this.backupPath).catch(() => undefined)
    }
    await atomicWriteFile(this.path, JSON.stringify(this.stored, null, 2))
    const verified = await this.tryRead(this.path)
    if (!verified || verified.revision !== this.stored.revision) {
      throw new Error('configuration verification after atomic write failed')
    }
  }

  private async tryRead(path: string): Promise<StoredConfig | undefined> {
    try {
      const raw = await readFile(path, 'utf8')
      if (raw.length > 4 * 1024 * 1024) return undefined
      const parsed = JSON.parse(raw) as Partial<StoredConfig>
      const revision = Number.isSafeInteger(parsed.revision) && Number(parsed.revision) >= 0
        ? Number(parsed.revision)
        : 0
      return {
        schemaVersion: 1,
        revision,
        config: normalizeConfig(parsed.config)
      }
    } catch {
      return undefined
    }
  }
}

function mergeMaskedSecrets(incoming: unknown, current: unknown): unknown {
  if (isMaskedSecret(incoming)) return current
  if (Array.isArray(incoming)) {
    if (!Array.isArray(current)) return incoming
    return incoming.map((value, index) => mergeMaskedSecrets(value, current[index]))
  }
  if (!incoming || typeof incoming !== 'object') return incoming
  const currentRecord = current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {}
  return Object.fromEntries(
    Object.entries(incoming as Record<string, unknown>)
      .map(([key, value]) => [key, mergeMaskedSecrets(value, currentRecord[key])])
  )
}
