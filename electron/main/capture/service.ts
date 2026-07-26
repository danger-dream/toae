import { clipboard, desktopCapturer, dialog, nativeImage, Notification, screen, type Display } from 'electron'
import { randomUUID } from 'node:crypto'
import type { ActionName, CaptureFrameMeta, CaptureRoiDip, TranslatorPayload } from '../../../src/contracts'
import type { ConfigService } from '../config/service'
import type { NativeService } from '../helper/service'
import type { AppLogger } from '../logging/logger'
import type { ProviderService } from '../providers/service'
import type { WindowManager } from '../windows/manager'

const MAX_PREVIEW_BYTES = 64 * 1024 * 1024
const MAX_OCR_BYTES = 20 * 1024 * 1024

interface CaptureSession {
  id: string
  action: 'screenshot_translate' | 'screenshot_recognizer'
  display: Display
  meta: CaptureFrameMeta
  previewBytes?: Uint8Array
  helperSessionId?: string
  controller: AbortController
  claimed: boolean
}

export class CaptureService {
  private active?: CaptureSession
  private nativeCaptureInProgress = false

  constructor(
    private readonly windows: WindowManager,
    private readonly native: NativeService,
    private readonly providers: ProviderService,
    private readonly config: ConfigService,
    private readonly logger: AppLogger
  ) {}

  async start(action: ActionName): Promise<void> {
    const startedAt = Date.now()
    if (action !== 'screenshot_translate' && action !== 'screenshot_recognizer') throw new Error('invalid capture action')
    await this.cancelActive('new capture action')
    this.windows.get('translator')?.hide()

    if (process.platform === 'win32') {
      await this.startNativeOverlay(action, startedAt)
      return
    }

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    await this.windows.prepareCaptureWindow(display.bounds)
    const controller = new AbortController()

    try {
      const captured = await this.captureForDevelopment(action, display)
      validatePreview(captured.meta, captured.bytes)
      this.logger.log('debug', 'capture bytes received', {
        backend: captured.meta.backend,
        bytes: captured.bytes.byteLength,
        elapsedMs: Date.now() - startedAt
      })
      const session: CaptureSession = {
        id: captured.meta.sessionId,
        action,
        display,
        meta: captured.meta,
        previewBytes: captured.helperSessionId ? undefined : captured.bytes,
        helperSessionId: captured.helperSessionId,
        controller,
        claimed: false
      }
      this.active = session
      const bytes = Uint8Array.from(captured.bytes).buffer
      await this.windows.sendCaptureFrame({ meta: captured.meta, bytes })
      this.logger.log('debug', 'capture frame dispatched', { elapsedMs: Date.now() - startedAt })
    } catch (error) {
      controller.abort(error)
      const message = errorMessage(error)
      this.logger.log('error', 'capture start failed', { category: captureErrorCategory(message) })
      this.windows.sendCaptureError(message)
      this.windows.get('screen-capture')?.hide()
      if (this.config.value().ocr_err_tip) await dialog.showMessageBox({ type: 'error', title: '错误', message: `截图失败: ${message}` })
      throw error
    }
  }

  async confirm(sessionId: string, roiDip: CaptureRoiDip): Promise<void> {
    const session = this.active
    if (!session || session.id !== sessionId || session.claimed) throw new Error('截图会话不存在或已结束')
    validateRoiDip(roiDip, session.display.bounds.width, session.display.bounds.height)
    session.claimed = true

    try {
      const roiPhysical = toPhysicalRoi(roiDip, session.meta.width, session.meta.height, session.display.bounds.width, session.display.bounds.height)
      let imageBytes: Uint8Array
      if (session.helperSessionId) {
        const cropped = await this.native.client.captureCrop(session.helperSessionId, roiPhysical, 3000)
        imageBytes = cropped.bytes
      } else {
        if (!session.previewBytes) throw new Error('截图预览帧已释放')
        const image = nativeImage.createFromBuffer(Buffer.from(session.previewBytes))
        if (image.isEmpty()) throw new Error('截图预览无法解码')
        imageBytes = new Uint8Array(image.crop(roiPhysical).toPNG())
      }
      if (imageBytes.byteLength === 0 || imageBytes.byteLength > MAX_OCR_BYTES) throw new Error('选区图片为空或超过 OCR 大小限制')
      session.previewBytes = undefined

      if (session.action === 'screenshot_translate' && this.config.value().image_translate_enabled) {
        await this.copyTranslatedImageToClipboard(imageBytes, session.controller.signal)
        return
      }

      if (!this.config.value().ocr_succed_show_win) await this.windows.showTranslator(false, this.config.value())
      const recognized = await this.providers.recognizeImage(imageBytes, session.controller.signal)
      if (this.active !== session || session.controller.signal.aborted) return

      if (this.config.value().auto_copy && this.config.value().copy_type === 'ocr') clipboard.writeText(recognized.text)
      const payload: TranslatorPayload = {
        requestId: randomUUID(),
        text: recognized.text,
        translate: session.action === 'screenshot_translate',
        source: 'screenshot'
      }
      await this.windows.sendTranslatorPayload(payload, this.config.value())
      await this.windows.showTranslator(false, this.config.value())
    } catch (error) {
      if (!session.controller.signal.aborted) {
        const message = errorMessage(error)
        this.logger.log('warn', 'capture OCR pipeline failed', { sessionId, category: captureErrorCategory(message) })
        if (this.config.value().ocr_err_tip) await dialog.showMessageBox({ type: 'error', title: '错误', message })
      }
      throw error
    } finally {
      if (session.helperSessionId) await this.native.client.captureCancel(session.helperSessionId).catch(() => undefined)
      if (this.active === session) this.active = undefined
      session.previewBytes = undefined
    }
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.active || this.active.id !== sessionId) return
    await this.cancelActive('capture cancelled')
  }

  async cancelActive(reason = 'capture cancelled'): Promise<void> {
    const session = this.active
    if (!session) return
    this.active = undefined
    session.controller.abort(new Error(reason))
    session.previewBytes = undefined
    if (session.helperSessionId) await this.native.client.captureCancel(session.helperSessionId).catch(() => undefined)
  }

  private async startNativeOverlay(action: CaptureSession['action'], startedAt: number): Promise<void> {
    if (this.nativeCaptureInProgress) {
      this.logger.log('debug', 'native capture overlay is already visible', { action })
      return
    }

    const editor = action === 'screenshot_translate' && this.config.value().image_translate_enabled
    this.nativeCaptureInProgress = true
    try {
      if (!this.native.client.handshake()) await this.native.client.start()
      let selected = await this.native.client.captureStart({ action, editor }, 180_000)

      while (editor && selected.meta.cancelled !== true && String(selected.meta.intent) === 'translate') {
        const sourceBytes = requireImageBytes(selected.bytes)
        const editorSessionId = String(selected.meta.editorSessionId ?? '')
        if (!editorSessionId) throw new Error('截图编辑器没有返回可继续的会话标识')
        const controller = new AbortController()
        try {
          const translatedBytes = await this.renderTranslatedImage(sourceBytes, controller.signal)
          selected = await this.native.client.captureEditorContinue(
            editorSessionId,
            translatedBytes,
            undefined,
            180_000
          )
        } catch (error) {
          const message = errorMessage(error)
          this.logger.log('error', 'in-place image translation failed', {
            category: captureErrorCategory(message)
          })
          this.notify('图片翻译失败，可重试或直接完成截图')
          selected = await this.native.client.captureEditorContinue(
            editorSessionId,
            undefined,
            message,
            180_000
          )
        }
      }

      if (selected.meta.cancelled === true) {
        this.logger.log('debug', 'native capture overlay cancelled', { elapsedMs: Date.now() - startedAt })
        return
      }

      const intent = String(selected.meta.intent ?? 'confirm')
      this.logger.log('debug', 'native capture overlay completed', {
        intent,
        annotations: Number(selected.meta.annotations ?? 0),
        bytes: selected.bytes?.byteLength ?? 0,
        width: Number(selected.meta.width ?? 0),
        height: Number(selected.meta.height ?? 0),
        overlayElapsedMs: Number(selected.meta.elapsedMs),
        elapsedMs: Date.now() - startedAt
      })

      if (editor) {
        if (intent === 'copy') {
          this.copyImageToClipboard(requireImageBytes(selected.bytes))
          this.notify('截图已复制到剪贴板')
          return
        }
        if (intent === 'saved') {
          this.notify('截图已保存')
          return
        }
        throw new Error(`截图编辑器返回了无效操作: ${intent}`)
      }

      const imageBytes = requireImageBytes(selected.bytes)
      const controller = new AbortController()
      try {
        if (!this.config.value().ocr_succed_show_win) await this.windows.showTranslator(false, this.config.value())
        const recognized = await this.providers.recognizeImage(imageBytes, controller.signal)
        if (controller.signal.aborted) return
        if (this.config.value().auto_copy && this.config.value().copy_type === 'ocr') clipboard.writeText(recognized.text)
        const payload: TranslatorPayload = {
          requestId: randomUUID(),
          text: recognized.text,
          translate: action === 'screenshot_translate',
          source: 'screenshot'
        }
        await this.windows.sendTranslatorPayload(payload, this.config.value())
        await this.windows.showTranslator(false, this.config.value())
      } catch (error) {
        controller.abort(error)
        const message = errorMessage(error)
        this.logger.log('error', 'capture OCR pipeline failed', { category: captureErrorCategory(message) })
        if (this.config.value().ocr_err_tip) {
          await dialog.showMessageBox({ type: 'error', title: '错误', message })
        }
        throw error
      }
    } catch (error) {
      const message = errorMessage(error)
      this.logger.log('error', 'native capture overlay failed', { category: captureErrorCategory(message) })
      if (this.config.value().ocr_err_tip) {
        await dialog.showMessageBox({ type: 'error', title: '错误', message: `截图失败: ${message}` })
      }
      throw error
    } finally {
      this.nativeCaptureInProgress = false
    }
  }

  private copyImageToClipboard(imageBytes: Uint8Array): void {
    const image = nativeImage.createFromBuffer(Buffer.from(imageBytes.buffer, imageBytes.byteOffset, imageBytes.byteLength))
    if (image.isEmpty()) throw new Error('截图图片无法解码')
    clipboard.writeImage(image)
  }

  private notify(body: string): void {
    try {
      if (Notification.isSupported()) new Notification({ title: 'TOAE', body, silent: true }).show()
    } catch {
      // Notifications are feedback only and must not affect capture completion.
    }
  }

  private async copyTranslatedImageToClipboard(imageBytes: Uint8Array, signal: AbortSignal): Promise<void> {
    const translated = await this.renderTranslatedImage(imageBytes, signal)
    this.copyImageToClipboard(translated)
  }

  private async renderTranslatedImage(imageBytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted) throw signal.reason ?? new Error('图片直译已取消')
    const source = nativeImage.createFromBuffer(Buffer.from(imageBytes.buffer, imageBytes.byteOffset, imageBytes.byteLength))
    if (source.isEmpty()) throw new Error('截图图片无法解码')
    const size = source.getSize()
    const startedAt = Date.now()
    const plan = await this.providers.prepareImageTranslation(imageBytes, size, signal)
    if (signal.aborted) throw signal.reason ?? new Error('图片直译已取消')
    const rendered = await this.native.client.imageTranslateRender({
      width: size.width,
      height: size.height,
      regions: plan.regions
    }, imageBytes, 15_000)
    if (signal.aborted) throw signal.reason ?? new Error('图片直译已取消')
    if (!rendered.bytes?.byteLength || rendered.bytes.byteLength > MAX_OCR_BYTES) throw new Error('图片直译合成结果为空或超过大小限制')
    const result = nativeImage.createFromBuffer(Buffer.from(rendered.bytes.buffer, rendered.bytes.byteOffset, rendered.bytes.byteLength))
    if (result.isEmpty()) throw new Error('图片直译合成结果无法解码')
    this.logger.log('info', 'translated image rendered for screenshot editor', {
      width: size.width,
      height: size.height,
      regions: plan.regions.length,
      renderedRegions: Number(rendered.meta.renderedRegions ?? plan.regions.length),
      skippedRegions: Number(rendered.meta.skippedRegions ?? 0),
      ocrProviderId: plan.ocrProviderId,
      translatorProviderId: plan.translatorProviderId,
      sourceLanguage: plan.sourceLanguage,
      targetLanguage: plan.targetLanguage,
      elapsedMs: Date.now() - startedAt
    })
    return rendered.bytes
  }

  private async captureForDevelopment(action: CaptureSession['action'], display: Display): Promise<{
    meta: CaptureFrameMeta
    bytes: Uint8Array
    helperSessionId?: undefined
  }> {
    const width = Math.max(1, Math.round(display.bounds.width * display.scaleFactor))
    const height = Math.max(1, Math.round(display.bounds.height * display.scaleFactor))
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
      fetchWindowIcons: false
    })
    const source = sources.find(item => item.display_id === String(display.id)) ?? sources[0]
    if (!source || source.thumbnail.isEmpty()) throw new Error('开发环境无法获取桌面帧')
    const bytes = new Uint8Array(source.thumbnail.toPNG())
    const size = source.thumbnail.getSize()
    const sessionId = randomUUID()
    return {
      meta: {
        sessionId,
        action,
        width: size.width,
        height: size.height,
        mime: 'image/png',
        backend: 'gdi-fallback',
        display: {
          electronDisplayId: String(display.id),
          dipBounds: { ...display.bounds },
          physicalBounds: {
            x: Math.round(display.bounds.x * display.scaleFactor),
            y: Math.round(display.bounds.y * display.scaleFactor),
            width: size.width,
            height: size.height
          },
          scaleFactor: display.scaleFactor
        }
      },
      bytes
    }
  }
}

function validatePreview(meta: CaptureFrameMeta, bytes: Uint8Array): void {
  if (!meta.sessionId || !Number.isSafeInteger(meta.width) || !Number.isSafeInteger(meta.height) || meta.width < 1 || meta.height < 1) {
    throw new Error('截图元数据无效')
  }
  if (meta.width * meta.height > 200_000_000) throw new Error('截图像素尺寸超过限制')
  if (bytes.byteLength < 8 || bytes.byteLength > MAX_PREVIEW_BYTES) throw new Error('截图预览大小超过限制')
}

function validateRoiDip(roi: CaptureRoiDip, displayWidth: number, displayHeight: number): void {
  for (const value of [roi.x, roi.y, roi.width, roi.height]) {
    if (!Number.isFinite(value)) throw new Error('截图选区坐标无效')
  }
  if (roi.width < 1 || roi.height < 1 || roi.x < 0 || roi.y < 0 || roi.x + roi.width > displayWidth + 1 || roi.y + roi.height > displayHeight + 1) {
    throw new Error('截图选区超出屏幕范围')
  }
}

function toPhysicalRoi(roi: CaptureRoiDip, frameWidth: number, frameHeight: number, dipWidth: number, dipHeight: number) {
  const scaleX = frameWidth / dipWidth
  const scaleY = frameHeight / dipHeight
  const x = Math.max(0, Math.min(frameWidth - 1, Math.round(roi.x * scaleX)))
  const y = Math.max(0, Math.min(frameHeight - 1, Math.round(roi.y * scaleY)))
  const width = Math.max(1, Math.min(frameWidth - x, Math.round(roi.width * scaleX)))
  const height = Math.max(1, Math.min(frameHeight - y, Math.round(roi.height * scaleY)))
  return { x, y, width, height }
}

function requireImageBytes(bytes: Uint8Array | undefined): Uint8Array {
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_OCR_BYTES) {
    throw new Error('选区图片为空或超过 OCR 大小限制')
  }
  return bytes
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function captureErrorCategory(message: string): string {
  const value = message.toLowerCase()
  if (value.includes('cancel') || value.includes('abort')) return 'cancelled'
  if (value.includes('timeout') || value.includes('超时')) return 'timeout'
  if (value.includes('capture') || value.includes('截图') || value.includes('monitor')) return 'capture'
  if (value.includes('ocr') || value.includes('识别') || value.includes('provider') || value.includes('服务')) return 'ocr-provider'
  return 'pipeline'
}
