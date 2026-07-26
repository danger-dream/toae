import type { IBaseTransService, IDictResult, ITransServiceConfig } from '../../types'
import type { DetectType } from '../../Configuration'
import { callConfiguredProvider, testDraftProvider } from '../providerBridge'
import { providerIconUrl } from '../providerIcon'

export * from './Language'

import { Google } from './Google'
import { GoogleFree } from './GoogleFree'
import { Youdao } from './Youdao'
import { Baidu } from './Baidu'
import { Tencent } from './Tencent.tsx'
import { Bing } from './Bing'
import { OpenAI } from './OpenAI'
import { GeminiPro } from './GeminiPro'
import { DeepL } from './DeepL'
import { AlibabaFree } from './AlibabaFree'
import { caiyun } from './CaiYun'

const providerMetadata: IBaseTransService[] = [
  Youdao, Baidu, Tencent, Google, GoogleFree, Bing,
  OpenAI, GeminiPro, DeepL, caiyun, AlibabaFree
]

/**
 * Keep every original Provider's labels, icons, fields, language table and
 * visible capability badges, while replacing its renderer-side HTTP function
 * with the fixed Main provider adapter used by the setting verification UI.
 */
function mainBacked(service: IBaseTransService): IBaseTransService {
  const wrapped: IBaseTransService = { ...service, icon: providerIconUrl(service.icon, window.location.protocol, import.meta.env.BASE_URL) }
  if (service.Detect) {
    wrapped.Detect = async (params, text) => String(await testDraftProvider({
      kind: 'translate', service: { name: service.name, params }, capability: 'detect', text
    }))
  }
  if (service.Translate) {
    wrapped.Translate = async (params, text, from, to) => String(await testDraftProvider({
      kind: 'translate', service: { name: service.name, params }, capability: 'translate', text, from, to
    }))
  }
  if (service.Dict) {
    wrapped.Dict = async (params, text, from, to) => await testDraftProvider({
      kind: 'translate', service: { name: service.name, params }, capability: 'dict', text, from, to
    }) as IDictResult
  }
  return wrapped
}

export const plugins: IBaseTransService[] = providerMetadata.map(mainBacked)

function normalizeDetectedLanguage(service: IBaseTransService, providerLanguage: string): string {
  for (const key of Object.keys(service.languages)) {
    if (providerLanguage.toLowerCase() === String(service.languages[key]).toLowerCase()) return key
  }
  // Some endpoints already return the application's canonical language key.
  if (service.languages[providerLanguage] !== undefined) return providerLanguage
  return 'en'
}

export async function invokeLocalDetect(text: string): Promise<string> {
  return window.toae.app.detectLanguage(text)
}

async function detectWithService(config: ITransServiceConfig, text: string): Promise<string> {
  if (!config.id) throw new Error('语言检测服务缺少稳定实例 ID')
  const result = await callConfiguredProvider({
    capability: 'detect', providerId: config.name, serviceId: config.id, text
  })
  return normalizeDetectedLanguage(config.service, String(result.data))
}

export async function detect(services: ITransServiceConfig[], text: string, type: DetectType): Promise<string> {
  if (type === 'local' || services.length < 1) return invokeLocalDetect(text)

  if (type === 'order') {
    for (const service of services) {
      try {
        const language = await detectWithService(service, text)
        if (language) return language
      } catch { /* try the next configured service */ }
    }
  } else if (type === 'concurrent') {
    try {
      return await Promise.any(services.map(service => detectWithService(service, text)))
    } catch { /* deterministic local fallback below */ }
  } else if (type === 'concurrent_most') {
    const settled = await Promise.allSettled(services.map(service => detectWithService(service, text)))
    const counts = new Map<string, number>()
    for (const item of settled) {
      if (item.status === 'fulfilled') counts.set(item.value, (counts.get(item.value) ?? 0) + 1)
    }
    if (counts.size > 0) {
      let best = ''
      let bestCount = -1
      for (const [language, count] of counts) {
        if (count > bestCount) { best = language; bestCount = count }
      }
      return best
    }
  } else {
    // The setting UI stores a service-instance ID, not a mutable display name.
    const configured = services.find(service => service.id === type)
    if (configured) {
      try { return await detectWithService(configured, text) } catch { /* local fallback */ }
    }
  }
  return invokeLocalDetect(text)
}

export async function textConvert(
  config: ITransServiceConfig,
  text: string,
  from: string,
  to: string,
  onlyDict: boolean,
  useCache = true
): Promise<IDictResult | string> {
  if (!config.service) config.service = plugins.find(service => service.name === config.name)
  if (!config.service?.Translate) throw new Error('该服务不提供翻译服务')
  if (!config.id) throw new Error('翻译服务缺少稳定实例 ID')

  const response = await callConfiguredProvider({
    capability: 'translate',
    providerId: config.name,
    serviceId: config.id,
    text,
    from,
    to,
    onlyDict,
    bypassCache: !useCache
  })
  return response.data as string | IDictResult
}
