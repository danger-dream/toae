import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AhkStatus } from '../../../src/contracts'
import type { ConfigService } from '../config/service'
import { atomicWriteFile, fileExists } from '../config/atomic'
import type { AppLogger } from '../logging/logger'
import { HelperClient } from './client'

const MAX_SCRIPT_BYTES = 2 * 1024 * 1024

export class NativeService {
  readonly client: HelperClient
  private statusValue: AhkStatus

  constructor(
    private readonly config: ConfigService,
    private readonly userData: string,
    resourcesPath: string,
    isPackaged: boolean,
    private readonly logger: AppLogger
  ) {
    this.client = new HelperClient(logger, resourcesPath, userData, isPackaged)
    this.statusValue = unsupportedOrStopped(config.value().enable_ahk)
  }

  onAction(handler: (action: any) => void): void { this.client.on('action', handler) }
  onLog(handler: (line: string) => void): void { this.client.on('log', handler) }

  async initialize(): Promise<void> {
    if (!this.client.supported()) {
      this.statusValue = unsupportedOrStopped(this.config.value().enable_ahk)
      return
    }
    try {
      this.statusValue = { enabled: this.config.value().enable_ahk, running: false, state: 'starting' }
      const hello = await this.client.start()
      this.statusValue = {
        enabled: this.config.value().enable_ahk,
        running: false,
        state: 'stopped',
        helperVersion: hello?.helperVersion,
        dllSha256: hello?.dllSha256,
        dllVersion: hello?.dllVersion
      }
      if (this.config.value().enable_ahk) await this.startAhk()
    } catch (error) {
      this.statusValue = this.errorStatus(error)
      this.logger.log('error', 'native helper initialization failed', error)
    }
  }

  async startAhk(): Promise<AhkStatus> {
    if (!this.client.supported()) return unsupportedOrStopped(true)
    try {
      await this.client.start()
      this.statusValue = { ...this.statusValue, enabled: true, running: false, state: 'starting', message: undefined }
      const status = await this.client.ahkStart()
      this.statusValue = this.withHandshake({ ...status, enabled: true })
      return structuredClone(this.statusValue)
    } catch (error) {
      this.statusValue = this.errorStatus(error, true)
      throw error
    }
  }

  async stopAhk(): Promise<AhkStatus> {
    if (!this.client.supported()) return unsupportedOrStopped(false)
    try {
      const status = await this.client.ahkStop()
      this.statusValue = this.withHandshake({ ...status, enabled: false, running: false, state: 'stopped' })
      return structuredClone(this.statusValue)
    } catch (error) {
      this.statusValue = this.errorStatus(error, false)
      throw error
    }
  }

  async status(): Promise<AhkStatus> {
    if (!this.client.supported()) return unsupportedOrStopped(this.config.value().enable_ahk)
    if (!this.client.handshake()) return structuredClone(this.statusValue)
    try {
      this.statusValue = this.withHandshake(await this.client.ahkStatus())
    } catch { /* retain the last acknowledged state */ }
    return structuredClone(this.statusValue)
  }

  async readScript(): Promise<string> {
    const script = await readFile(this.scriptPath(), 'utf8')
    if (Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BYTES) throw new Error('脚本文件超过大小限制')
    return script
  }

  async saveAndReload(script: string): Promise<AhkStatus> {
    validateScript(script)
    const path = this.scriptPath()
    const previous = await fileExists(path) ? await readFile(path) : undefined
    await atomicWriteFile(path, Buffer.from(script, 'utf8'))
    if (!this.client.supported() || !this.client.handshake()) return this.status()

    try {
      const next = this.withHandshake(await this.client.ahkReload())
      if (this.config.value().enable_ahk && !next.running) throw new Error(next.message || '新脚本未进入运行状态')
      this.statusValue = next
      return structuredClone(next)
    } catch (error) {
      if (previous) {
        await atomicWriteFile(path, previous)
        try { this.statusValue = this.withHandshake(await this.client.ahkReload()) } catch { /* report original failure */ }
      }
      throw new Error(`脚本重载失败，已恢复上一版本：${errorMessage(error)}`)
    }
  }

  async applyEnabled(enabled: boolean): Promise<void> {
    if (enabled) await this.startAhk()
    else await this.stopAhk()
  }

  async shutdown(): Promise<void> {
    try {
      if (this.client.handshake()) await this.client.ahkStop().catch(() => undefined)
    } finally {
      await this.client.shutdown()
    }
  }

  private scriptPath(): string { return join(this.userData, 'script.ahk') }

  private withHandshake(status: AhkStatus): AhkStatus {
    const hello = this.client.handshake()
    return {
      ...status,
      helperVersion: hello?.helperVersion,
      dllSha256: hello?.dllSha256,
      dllVersion: hello?.dllVersion
    }
  }

  private errorStatus(error: unknown, enabled = this.config.value().enable_ahk): AhkStatus {
    return this.withHandshake({ enabled, running: false, state: 'error', message: errorMessage(error).slice(0, 500) })
  }
}

function validateScript(script: string): void {
  if (!script.trim()) throw new Error('脚本内容为空')
  if (script.includes('\0')) throw new Error('脚本包含无效字符')
  if (Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BYTES) throw new Error('脚本内容超过大小限制')
}

function unsupportedOrStopped(enabled: boolean): AhkStatus {
  return process.platform === 'win32'
    ? { enabled, running: false, state: 'stopped' }
    : { enabled, running: false, state: 'unsupported', message: 'AutoHotkey 仅支持 Windows x64' }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
