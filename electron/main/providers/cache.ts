import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppConfigurationData } from '../../../src/contracts'
import { atomicWriteFile } from '../config/atomic'

interface CacheEntry {
  key: string
  timestamp: number
  hit: number
  isWord: boolean
  result: unknown
}
interface CacheFile { schemaVersion: 1; entries: CacheEntry[] }

export class ProviderCache {
  private readonly path: string
  private entries = new Map<string, CacheEntry>()
  private readonly legacyLookup = new Map<string, string>()
  private dirty = false
  private flushTimer?: NodeJS.Timeout

  constructor(private readonly userData: string, private readonly config: () => Readonly<AppConfigurationData>) {
    this.path = join(userData, '.translate.dat')
  }

  async initialize(): Promise<void> {
    await mkdir(this.userData, { recursive: true, mode: 0o700 })
    try {
      const raw = await readFile(this.path, 'utf8')
      if (raw.length > 64 * 1024 * 1024) return
      const parsed = JSON.parse(raw) as CacheFile | Array<Record<string, unknown>>
      const source = Array.isArray(parsed) ? parsed : parsed.schemaVersion === 1 ? parsed.entries : []
      for (const item of source.slice(-1_000_000)) {
        const converted = convertEntry(item as unknown as Record<string, unknown>)
        if (converted) this.entries.set(converted.key, converted)
      }
      this.prune()
    } catch {
      this.entries.clear()
    }
  }

  makeKey(input: { providerId: string; serviceId: string; capability: string; text: string; from: string; to: string; params: Record<string, unknown> }): string {
    const normalizedText = input.text.normalize('NFC').trim()
    const safeParams = stripCredentialValues(input.params)
    const key = createHash('sha256').update(stableStringify({
      schema: 1,
      providerId: input.providerId,
      serviceId: input.serviceId,
      capability: input.capability,
      text: normalizedText,
      from: input.from,
      to: input.to,
      params: safeParams
    })).digest('hex')
    // Old CacheHelper used MD5(provider name + text + provider language codes).
    // Retain this one-way lookup only long enough to promote a copy-only legacy
    // import into the canonical cache on its first successful hit.
    this.legacyLookup.set(key, createHash('md5').update(input.providerId + input.text + input.from + input.to).digest('hex'))
    return key
  }

  get(key: string): unknown | undefined {
    const config = this.config()
    if (!config.enable_cache || !config.use_cache) return undefined
    let entry = this.entries.get(key)
    if (!entry) {
      const legacyHash = this.legacyLookup.get(key)
      const legacyKey = legacyHash ? `legacy:${legacyHash}` : undefined
      const legacy = legacyKey ? this.entries.get(legacyKey) : undefined
      if (!legacy || !legacyKey) return undefined
      this.entries.delete(legacyKey)
      entry = { ...legacy, key }
      this.entries.set(key, entry)
      this.markDirty()
    }
    const maxDay = this.config().cache_day
    if (maxDay > 0 && Date.now() - entry.timestamp > maxDay * 86_400_000 && !(this.config().reserve_word && entry.isWord)) {
      this.entries.delete(key)
      this.markDirty()
      return undefined
    }
    entry.hit += 1
    this.markDirty()
    return structuredClone(entry.result)
  }

  set(key: string, result: unknown, isWord: boolean): void {
    if (!this.config().enable_cache || result === undefined || result === null || result === '') return
    this.entries.set(key, { key, timestamp: Date.now(), hit: 0, isWord, result: structuredClone(result) })
    this.prune()
    this.markDirty()
  }

  prune(): number {
    let removed = 0
    const config = this.config()
    const now = Date.now()
    if (config.cache_day > 0) {
      for (const [key, entry] of this.entries) {
        if (config.reserve_word && entry.isWord) continue
        if (now - entry.timestamp > config.cache_day * 86_400_000) {
          this.entries.delete(key)
          removed += 1
        }
      }
    }
    if (config.cache_max_count > 0 && this.entries.size > config.cache_max_count) {
      const candidates = [...this.entries.values()]
        .filter(entry => !(config.reserve_word && entry.isWord))
        .sort((a, b) => a.hit - b.hit || a.timestamp - b.timestamp)
      while (this.entries.size > config.cache_max_count && candidates.length) {
        this.entries.delete(candidates.shift()!.key)
        removed += 1
      }
    }
    if (removed > 0) this.markDirty()
    return removed
  }

  clearAll(): number {
    const count = this.entries.size
    this.entries.clear()
    this.markDirty()
    return count
  }

  async flush(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    const file: CacheFile = { schemaVersion: 1, entries: [...this.entries.values()] }
    try {
      await atomicWriteFile(this.path, JSON.stringify(file))
    } catch (error) {
      this.dirty = true
      throw error
    }
  }

  async dispose(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    await this.flush()
  }

  private markDirty(): void {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => { this.flush().catch(() => undefined) }, 1000)
  }
}

function convertEntry(value: Record<string, unknown>): CacheEntry | undefined {
  if (typeof value.key === 'string' && value.key.length === 64) {
    return {
      key: value.key,
      timestamp: finite(value.timestamp, Date.now()),
      hit: finite(value.hit, 0),
      isWord: Boolean(value.isWord),
      result: value.result
    }
  }
  // Copy-only import of the old .translate.dat record shape.
  if (typeof value.hash === 'string' && /^[a-f0-9]{32}$/i.test(value.hash) && value.result !== undefined) {
    return {
      key: `legacy:${value.hash.toLowerCase()}`,
      timestamp: finite(value.timestamp, Date.now()),
      hit: finite(value.hit, 0),
      isWord: Boolean(value.is_word),
      result: value.result
    }
  }
  return undefined
}
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
function stripCredentialValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCredentialValues)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
    key,
    /(?:secret|token|api.?key|auth|password|client_secret|key)$/i.test(key)
      ? `[credential:${credentialFingerprint(nested)}]`
      : stripCredentialValues(nested)
  ]))
}
function credentialFingerprint(value: unknown): string {
  const serialized = typeof value === 'string' ? value : stableStringify(value)
  return createHash('sha256').update(serialized).digest('hex').slice(0, 16)
}
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
