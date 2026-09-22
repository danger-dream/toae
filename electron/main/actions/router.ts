import { randomUUID } from 'node:crypto'
import { ACTIONS, type ActionName, type TranslatorPayload } from '../../../src/contracts'
import type { CaptureService } from '../capture/service'
import type { ConfigService } from '../config/service'
import type { NativeService } from '../helper/service'
import type { AppLogger } from '../logging/logger'
import type { WindowManager } from '../windows/manager'

export class ActionRouter {
  private accepting = true
  private selectionGeneration = 0

  constructor(
    private readonly windows: WindowManager,
    private readonly capture: CaptureService,
    private readonly native: NativeService,
    private readonly config: ConfigService,
    private readonly logger: AppLogger
  ) {}

  isAllowed(value: string): value is ActionName {
    return (ACTIONS as readonly string[]).includes(value)
  }

  async dispatch(action: ActionName, source: 'tray' | 'shortcut' | 'ahk' | 'app'): Promise<void> {
    if (!this.accepting) return
    if (!this.isAllowed(action)) {
      this.logger.log('warn', 'rejected action', { source })
      return
    }
    this.logger.log('debug', 'action dispatched', { action, source })
    try {
      switch (action) {
        case 'show_translator':
          if (source === 'shortcut' || source === 'ahk') {
            await this.windows.toggleTranslator(true, this.config.value())
          } else {
            await this.windows.showTranslator(true, this.config.value())
          }
          return
        case 'screenshot_translate':
        case 'screenshot_recognizer':
          await this.capture.start(action)
          return
        case 'selection_translate':
          await this.selectionTranslate()
          return
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (action === 'selection_translate') {
        const level = isExpectedSelectionMiss(message) ? 'debug' : 'warn'
        this.logger.log(level, 'selection translation skipped', { source, reason: message })
        return
      }
      this.logger.log('error', 'action failed', { action, source, error: message })
    }
  }

  stopAccepting(): void {
    this.accepting = false
    this.selectionGeneration += 1
  }

  private async selectionTranslate(): Promise<void> {
    const generation = ++this.selectionGeneration
    if (!this.native.client.supported()) throw new Error('取词翻译仅支持 Windows')
    if (!this.native.client.handshake()) await this.native.client.start()
    const selected = await this.native.client.selectionGet(1500)
    if (generation !== this.selectionGeneration || !this.accepting) return
    const text = selected.text.trim()
    // The Rust baseline used UTF-8 byte length, so a single CJK character was
    // accepted while one/two ASCII bytes were ignored.
    if (Buffer.byteLength(text, 'utf8') < 3) return
    const payload: TranslatorPayload = {
      requestId: randomUUID(),
      text,
      translate: true,
      source: 'selection'
    }
    await this.windows.sendTranslatorPayload(payload, this.config.value())
    await this.windows.showTranslator(false, this.config.value())
  }
}

const EXPECTED_SELECTION_MISSES = [
  'did not place selected Unicode text on the clipboard',
  'does not expose a non-empty text selection',
  'did not expose selected text',
  'selected text belongs to a protected password field',
  'Ctrl+C input was blocked',
  'clipboard is busy',
  'selection request cancelled',
  'selection.get',
  'timed out'
]

function isExpectedSelectionMiss(message: string): boolean {
  return EXPECTED_SELECTION_MISSES.some(fragment => message.includes(fragment))
}
