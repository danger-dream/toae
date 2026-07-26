import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { access, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { ActionName, AhkStatus } from '../../../src/contracts'
import type { AppLogger } from '../logging/logger'

const PROTOCOL_VERSION = 1
const MAX_JSON_FRAME = 1024 * 1024
const MAX_BINARY_FRAME = 64 * 1024 * 1024
const EXPECTED_DLL_SHA256 = 'b49cf679662d1853b85bcee52607e5e89052bac3661461e35867e95713f8b282'

export function formatHelperExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (code === null) return `native helper exited (signal=${signal ?? 'unknown'})`
  const hex = (code >>> 0).toString(16).toUpperCase().padStart(8, '0')
  return `native helper exited (code=${code} decimal, 0x${hex})`
}

interface Pending {
  resolve(value: any): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  response?: any
  binary?: Uint8Array
}

export interface HelperHandshake {
  protocol: 1
  helperVersion: string
  arch: string
  capabilities: string[]
  dllSha256: string
  dllVersion: string
}

export class HelperClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<string, Pending>()
  private readonly stdoutHeader = Buffer.allocUnsafe(4)
  private stdoutHeaderBytes = 0
  private stdoutFrame?: Buffer
  private stdoutFrameBytes = 0
  private ready?: HelperHandshake
  private startPromise?: Promise<HelperHandshake | undefined>
  private activeSelectionRequestId?: string
  private stopping = false
  private helloWait?: { resolve(value: HelperHandshake): void; reject(error: Error): void; timer: NodeJS.Timeout }

  constructor(
    private readonly logger: AppLogger,
    private readonly resourcesPath: string,
    private readonly userData: string,
    private readonly isPackaged: boolean
  ) { super() }

  supported(): boolean { return process.platform === 'win32' && process.arch === 'x64' }
  handshake(): HelperHandshake | undefined { return this.ready }

  async start(): Promise<HelperHandshake | undefined> {
    if (!this.supported()) return undefined
    if (this.child && this.ready) return this.ready
    if (this.startPromise) return this.startPromise
    this.resetStdoutParser()
    const operation = this.startProcess()
    this.startPromise = operation
    try {
      return await operation
    } finally {
      if (this.startPromise === operation) this.startPromise = undefined
    }
  }

  private async startProcess(): Promise<HelperHandshake> {
    const helperPath = await this.resolveTrustedHelperPath()
    const token = randomBytes(32).toString('hex')
    const scriptPath = resolve(this.userData, 'script.ahk')
    this.stopping = false
    const child = spawn(helperPath, [
      '--supervisor',
      '--protocol', String(PROTOCOL_VERSION),
      '--session-token', token,
      '--script', scriptPath,
      '--dll-sha256', EXPECTED_DLL_SHA256
    ], {
      cwd: dirname(helperPath),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Full user environment is retained for compatibility with complete AHK
      // scripts. DLL resolution remains constrained by the worker's absolute
      // canonical path, hash check and SetDefaultDllDirectories policy.
      env: process.env
    })
    this.child = child
    child.stdout.on('data', chunk => this.consumeStdout(Buffer.from(chunk)))
    let stderrBuffer = ''
    const logStderrLine = (line: string) => {
      if (!line) return
      this.logger.log('info', 'native-helper', line)
      this.emit('log', line.slice(0, 2000))
    }
    const flushStderr = () => {
      const tail = stderrBuffer.replace(/\r$/, '')
      stderrBuffer = ''
      logStderrLine(tail)
    }
    child.stderr.on('data', chunk => {
      stderrBuffer += Buffer.from(chunk).toString('utf8')
      const lines = stderrBuffer.split(/\r?\n/)
      stderrBuffer = lines.pop() ?? ''
      for (const line of lines) logStderrLine(line)
    })
    let exitHandled = false
    const finish = (error: Error) => {
      if (exitHandled) return
      exitHandled = true
      flushStderr()
      this.handleExit(error)
    }
    child.once('error', error => finish(error))
    // "close" follows stdio shutdown, so a final stderr line without a newline
    // is available before the helper exit is recorded.
    child.once('close', (code, signal) => finish(new Error(formatHelperExit(code, signal))))

    return new Promise<HelperHandshake>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        child.kill()
        rejectPromise(new Error('native helper handshake timed out'))
      }, 5000)
      this.helloWait = {
        resolve: value => { clearTimeout(timer); resolvePromise(value) },
        reject: error => { clearTimeout(timer); rejectPromise(error) },
        timer
      }
    })
  }

  request<T>(type: string, payload: Record<string, unknown>, deadlineMs = 5000, requestId = randomUUID()): Promise<T> {
    return this.sendRequest<T>(type, payload, undefined, deadlineMs, requestId)
  }

  requestWithBinary<T>(type: string, payload: Record<string, unknown>, binary: Uint8Array, deadlineMs = 5000, requestId = randomUUID()): Promise<T> {
    if (binary.byteLength < 1 || binary.byteLength > MAX_BINARY_FRAME) throw new Error('native helper binary request exceeds size limit')
    return this.sendRequest<T>(type, payload, binary, deadlineMs, requestId)
  }

  private async sendRequest<T>(
    type: string,
    payload: Record<string, unknown>,
    binary: Uint8Array | undefined,
    deadlineMs: number,
    requestId: string
  ): Promise<T> {
    if (!this.child || !this.ready) throw new Error('native helper is not ready')
    if (this.pending.size >= 64) throw new Error('native helper request queue is full')
    const id = requestId
    const deadline = Math.max(100, Math.min(Math.trunc(deadlineMs), 180_000))
    const message = { v: PROTOCOL_VERSION, id, type, deadlineMs: deadline, payload: binary ? { ...payload, binary: true } : payload }
    const bytes = Buffer.from(JSON.stringify(message), 'utf8')
    if (bytes.byteLength > MAX_JSON_FRAME) throw new Error('native helper request exceeds size limit')
    const jsonFrame = Buffer.allocUnsafe(bytes.byteLength + 5)
    jsonFrame.writeUInt32LE(bytes.byteLength + 1, 0)
    jsonFrame[4] = 1
    bytes.copy(jsonFrame, 5)
    let frame = jsonFrame
    if (binary) {
      const idBytes = Buffer.from(id, 'utf8')
      const binaryPayloadLength = 2 + idBytes.byteLength + binary.byteLength
      const binaryFrame = Buffer.allocUnsafe(binaryPayloadLength + 5)
      binaryFrame.writeUInt32LE(binaryPayloadLength + 1, 0)
      binaryFrame[4] = 2
      binaryFrame.writeUInt16LE(idBytes.byteLength, 5)
      idBytes.copy(binaryFrame, 7)
      Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength).copy(binaryFrame, 7 + idBytes.byteLength)
      frame = Buffer.concat([jsonFrame, binaryFrame])
    }
    return new Promise<T>((resolvePending, rejectPending) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.sendCancel(id)
        rejectPending(new Error(`native helper request timed out: ${type}`))
      }, deadline + 250)
      this.pending.set(id, { resolve: resolvePending, reject: rejectPending, timer })
      this.child!.stdin.write(frame, error => {
        if (!error) return
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(id)
        pending.reject(error)
      })
    })
  }

  selectionGet(deadlineMs = 1500): Promise<{ text: string; method: 'uia' | 'clipboard'; clipboardRestored?: boolean }> {
    if (this.activeSelectionRequestId) this.sendCancel(this.activeSelectionRequestId)
    const requestId = randomUUID()
    this.activeSelectionRequestId = requestId
    return this.request<{ text: string; method: 'uia' | 'clipboard'; clipboardRestored?: boolean }>('selection.get', {}, deadlineMs, requestId)
      .finally(() => {
        if (this.activeSelectionRequestId === requestId) this.activeSelectionRequestId = undefined
      })
  }

  async captureStart(payload: Record<string, unknown>, deadlineMs = 180_000): Promise<{ meta: Record<string, any>; bytes?: Uint8Array }> {
    const response = await this.request<any>('capture.start', payload, deadlineMs)
    if (response?.meta && response?.bytes instanceof Uint8Array) return response
    return { meta: response as Record<string, any> }
  }

  captureCrop(sessionId: string, roiPhysical: { x: number; y: number; width: number; height: number }, deadlineMs = 2000): Promise<{ meta: Record<string, any>; bytes: Uint8Array }> {
    return this.request('capture.crop', { sessionId, roiPhysical }, deadlineMs)
  }

  captureCancel(sessionId: string): Promise<void> {
    return this.request('capture.cancel', { sessionId }, 1000)
  }

  async captureEditorContinue(
    sessionId: string,
    translatedBytes?: Uint8Array,
    translationError?: string,
    deadlineMs = 180_000
  ): Promise<{ meta: Record<string, any>; bytes?: Uint8Array }> {
    const payload = { sessionId, translationError: translationError?.slice(0, 500) }
    const response = translatedBytes
      ? await this.requestWithBinary<any>('capture.editor.continue', payload, translatedBytes, deadlineMs)
      : await this.request<any>('capture.editor.continue', payload, deadlineMs)
    if (response?.meta && response?.bytes instanceof Uint8Array) return response
    return { meta: response as Record<string, any> }
  }

  imageTranslateRender(
    payload: { width: number; height: number; regions: unknown[] },
    imageBytes: Uint8Array,
    deadlineMs = 10_000
  ): Promise<{ meta: Record<string, any>; bytes: Uint8Array }> {
    return this.requestWithBinary('image.translate.render', payload, imageBytes, deadlineMs)
  }

  ahkStart(): Promise<AhkStatus> { return this.request('ahk.start', {}, 5000) }
  ahkStop(): Promise<AhkStatus> { return this.request('ahk.stop', {}, 3000) }
  ahkReload(): Promise<AhkStatus> { return this.request('ahk.reload', {}, 5000) }
  ahkStatus(): Promise<AhkStatus> { return this.request('ahk.status', {}, 1000) }

  async shutdown(): Promise<void> {
    if (!this.child) return
    this.stopping = true
    try { await this.request('shutdown', {}, 1500) } catch { /* deadline kill below */ }
    const child = this.child
    await new Promise<void>(resolveDone => {
      if (child.exitCode !== null) return resolveDone()
      const timer = setTimeout(() => { child.kill(); resolveDone() }, 1000)
      child.once('exit', () => { clearTimeout(timer); resolveDone() })
    })
    this.child = undefined
    this.ready = undefined
  }

  private consumeStdout(chunk: Buffer): void {
    let offset = 0
    while (offset < chunk.byteLength) {
      if (!this.stdoutFrame) {
        const copied = Math.min(4 - this.stdoutHeaderBytes, chunk.byteLength - offset)
        chunk.copy(this.stdoutHeader, this.stdoutHeaderBytes, offset, offset + copied)
        this.stdoutHeaderBytes += copied
        offset += copied
        if (this.stdoutHeaderBytes < 4) return

        const length = this.stdoutHeader.readUInt32LE(0)
        this.stdoutHeaderBytes = 0
        if (length < 1 || length > MAX_BINARY_FRAME) {
          this.handleExit(new Error('native helper sent an invalid frame length'))
          this.child?.kill()
          return
        }
        this.stdoutFrame = Buffer.allocUnsafe(length)
        this.stdoutFrameBytes = 0
      }

      const frame = this.stdoutFrame
      const copied = Math.min(frame.byteLength - this.stdoutFrameBytes, chunk.byteLength - offset)
      chunk.copy(frame, this.stdoutFrameBytes, offset, offset + copied)
      this.stdoutFrameBytes += copied
      offset += copied
      if (this.stdoutFrameBytes < frame.byteLength) return

      this.stdoutFrame = undefined
      this.stdoutFrameBytes = 0
      if (frame[0] === 1) this.handleJson(frame.subarray(1))
      else if (frame[0] === 2) this.handleBinary(frame.subarray(1))
      else {
        this.handleExit(new Error('native helper sent an unknown frame kind'))
        this.child?.kill()
        return
      }
    }
  }

  private handleJson(bytes: Buffer): void {
    if (bytes.byteLength > MAX_JSON_FRAME) return
    let message: any
    try { message = JSON.parse(bytes.toString('utf8')) } catch { return }
    if (message?.v !== PROTOCOL_VERSION) return
    if (message.event === 'hello') {
      const hello = message.result as HelperHandshake
      const capabilities = Array.isArray(hello?.capabilities) ? new Set(hello.capabilities) : new Set<string>()
      const requiredCapabilities = ['selection.uia', 'selection.clipboard', 'capture.native-overlay', 'capture.editor.in-place-translation', 'image.translate.render', 'ahk.worker']
      if (hello?.protocol !== 1 || hello?.arch !== 'x86_64' || requiredCapabilities.some(value => !capabilities.has(value))) {
        this.helloWait?.reject(new Error('native helper handshake is incompatible'))
        this.child?.kill()
        return
      }
      if (hello.dllSha256 !== EXPECTED_DLL_SHA256) {
        this.helloWait?.reject(new Error('AutoHotkey_H DLL hash mismatch'))
        this.child?.kill()
        return
      }
      this.ready = hello
      this.helloWait?.resolve(hello)
      this.helloWait = undefined
      return
    }
    if (message.event === 'action') {
      const action = message.action as ActionName
      if (['show_translator', 'screenshot_translate', 'selection_translate', 'screenshot_recognizer'].includes(action)) this.emit('action', action)
      else this.logger.log('warn', 'helper rejected unknown action event')
      return
    }
    if (message.event === 'ahk.log') {
      const line = String(message.line ?? '').slice(0, 2000)
      this.emit('log', line)
      return
    }
    if (typeof message.id !== 'string') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    if (!message.ok) {
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      pending.reject(new Error(String(message.error?.message ?? message.error ?? 'native helper request failed')))
      return
    }
    pending.response = message.result
    this.tryResolve(message.id, pending)
  }

  private handleBinary(payload: Buffer): void {
    if (payload.byteLength < 2) return
    const idLength = payload.readUInt16LE(0)
    if (idLength < 8 || idLength > 128 || payload.byteLength < 2 + idLength) return
    const id = payload.subarray(2, 2 + idLength).toString('utf8')
    const bytes = payload.subarray(2 + idLength)
    const pending = this.pending.get(id)
    if (!pending || bytes.byteLength > MAX_BINARY_FRAME) return
    pending.binary = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.tryResolve(id, pending)
  }

  private tryResolve(id: string, pending: Pending): void {
    if (pending.response === undefined) return
    const expectsBinary = pending.response?.binary === true
    if (expectsBinary && !pending.binary) return
    clearTimeout(pending.timer)
    this.pending.delete(id)
    if (expectsBinary) {
      const { binary: _binary, ...meta } = pending.response
      pending.resolve({ meta, bytes: pending.binary })
    } else {
      pending.resolve(pending.response)
    }
  }

  private sendCancel(requestId: string): void {
    if (!this.child || !this.ready) return
    const message = Buffer.from(JSON.stringify({ v: 1, id: randomUUID(), type: 'cancel', deadlineMs: 500, payload: { requestId } }))
    const frame = Buffer.allocUnsafe(message.length + 5)
    frame.writeUInt32LE(message.length + 1, 0); frame[4] = 1; message.copy(frame, 5)
    this.child.stdin.write(frame)
  }

  private resetStdoutParser(): void {
    this.stdoutHeaderBytes = 0
    this.stdoutFrame = undefined
    this.stdoutFrameBytes = 0
  }

  private handleExit(error: Error): void {
    this.resetStdoutParser()
    this.logger.log(this.stopping ? 'info' : 'error', error.message)
    this.ready = undefined
    this.child = undefined
    this.activeSelectionRequestId = undefined
    this.helloWait?.reject(error)
    this.helloWait = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.emit('exit', error)
  }

  private async resolveTrustedHelperPath(): Promise<string> {
    const base = this.isPackaged ? join(this.resourcesPath, 'win32-x64') : resolve('resources', 'win32-x64')
    const candidate = join(base, 'native-helper.exe')
    if (!isAbsolute(candidate)) throw new Error('native helper path must be absolute')
    await access(candidate)
    const canonicalBase = await realpath(base)
    const canonical = await realpath(candidate)
    if (canonical !== canonicalBase && !canonical.startsWith(canonicalBase + sep)) throw new Error('native helper path escapes resources directory')
    await this.verifyManifest(canonicalBase, canonical)
    return canonical
  }

  private async verifyManifest(base: string, helperPath: string): Promise<void> {
    const manifestPath = join(base, 'resource-manifest.json')
    let manifest: any
    try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) } catch {
      if (this.isPackaged) throw new Error('native resource manifest is missing')
      return
    }
    const helperHash = createHash('sha256').update(await readFile(helperPath)).digest('hex')
    const dllHash = createHash('sha256').update(await readFile(join(base, 'AutoHotkey_H.dll'))).digest('hex')
    const defaultScriptHash = createHash('sha256').update(await readFile(join(dirname(base), 'default-script.ahk'))).digest('hex')
    if (manifest.protocol !== 1 || manifest.arch !== 'x86_64' || manifest.helperSha256 !== helperHash ||
        manifest.dllSha256 !== dllHash || manifest.defaultScriptSha256 !== defaultScriptHash || dllHash !== EXPECTED_DLL_SHA256) {
      throw new Error('native resource manifest verification failed')
    }
  }
}
