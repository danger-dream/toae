import { randomUUID } from 'node:crypto'
import type { ProviderCallRequest, ProviderCallResult, ServiceConfigData } from '../../../src/contracts'
import type { ConfigService } from '../config/service'
import type { AppLogger } from '../logging/logger'
import { ProviderCache } from './cache'
import { ProviderHttpClient } from './http'
import { detectLanguage } from './language'
import { buildImageTextRegions, mapWithConcurrency, type ImageTextRegion } from './image-translation'
import { hasOcr, invokeOcr, invokeOcrDocument, type OcrDocument } from './ocr'
import { providerLanguageCode } from './provider-languages'
import { hasTranslator, invokeTranslator, supports, type DictResult, type TranslatorId } from './translator'

export class ProviderService {
  readonly cache: ProviderCache
  private readonly http = new ProviderHttpClient()
  private readonly active = new Map<string, AbortController>()
  private readonly audioSources = new Map<string, { url: string; expiresAt: number }>()

  constructor(private readonly config: ConfigService, private readonly logger: AppLogger, userData: string) {
    this.cache = new ProviderCache(userData, () => config.value())
  }

  async initialize(): Promise<void> {
    await this.cache.initialize()
  }

  async call(request: ProviderCallRequest, caller: 'translator' | 'setting'): Promise<ProviderCallResult> {
    validateRequest(request)
    const providerId = request.providerId
    if (!hasTranslator(providerId)) throw new Error('unknown translation provider')
    const service = this.resolveTranslationConfig(request, caller)
    const params = structuredClone(service.params ?? {}) as Record<string, unknown>
    const timeoutMs = clampTimeout(request.timeoutMs ?? service.timeout ?? this.config.value().trans_timeout)
    const retry = clampRetry(request.retry ?? service.retry ?? this.config.value().trans_retry_count)
    const controller = this.register(request.requestId)
    const start = Date.now()
    try {
      let data: string | DictResult
      const cacheCapability = request.capability === 'dict' || (request.capability === 'translate' && supports(providerId, 'dict'))
        ? request.onlyDict ? 'dict' : request.capability
        : request.capability
      const cacheKey = request.capability === 'detect' ? undefined : this.cache.makeKey({
        providerId: request.providerId,
        serviceId: service.id ?? request.providerId,
        capability: cacheCapability,
        text: request.text ?? '', from: request.from ?? '', to: request.to ?? '', params
      })
      if (cacheKey && !request.bypassCache) {
        const cached = this.cache.get(cacheKey)
        if (cached !== undefined) {
          return { requestId: request.requestId, providerId: request.providerId, capability: request.capability, data: this.decorateAudio(cached) as string | Record<string, unknown>, cached: true, timingMs: Date.now() - start }
        }
      }

      data = await withRetry(retry, timeoutMs, controller.signal, async signal => {
        const context = {
          http: this.http,
          params,
          text: request.text ?? '',
          from: request.from ?? 'auto',
          to: request.to ?? 'zh_cn',
          signal,
          timeoutMs: Math.max(100, timeoutMs)
        }
        if (request.capability === 'detect') return String(await invokeTranslator(providerId, 'detect', context))
        if (request.capability === 'dict') return invokeTranslator(providerId, 'dict', context)
        if (supports(providerId, 'dict')) {
          try {
            return await invokeTranslator(providerId, 'dict', context)
          } catch (dictionaryError) {
            if (request.onlyDict) throw new Error(`词典翻译失败：${errorMessage(dictionaryError)}`)
            // The fallback is deliberately awaited and shares the same AbortSignal.
            return await invokeTranslator(providerId, 'translate', context)
          }
        }
        if (request.onlyDict) throw new Error('该服务不提供词典翻译功能')
        return invokeTranslator(providerId, 'translate', context)
      })
      if (cacheKey) this.cache.set(cacheKey, data, typeof data !== 'string')
      return {
        requestId: request.requestId,
        providerId: request.providerId,
        capability: request.capability,
        data: this.decorateAudio(data) as string | Record<string, unknown>,
        timingMs: Date.now() - start
      }
    } catch (error) {
      this.logger.log('warn', 'provider request failed', {
        providerId: request.providerId,
        capability: request.capability,
        requestId: request.requestId,
        elapsedMs: Date.now() - start,
        category: providerErrorCategory(error)
      })
      throw error
    } finally {
      if (this.active.get(request.requestId) === controller) this.active.delete(request.requestId)
    }
  }

  async fetchAudio(token: string): Promise<{ bytes: Uint8Array; mime: string }> {
    this.pruneAudioSources()
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(token)) throw new Error('invalid provider audio token')
    const source = this.audioSources.get(token)
    if (!source || source.expiresAt <= Date.now()) throw new Error('provider audio token expired')
    const controller = new AbortController()
    const response = await this.http.request<Uint8Array>(source.url, {
      responseType: 'bytes', endpointPolicy: 'provider-audio', timeoutMs: 10_000,
      maxBytes: 4 * 1024 * 1024, signal: controller.signal
    })
    if (!response.ok) throw new Error(`provider audio request failed (${response.status})`)
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || 'audio/mpeg'
    if (!mime.startsWith('audio/') && mime !== 'application/octet-stream') throw new Error('provider audio response has an invalid content type')
    return { bytes: response.data, mime }
  }

  cancel(requestId: string): void {
    this.active.get(requestId)?.abort(new Error('request cancelled'))
  }

  cancelAll(): void {
    for (const controller of this.active.values()) controller.abort(new Error('application shutdown'))
    this.active.clear()
  }

  async recognizeImage(imageBytes: Uint8Array, parentSignal: AbortSignal): Promise<{ text: string; providerId: string }> {
    const config = this.config.value()
    const services = config.ocr_services.filter(item => item.enable && item.ocrVerify && hasOcr(item.name))
    if (services.length === 0) throw new Error('不存在可使用的OCR识别服务')
    const invoke = (service: ServiceConfigData, signal: AbortSignal) => this.invokeOcrService(service, imageBytes, signal)
    if (config.ocr_type === 'first') {
      const service = services[0]
      return { text: await invoke(service, parentSignal), providerId: service.name }
    }
    if (config.ocr_type === 'concurrent') {
      return firstSuccessful(services.map(service => ({
        providerId: service.name,
        run: (signal: AbortSignal) => invoke(service, signal)
      })), parentSignal)
    }
    const errors: string[] = []
    for (const service of services) {
      if (parentSignal.aborted) throw parentSignal.reason
      try {
        return { text: await invoke(service, parentSignal), providerId: service.name }
      } catch (error) {
        errors.push(`服务 ${service.label || service.name} 执行失败: ${errorMessage(error)}`)
      }
    }
    throw new Error(`Ocr服务调用失败：\n${errors.join('\n')}`)
  }

  async prepareImageTranslation(
    imageBytes: Uint8Array,
    imageSize: { width: number; height: number },
    parentSignal: AbortSignal
  ): Promise<{
      sourceLanguage: string
      targetLanguage: string
      ocrProviderId: string
      translatorProviderId: string
      regions: ImageTextRegion[]
    }> {
    const config = this.config.value()
    const ocrServiceId = config.image_translate_ocr_service
    const translationServiceId = config.image_translate_trans_service
    if (!ocrServiceId) throw new Error('请先在通用设置中选择图片直译的首选图片识别服务')
    if (!translationServiceId) throw new Error('请先在通用设置中选择图片直译的首选文本翻译服务')

    const ocrService = this.config.serviceById('ocr', ocrServiceId)
    if (!ocrService || !ocrService.enable || !ocrService.ocrVerify || !hasOcr(ocrService.name)) {
      throw new Error('图片直译的首选图片识别服务不可用')
    }
    const document = await this.invokeOcrServiceDocument(ocrService, imageBytes, parentSignal, true)
    if (document.items.length === 0) throw new Error('所选图片识别服务没有返回文字坐标，无法进行图片直译')
    const regions = buildImageTextRegions(document.items, imageSize.width, imageSize.height)
    if (regions.length === 0) throw new Error('图片中没有可翻译的文字区域')

    const translationService = this.config.serviceById('translate', translationServiceId)
    if (!translationService || !translationService.enable || !translationService.transVerify || !hasTranslator(translationService.name)) {
      throw new Error('图片直译的首选文本翻译服务不可用')
    }
    const sourceLanguage = detectLanguage(regions.map(region => region.sourceText).join('\n'))
    let targetLanguage = sourceLanguage === config.to ? config.to2 : config.to
    if (!targetLanguage || targetLanguage === sourceLanguage) targetLanguage = sourceLanguage === 'zh_cn' ? 'en' : 'zh_cn'
    const providerId = translationService.name as TranslatorId
    const from = providerLanguageCode(providerId, sourceLanguage)
    const to = providerLanguageCode(providerId, targetLanguage)
    const translated = await mapWithConcurrency(regions, 4, parentSignal, async region => {
      const translatedText = await this.invokeTranslationService(translationService, region.sourceText, from, to, parentSignal)
      if (!translatedText.trim()) throw new Error('文本翻译服务返回了空结果')
      return { ...region, translatedText: translatedText.trim() }
    })
    return {
      sourceLanguage,
      targetLanguage,
      ocrProviderId: ocrService.name,
      translatorProviderId: translationService.name,
      regions: translated
    }
  }

  async testDraft(input: {
    kind: 'translate' | 'ocr'
    service: ServiceConfigData
    capability: 'detect' | 'translate' | 'dict' | 'ocr'
    imageBytes?: Uint8Array
    text?: string
    from?: string
    to?: string
  }): Promise<unknown> {
    const id = input.service.name
    const params = structuredClone(input.service.params ?? {}) as Record<string, unknown>
    const timeoutMs = clampTimeout(input.service.timeout ?? (input.kind === 'ocr' ? this.config.value().ocr_timeout : this.config.value().trans_timeout))
    const controller = new AbortController()
    if (input.kind === 'ocr') {
      if (!hasOcr(id) || input.capability !== 'ocr' || !input.imageBytes) throw new Error('OCR测试参数无效')
      return invokeOcr(id, { http: this.http, params, imageBytes: input.imageBytes, signal: controller.signal, timeoutMs })
    }
    if (!hasTranslator(id) || input.capability === 'ocr') throw new Error('翻译测试参数无效')
    return invokeTranslator(id, input.capability, {
      http: this.http, params,
      text: input.text ?? 'Hello World!', from: input.from ?? 'en', to: input.to ?? 'zh_cn',
      signal: controller.signal, timeoutMs
    })
  }

  private resolveTranslationConfig(request: ProviderCallRequest, caller: 'translator' | 'setting'): ServiceConfigData {
    if (request.serviceId) {
      const service = this.config.serviceById('translate', request.serviceId)
      if (!service || service.name !== request.providerId) throw new Error('translation service instance not found')
      if (caller === 'translator' && (!service.enable || (!service.transVerify && !service.dictVerify))) throw new Error('translation service instance is disabled or unverified')
      return service
    }
    if (caller !== 'setting' || !request.params) throw new Error('serviceId is required')
    return { id: `draft-${request.providerId}`, name: request.providerId, params: request.params, timeout: request.timeoutMs, retry: request.retry }
  }

  private decorateAudio(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const result = structuredClone(value) as Record<string, unknown>
    if (!Array.isArray(result.pronunciations)) return result
    this.pruneAudioSources()
    for (const pronunciation of result.pronunciations) {
      if (!pronunciation || typeof pronunciation !== 'object') continue
      const record = pronunciation as Record<string, unknown>
      if (typeof record.voice !== 'string' || !/^https?:\/\//i.test(record.voice)) continue
      const token = randomUUID()
      this.audioSources.set(token, { url: record.voice, expiresAt: Date.now() + 5 * 60_000 })
      record.voice = `toae-audio:${token}`
    }
    while (this.audioSources.size > 128) {
      const oldest = this.audioSources.keys().next().value
      if (typeof oldest !== 'string') break
      this.audioSources.delete(oldest)
    }
    return result
  }

  private pruneAudioSources(): void {
    const now = Date.now()
    for (const [token, source] of this.audioSources) if (source.expiresAt <= now) this.audioSources.delete(token)
  }

  private register(requestId: string): AbortController {
    this.active.get(requestId)?.abort(new Error('request superseded'))
    const controller = new AbortController()
    this.active.set(requestId, controller)
    return controller
  }

  private async invokeOcrService(service: ServiceConfigData, imageBytes: Uint8Array, signal: AbortSignal): Promise<string> {
    return (await this.invokeOcrServiceDocument(service, imageBytes, signal)).text
  }

  private async invokeOcrServiceDocument(
    service: ServiceConfigData,
    imageBytes: Uint8Array,
    signal: AbortSignal,
    positioned = false
  ): Promise<OcrDocument> {
    if (!hasOcr(service.name)) throw new Error('未找到图片识别服务')
    const timeoutMs = clampTimeout(service.timeout ?? this.config.value().ocr_timeout)
    const retry = clampRetry(service.retry ?? this.config.value().ocr_retry_count)
    const result = await withRetry(retry, timeoutMs, signal, childSignal => invokeOcrDocument(service.name as any, {
      http: this.http,
      params: structuredClone(service.params ?? {}) as Record<string, unknown>,
      imageBytes,
      signal: childSignal,
      timeoutMs,
      positioned
    }))
    if (!result.text.trim()) throw new Error('未识别到文字')
    return { text: result.text.trim(), items: result.items }
  }

  private async invokeTranslationService(
    service: ServiceConfigData,
    text: string,
    from: string,
    to: string,
    signal: AbortSignal
  ): Promise<string> {
    if (!hasTranslator(service.name)) throw new Error('未找到文本翻译服务')
    const timeoutMs = clampTimeout(service.timeout ?? this.config.value().trans_timeout)
    const retry = clampRetry(service.retry ?? this.config.value().trans_retry_count)
    const result = await withRetry(retry, timeoutMs, signal, childSignal => invokeTranslator(service.name as TranslatorId, 'translate', {
      http: this.http,
      params: structuredClone(service.params ?? {}) as Record<string, unknown>,
      text,
      from,
      to,
      signal: childSignal,
      timeoutMs
    }))
    if (typeof result !== 'string') throw new Error('文本翻译服务返回结果无效')
    return result
  }
}

async function withRetry<T>(retry: number, totalDeadlineMs: number, parentSignal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const attempts = Math.max(1, retry)
  const deadline = Date.now() + totalDeadlineMs
  const errors: string[] = []
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (parentSignal.aborted) throw parentSignal.reason ?? new Error('request cancelled')
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const controller = new AbortController()
    const relay = () => controller.abort(parentSignal.reason)
    parentSignal.addEventListener('abort', relay, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('服务调用超时')), remaining)
    try {
      return await operation(controller.signal)
    } catch (error) {
      if (parentSignal.aborted) throw parentSignal.reason ?? error
      errors.push(`第${attempt + 1}次调用发生错误: ${errorMessage(error)}`)
    } finally {
      clearTimeout(timer)
      parentSignal.removeEventListener('abort', relay)
    }
  }
  throw new Error(errors.length ? errors.join('\n') : `服务调用超时：${totalDeadlineMs}ms`)
}

async function firstSuccessful(
  calls: Array<{ providerId: string; run: (signal: AbortSignal) => Promise<string> }>,
  parentSignal: AbortSignal
): Promise<{ text: string; providerId: string }> {
  if (parentSignal.aborted) throw parentSignal.reason ?? new Error('request cancelled')
  const controllers = calls.map(() => new AbortController())
  const relay = () => controllers.forEach(controller => controller.abort(parentSignal.reason))
  parentSignal.addEventListener('abort', relay, { once: true })
  try {
    return await new Promise((resolve, reject) => {
      const errors: string[] = []
      let settled = 0
      calls.forEach((call, index) => {
        call.run(controllers[index].signal).then(text => {
          controllers.forEach((controller, other) => { if (other !== index) controller.abort(new Error('another OCR provider succeeded')) })
          resolve({ text, providerId: call.providerId })
        }).catch(error => {
          errors[index] = errorMessage(error)
          settled += 1
          if (settled === calls.length) reject(new Error(`Ocr服务调用失败：\n${errors.join('\n')}`))
        })
      })
    })
  } finally {
    parentSignal.removeEventListener('abort', relay)
  }
}

function validateRequest(request: ProviderCallRequest): void {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('invalid provider request')
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(request.requestId)) throw new Error('invalid provider request id')
  if (typeof request.providerId !== 'string' || request.providerId.length > 64) throw new Error('invalid provider id')
  if (!['detect', 'translate', 'dict'].includes(request.capability)) throw new Error('invalid provider capability')
  if (request.serviceId !== undefined && (typeof request.serviceId !== 'string' || request.serviceId.length > 128)) throw new Error('invalid service id')
  if (request.text !== undefined && (typeof request.text !== 'string' || request.text.length > 100_000)) throw new Error('provider text exceeds limit')
  if (request.from !== undefined && (typeof request.from !== 'string' || request.from.length > 64)) throw new Error('invalid source language')
  if (request.to !== undefined && (typeof request.to !== 'string' || request.to.length > 64)) throw new Error('invalid target language')
  if (request.onlyDict !== undefined && typeof request.onlyDict !== 'boolean') throw new Error('invalid dictionary mode')
  if (request.bypassCache !== undefined && typeof request.bypassCache !== 'boolean') throw new Error('invalid cache mode')
  if (request.params && JSON.stringify(request.params).length > 256_000) throw new Error('provider parameters exceed limit')
}
function clampTimeout(value: number): number { return Math.max(100, Math.min(Number.isFinite(value) ? Math.trunc(value) : 5000, 180_000)) }
function clampRetry(value: number): number { return Math.max(1, Math.min(Number.isFinite(value) ? Math.trunc(value) : 1, 5)) }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function providerErrorCategory(error: unknown): string {
  const message = errorMessage(error).toLowerCase()
  if (message.includes('cancel') || message.includes('abort')) return 'cancelled'
  if (message.includes('timeout') || message.includes('超时')) return 'timeout'
  if (message.includes('401') || message.includes('403') || message.includes('auth') || message.includes('密钥') || message.includes('token')) return 'authentication'
  if (/http status:\s*429/.test(message) || message.includes('限流') || message.includes('频率')) return 'rate-limit'
  if (/http status:\s*5\d\d/.test(message)) return 'remote-server'
  if (message.includes('invalid') || message.includes('无效') || message.includes('解析')) return 'invalid-response-or-config'
  return 'provider-error'
}
export function providerRequestId(): string { return randomUUID() }
