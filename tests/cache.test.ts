import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppConfigurationData } from '../src/contracts'
import { ProviderCache } from '../electron/main/providers/cache'
import { DEFAULT_CONFIG } from '../electron/main/config/schema'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function setup() {
  const userData = await mkdtemp(join(tmpdir(), 'toae-cache-'))
  temporaryDirectories.push(userData)
  const config = structuredClone(DEFAULT_CONFIG) as AppConfigurationData
  return { userData, config }
}

describe('provider cache', () => {
  it('promotes a valid old CacheHelper entry to the canonical key', async () => {
    const { userData, config } = await setup()
    const input = { providerId: 'youdao', serviceId: 'service-1', capability: 'translate', text: ' hello ', from: 'en', to: 'zh-CHS', params: { appKey: 'id', key: 'secret' } }
    const legacyHash = createHash('md5').update(input.providerId + input.text + input.from + input.to).digest('hex')
    await writeFile(join(userData, '.translate.dat'), JSON.stringify([{
      id: 'old', hash: legacyHash, timestamp: Date.now(), hit: 2,
      is_word: false, result: '你好'
    }]))

    const cache = new ProviderCache(userData, () => config)
    await cache.initialize()
    const key = cache.makeKey(input)
    expect(cache.get(key)).toBe('你好')
    await cache.flush()
    const persisted = JSON.parse(await readFile(join(userData, '.translate.dat'), 'utf8'))
    expect(persisted.schemaVersion).toBe(1)
    expect(persisted.entries).toHaveLength(1)
    expect(persisted.entries[0].key).toBe(key)
  })

  it('does not read an existing entry when enable_cache is false and use_cache is true', async () => {
    const { userData, config } = await setup()
    const cache = new ProviderCache(userData, () => config)
    await cache.initialize()
    const key = cache.makeKey({ providerId: 'openai', serviceId: 'service-1', capability: 'translate', text: 'hello', from: 'en', to: 'zh_cn', params: {} })
    cache.set(key, '你好', false)
    expect(cache.get(key)).toBe('你好')
    await cache.flush()

    config.enable_cache = false
    config.use_cache = true
    expect(cache.get(key)).toBeUndefined()
  })

  it('keys result-affecting settings and credential revisions without storing credentials', async () => {
    const { userData, config } = await setup()
    const cache = new ProviderCache(userData, () => config)
    await cache.initialize()
    const base = { providerId: 'openai', serviceId: 'service-1', capability: 'translate', text: 'hello', from: 'en', to: 'zh_cn' }
    const first = cache.makeKey({ ...base, params: { model: 'a', apiKey: 'secret-one' } })
    const second = cache.makeKey({ ...base, params: { model: 'a', apiKey: 'secret-two' } })
    const third = cache.makeKey({ ...base, params: { model: 'b', apiKey: 'secret-two' } })
    expect(new Set([first, second, third]).size).toBe(3)
    cache.set(second, '结果', false)
    await cache.flush()
    const file = await readFile(join(userData, '.translate.dat'), 'utf8')
    expect(file).not.toContain('secret-one')
    expect(file).not.toContain('secret-two')
  })
})
