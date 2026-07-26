import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { atomicWriteFile, fileExists } from './atomic'
import { normalizeConfig, REMOVED_SELECTION_ASSISTANT_FIELDS } from './schema'

const LEGACY_FILES = ['.config.dat', '.translate.dat', 'script.ahk'] as const
const MAX_LEGACY_SIZE: Record<(typeof LEGACY_FILES)[number], number> = {
  '.config.dat': 4 * 1024 * 1024,
  '.translate.dat': 64 * 1024 * 1024,
  'script.ahk': 2 * 1024 * 1024
}

interface MigrationFileRecord {
  name: string
  bytes: number
  sha256: string
  stagedSha256: string
  imported: boolean
  error?: string
}

export interface MigrationReport {
  schemaVersion: 1
  sourceDirectory: string
  sourceIdentifier: 'com.danger-dream.tosa'
  completedAt: string
  files: MigrationFileRecord[]
  archivedSelectionAssistantFields: string[]
  unknownConfigurationFields: string[]
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function isInside(candidate: string, parent: string): boolean {
  const root = resolve(parent)
  const value = resolve(candidate)
  return value === root || value.startsWith(root + sep)
}

export async function runLegacyMigration(input: {
  userData: string
  appData: string
  defaultScriptPath: string
}): Promise<MigrationReport | undefined> {
  const markerPath = join(input.userData, 'migration-v1.json')
  if (await fileExists(markerPath)) return undefined

  const sourceDirectory = join(input.appData, 'com.danger-dream.tosa')
  let sourceReal: string
  try {
    const sourceStat = await lstat(sourceDirectory)
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) return undefined
    sourceReal = await realpath(sourceDirectory)
  } catch {
    await ensureDefaultScript(input.userData, input.defaultScriptPath)
    return undefined
  }

  await mkdir(input.userData, { recursive: true, mode: 0o700 })
  const staging = join(input.userData, 'migration', `staging-${randomUUID()}`)
  await mkdir(staging, { recursive: true, mode: 0o700 })

  const report: MigrationReport = {
    schemaVersion: 1,
    sourceDirectory,
    sourceIdentifier: 'com.danger-dream.tosa',
    completedAt: new Date().toISOString(),
    files: [],
    archivedSelectionAssistantFields: [],
    unknownConfigurationFields: []
  }

  for (const name of LEGACY_FILES) {
    const source = join(sourceDirectory, name)
    const record: MigrationFileRecord = { name, bytes: 0, sha256: '', stagedSha256: '', imported: false }
    report.files.push(record)
    try {
      const info = await lstat(source)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('source is not a regular file')
      if (info.size > MAX_LEGACY_SIZE[name]) throw new Error('source exceeds migration size limit')
      const actual = await realpath(source)
      if (!isInside(actual, sourceReal)) throw new Error('source escapes legacy directory')
      const before = await readFile(actual)
      record.bytes = before.byteLength
      record.sha256 = sha256(before)
      const staged = join(staging, basename(name))
      await copyFile(actual, staged)
      await chmod(staged, 0o600).catch(() => undefined)
      const copied = await readFile(staged)
      record.stagedSha256 = sha256(copied)
      if (record.sha256 !== record.stagedSha256) throw new Error('staged hash mismatch')

      if (name === '.config.dat') {
        const destination = join(input.userData, 'config.v1.json')
        if (!(await fileExists(destination))) {
          const parsed = JSON.parse(copied.toString('utf8')) as Record<string, unknown>
          report.archivedSelectionAssistantFields = Object.keys(parsed).filter(key => REMOVED_SELECTION_ASSISTANT_FIELDS.has(key))
          const known = new Set(Object.keys(normalizeConfig({})))
          report.unknownConfigurationFields = Object.keys(parsed).filter(key => !known.has(key) && !REMOVED_SELECTION_ASSISTANT_FIELDS.has(key))
          const canonical = { schemaVersion: 1, revision: 1, config: normalizeConfig(parsed) }
          await atomicWriteFile(destination, JSON.stringify(canonical, null, 2))
          record.imported = true
        }
      } else if (name === '.translate.dat') {
        const destination = join(input.userData, '.translate.dat')
        if (!(await fileExists(destination))) {
          const parsed = JSON.parse(copied.toString('utf8'))
          if (!Array.isArray(parsed)) throw new Error('legacy cache is not an array')
          await atomicWriteFile(destination, copied)
          record.imported = true
        }
      } else {
        const destination = join(input.userData, 'script.ahk')
        if (!(await fileExists(destination)) && copied.byteLength > 0) {
          await atomicWriteFile(destination, copied)
          record.imported = true
        }
      }
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error)
    }
  }

  await ensureDefaultScript(input.userData, input.defaultScriptPath)
  await atomicWriteFile(markerPath, JSON.stringify(report, null, 2))
  return report
}

async function ensureDefaultScript(userData: string, defaultScriptPath: string): Promise<void> {
  const destination = join(userData, 'script.ahk')
  if (await fileExists(destination)) return
  const bytes = await readFile(defaultScriptPath)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_LEGACY_SIZE['script.ahk']) {
    throw new Error('default AutoHotkey script is invalid')
  }
  await mkdir(userData, { recursive: true, mode: 0o700 })
  await atomicWriteFile(destination, bytes)
}
