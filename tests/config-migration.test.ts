import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runLegacyMigration } from '../electron/main/config/migration'
import { ConfigService, RevisionConflictError } from '../electron/main/config/service'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'toae-test-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('canonical configuration persistence', () => {
  it('serializes compare-write-publish and rejects a stale concurrent revision', async () => {
    const userData = await temporaryDirectory()
    const service = new ConfigService(userData)
    await service.initialize()
    const revision = service.snapshot(false).revision

    const first = service.patch(revision, { to: 'ja' })
    const stale = service.patch(revision, { to: 'ko' })
    const result = await first
    await expect(stale).rejects.toBeInstanceOf(RevisionConflictError)
    expect(result.revision).toBe(revision + 1)
    expect(result.config.to).toBe('ja')

    const persisted = JSON.parse(await readFile(join(userData, 'config.v1.json'), 'utf8'))
    expect(persisted.revision).toBe(revision + 1)
    expect(persisted.config.to).toBe('ja')
  })

  it('keeps secrets in Main while returning masks and preserving masked edits', async () => {
    const userData = await temporaryDirectory()
    const service = new ConfigService(userData)
    await service.initialize()
    let snapshot = await service.patch(service.snapshot(false).revision, {
      trans_services: [{ name: 'openai', enable: true, params: { apiKey: 'test-secret', model: 'model-a' } }]
    })
    expect(snapshot.config.trans_services[0].params?.apiKey).toBe('••••••••')
    expect(service.value().trans_services[0].params?.apiKey).toBe('test-secret')
    expect(snapshot.config.trans_services[0].id).toMatch(/^legacy-trans-openai-/)

    snapshot = await service.patch(snapshot.revision, {
      trans_services: [{ ...snapshot.config.trans_services[0], params: { apiKey: '••••••••', model: 'model-b' } }]
    })
    expect(service.value().trans_services[0].params).toEqual({ apiKey: 'test-secret', model: 'model-b' })
    expect(snapshot.config.trans_services[0].params?.apiKey).toBe('••••••••')
  })
})

describe('copy-only legacy migration', () => {
  it('imports config, script and cache without changing any source byte', async () => {
    const root = await temporaryDirectory()
    const appData = join(root, 'appdata')
    const source = join(appData, 'com.danger-dream.tosa')
    const userData = join(root, 'new-user-data')
    await mkdir(source, { recursive: true })
    const legacyConfig = Buffer.from(JSON.stringify({
      pinup: true,
      to: 'ja',
      selection_translate: 'Ctrl+Alt+D',
      enable_selection_assistant: true,
      assistant_rules: ['legacy-only'],
      trans_services: [{ name: 'google-free', enable: true, transVerify: true, params: {} }]
    }))
    const script = Buffer.from("#d UP::rust_callback('selection_translate')\r\n")
    const cache = Buffer.from(JSON.stringify([{ hash: '0123456789abcdef0123456789abcdef', result: '旧缓存' }]))
    await writeFile(join(source, '.config.dat'), legacyConfig)
    await writeFile(join(source, 'script.ahk'), script)
    await writeFile(join(source, '.translate.dat'), cache)
    const defaultScriptPath = join(root, 'default-script.ahk')
    await writeFile(defaultScriptPath, 'Persistent True\n')
    const sourceHashes = await hashes(source)

    const report = await runLegacyMigration({ userData, appData, defaultScriptPath })
    expect(report?.archivedSelectionAssistantFields.sort()).toEqual(['assistant_rules', 'enable_selection_assistant'])
    expect(report?.files.filter(item => item.imported).map(item => item.name).sort()).toEqual(['.config.dat', '.translate.dat', 'script.ahk'])
    const canonical = JSON.parse(await readFile(join(userData, 'config.v1.json'), 'utf8'))
    expect(canonical.config.pinup).toBe(true)
    expect(canonical.config.to).toBe('ja')
    expect(canonical.config.selection_translate).toBe('Ctrl+Alt+D')
    expect(canonical.config.enable_selection_assistant).toBeUndefined()
    expect(await readFile(join(userData, 'script.ahk'))).toEqual(script)
    expect(await readFile(join(userData, '.translate.dat'))).toEqual(cache)
    expect(await hashes(source)).toEqual(sourceHashes)

    await writeFile(join(userData, 'script.ahk'), 'user changed new copy\n')
    expect(await runLegacyMigration({ userData, appData, defaultScriptPath })).toBeUndefined()
    expect(await readFile(join(userData, 'script.ahk'), 'utf8')).toBe('user changed new copy\n')
    expect(await hashes(source)).toEqual(sourceHashes)
  })
})

async function hashes(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const name of ['.config.dat', '.translate.dat', 'script.ahk']) {
    result[name] = createHash('sha256').update(await readFile(join(directory, name))).digest('hex')
  }
  return result
}
