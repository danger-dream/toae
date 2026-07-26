import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { ProviderHttpClient, EndpointPolicy } from './http'

export interface DictResult {
  text: string
  pronunciations?: Array<{ region?: string; symbol?: string; voice?: string }>
  explanations?: Array<{ trait: string; explains: string[] }>
  sentence?: string[]
  wfs?: Array<{ name: string; value: string }>
  web?: Array<{ name: string; list: string[] }>
}

export interface TranslatorContext {
  http: ProviderHttpClient
  params: Record<string, unknown>
  text: string
  from: string
  to: string
  signal: AbortSignal
  timeoutMs: number
}

export type TranslatorResult = string | DictResult
export const TRANSLATOR_IDS = [
  'youdao', 'baidu', 'tencent', 'google', 'google-free', 'bing',
  'openai', 'gemini-pro', 'deepl', 'caiyun', 'alibaba-free'
] as const
export type TranslatorId = (typeof TRANSLATOR_IDS)[number]

export function hasTranslator(id: string): id is TranslatorId {
  return (TRANSLATOR_IDS as readonly string[]).includes(id)
}

export function supports(id: TranslatorId, capability: 'detect' | 'translate' | 'dict'): boolean {
  if (capability === 'dict') return id === 'youdao' || id === 'google-free'
  if (capability === 'detect') return ['baidu', 'tencent', 'google', 'google-free', 'bing'].includes(id)
  return true
}

export async function invokeTranslator(
  id: TranslatorId,
  capability: 'detect' | 'translate' | 'dict',
  context: TranslatorContext
): Promise<TranslatorResult> {
  if (!supports(id, capability)) throw new Error(`provider ${id} does not support ${capability}`)
  if (capability === 'detect') return detect(id, context)
  if (capability === 'dict') return dictionary(id, context)
  switch (id) {
    case 'youdao': return youdao(context, false) as Promise<string>
    case 'baidu': return baidu(context)
    case 'tencent': return tencent(context)
    case 'google': return google(context)
    case 'google-free': return googleFree(context, false) as Promise<string>
    case 'bing': return bing(context)
    case 'openai': return openai(context)
    case 'gemini-pro': return gemini(context)
    case 'deepl': return deepl(context)
    case 'caiyun': return caiyun(context)
    case 'alibaba-free': return alibaba(context)
  }
}

async function detect(id: TranslatorId, ctx: TranslatorContext): Promise<string> {
  switch (id) {
    case 'baidu': {
      const response = await ctx.http.request<Record<string, unknown>>('https://fanyi.baidu.com/langdetect', {
        method: 'POST', form: { query: ctx.text }, timeoutMs: ctx.timeoutMs, signal: ctx.signal
      })
      ensureOk(response)
      return stringValue(response.data.lan, 'en')
    }
    case 'tencent': {
      const response = await ctx.http.request<Record<string, any>>('https://fanyi.qq.com/api/translate', {
        method: 'POST', form: { sourceText: ctx.text }, timeoutMs: ctx.timeoutMs, signal: ctx.signal
      })
      ensureOk(response)
      return stringValue(response.data?.translate?.source, 'en')
    }
    case 'google': {
      const base = param(ctx.params, 'url', 'https://translation.googleapis.com/language/translate/v2')
      const apiKey = required(ctx.params, 'apiKey', 'Api Key is required')
      const response = await ctx.http.request<Record<string, any>>(`${base.replace(/\/$/, '')}/detect`, {
        query: { key: apiKey, q: ctx.text }, timeoutMs: ctx.timeoutMs, signal: ctx.signal,
        endpointPolicy: policy(base, 'https://translation.googleapis.com/language/translate/v2')
      })
      ensureOk(response)
      return stringValue(response.data?.data?.detections?.[0]?.[0]?.language, 'en')
    }
    case 'google-free': {
      const result = await googleFreeRaw(ctx)
      return stringValue(result?.[2], 'en')
    }
    case 'bing': {
      const { token, base } = await bingToken(ctx)
      const response = await ctx.http.request<any[]>(`${base.replace(/\/$/, '')}/detect`, {
        method: 'POST', query: { 'api-version': '3.0' }, json: [{ Text: ctx.text }],
        headers: bingHeaders(token), timeoutMs: ctx.timeoutMs, signal: ctx.signal,
        endpointPolicy: policy(base, 'https://api-edge.cognitive.microsofttranslator.com')
      })
      ensureOk(response)
      return stringValue(response.data?.[0]?.language, 'en')
    }
    default:
      throw new Error(`provider ${id} does not support language detection`)
  }
}

async function dictionary(id: TranslatorId, ctx: TranslatorContext): Promise<DictResult> {
  if (id === 'youdao') return youdao(ctx, true) as Promise<DictResult>
  if (id === 'google-free') return googleFree(ctx, true) as Promise<DictResult>
  throw new Error(`provider ${id} does not support dictionary translation`)
}

const YOUDAO_DEFAULT = 'http://openapi.youdao.com/api'
async function youdao(ctx: TranslatorContext, dictionaryMode: boolean): Promise<TranslatorResult> {
  const url = param(ctx.params, 'url', YOUDAO_DEFAULT)
  const appKey = required(ctx.params, 'appKey', 'App ID and Key is required')
  const key = required(ctx.params, 'key', 'App ID and Key is required')
  const curtime = String(Math.floor(Date.now() / 1000))
  const salt = randomBytes(16).toString('hex')
  const truncated = ctx.text.length <= 20 ? ctx.text : `${ctx.text.slice(0, 10)}${ctx.text.length}${ctx.text.slice(-10)}`
  const sign = createHash('sha256').update(appKey + truncated + salt + curtime + key).digest('hex')
  const response = await ctx.http.request<Record<string, any>>(url, {
    query: { q: ctx.text, from: ctx.from, to: ctx.to, appKey, salt, sign, signType: 'v3', curtime, ext: 'mp3' },
    timeoutMs: ctx.timeoutMs, signal: ctx.signal,
    endpointPolicy: policy(url, YOUDAO_DEFAULT, 'legacy-http')
  })
  ensureOk(response)
  const result = response.data
  if (result.errorCode && result.errorCode !== '0') throw new Error(`有道翻译错误：${String(result.errorCode)}`)
  if (!dictionaryMode) {
    if (Array.isArray(result.translation)) return result.translation.join('\n').trim()
    throw providerDataError(result)
  }
  const target: DictResult = { text: '', pronunciations: [], explanations: [], wfs: [] }
  if (!result.isWord || !result.basic) {
    if (Array.isArray(result.translation)) {
      target.text = result.translation.join('\n').trim()
      return target
    }
    throw providerDataError(result)
  }
  target.text = Array.isArray(result.translation) ? result.translation.join('\n') : ''
  const basic = result.basic as Record<string, any>
  if (basic['us-phonetic']) target.pronunciations!.push({ region: '美', symbol: basic['us-phonetic'], voice: basic['us-speech'] ?? '' })
  if (basic['uk-phonetic']) target.pronunciations!.push({ region: '英', symbol: basic['uk-phonetic'], voice: basic['uk-speech'] ?? '' })
  if (basic.phonetic && target.pronunciations!.length === 0) target.pronunciations!.push({ region: '', symbol: basic.phonetic, voice: '' })
  for (const item of Array.isArray(basic.explains) ? basic.explains : []) {
    const raw = String(item)
    const head = raw.split(' ')[0]
    const trait = head.endsWith('.') ? head : ''
    target.explanations!.push({ trait, explains: raw.replace(trait, '').trim().split('；') })
  }
  target.wfs = Array.isArray(basic.wfs) ? basic.wfs.map((item: any) => ({ name: String(item.wf?.name ?? ''), value: String(item.wf?.value ?? '') })) : []
  if (Array.isArray(result.web)) target.web = result.web.map((item: any) => ({ name: String(item.key ?? ''), list: Array.isArray(item.value) ? item.value.map(String) : [] }))
  return target
}

const BAIDU_DEFAULT = 'https://fanyi-api.baidu.com/api/trans/vip/translate'
async function baidu(ctx: TranslatorContext): Promise<string> {
  const url = param(ctx.params, 'url', BAIDU_DEFAULT)
  const appid = required(ctx.params, 'appid', 'App ID and Secret is required')
  const secret = required(ctx.params, 'secret', 'App ID and Secret is required')
  const salt = `${Date.now()}${Math.floor(Math.random() * 100000)}`
  const sign = createHash('md5').update(appid + ctx.text + salt + secret).digest('hex')
  const response = await ctx.http.request<Record<string, any>>(url, {
    query: { q: ctx.text, from: ctx.from, to: ctx.to, appid, salt, sign },
    timeoutMs: ctx.timeoutMs, signal: ctx.signal, endpointPolicy: policy(url, BAIDU_DEFAULT)
  })
  ensureOk(response)
  if (Array.isArray(response.data.trans_result)) return response.data.trans_result.map(item => String(item.dst ?? '')).join('\n').trim()
  throw new Error(response.data.error_msg ? `百度翻译错误：${response.data.error_msg}` : providerDataError(response.data).message)
}

const TENCENT_DEFAULT = 'tmt.tencentcloudapi.com'
async function tencent(ctx: TranslatorContext): Promise<string> {
  const endpoint = hostParam(ctx.params, 'url', TENCENT_DEFAULT)
  const region = param(ctx.params, 'region', 'ap-chengdu')
  const secretId = required(ctx.params, 'secretId', 'SecretId and SecretKey is required')
  const secretKey = required(ctx.params, 'secretKey', 'SecretId and SecretKey is required')
  const payload = JSON.stringify({ SourceText: ctx.text, Source: ctx.from, Target: ctx.to, ProjectId: 0 })
  const headers = tencentHeaders({ endpoint, service: 'tmt', action: 'TextTranslate', version: '2018-03-21', region, secretId, secretKey, payload })
  const response = await ctx.http.request<Record<string, any>>(`https://${endpoint}`, {
    method: 'POST', text: payload, headers, timeoutMs: ctx.timeoutMs, signal: ctx.signal
  })
  ensureOk(response)
  if (response.data.Response?.Error) throw new Error(`腾讯翻译错误：${response.data.Response.Error.Message ?? response.data.Response.Error.Code}`)
  const value = response.data.Response?.TargetText
  if (typeof value === 'string') return value.trim()
  throw providerDataError(response.data)
}

const GOOGLE_DEFAULT = 'https://translation.googleapis.com/language/translate/v2'
async function google(ctx: TranslatorContext): Promise<string> {
  const url = param(ctx.params, 'url', GOOGLE_DEFAULT)
  const apiKey = required(ctx.params, 'apiKey', 'Api Key is required')
  const response = await ctx.http.request<Record<string, any>>(url, {
    method: 'POST', query: { key: apiKey }, json: { q: ctx.text, target: ctx.to },
    timeoutMs: ctx.timeoutMs, signal: ctx.signal, endpointPolicy: policy(url, GOOGLE_DEFAULT)
  })
  ensureOk(response)
  const item = response.data?.data?.translations?.[0]
  if (typeof item?.translatedText === 'string') return item.translatedText
  throw providerDataError(response.data)
}

const GOOGLE_FREE_DEFAULT = 'https://translate.google.com'
async function googleFreeRaw(ctx: TranslatorContext): Promise<any[]> {
  const base = param(ctx.params, 'url', GOOGLE_FREE_DEFAULT).replace(/\/$/, '')
  const response = await ctx.http.request<any[]>(
    `${base}/translate_a/single?dt=at&dt=bd&dt=ex&dt=ld&dt=md&dt=qca&dt=rw&dt=rm&dt=ss&dt=t`,
    {
      query: {
        client: 'gtx', sl: ctx.from, tl: ctx.to, hl: ctx.to, ie: 'UTF-8', oe: 'UTF-8',
        otf: '1', ssel: '0', tsel: '0', kc: '7', q: ctx.text
      },
      timeoutMs: ctx.timeoutMs, signal: ctx.signal, endpointPolicy: policy(base, GOOGLE_FREE_DEFAULT)
    }
  )
  ensureOk(response)
  if (!Array.isArray(response.data)) throw providerDataError(response.data)
  return response.data
}

async function googleFree(ctx: TranslatorContext, dictionaryMode: boolean): Promise<TranslatorResult> {
  const data = await googleFreeRaw(ctx)
  if (!dictionaryMode) {
    const segments = Array.isArray(data[0]) ? data[0] : []
    const result = segments.map((segment: any) => typeof segment?.[0] === 'string' ? segment[0] : '').join('').trim()
    if (result) return result
    throw providerDataError(data)
  }
  const result: DictResult = { text: '', pronunciations: [], explanations: [], sentence: [] }
  result.text = Array.isArray(data[0]) ? data[0].map((segment: any) => segment?.[0] ?? '').join('').trim() : ''
  if (data?.[0]?.[1]?.[3]) result.pronunciations!.push({ symbol: String(data[0][1][3]), voice: '' })
  if (Array.isArray(data[1])) {
    for (const item of data[1]) result.explanations!.push({ trait: String(item?.[0] ?? ''), explains: Array.isArray(item?.[2]) ? item[2].map((x: any) => String(x?.[0] ?? '')) : [] })
  }
  if (Array.isArray(data?.[13]?.[0])) result.sentence = data[13][0].map((item: any) => String(item?.[0] ?? ''))
  if (!result.text && result.explanations!.length === 0) throw providerDataError(data)
  return result
}

const BING_TOKEN_DEFAULT = 'https://edge.microsoft.com/translate/auth'
const BING_DEFAULT = 'https://api-edge.cognitive.microsofttranslator.com'
async function bingToken(ctx: TranslatorContext): Promise<{ token: string; base: string }> {
  const tokenUrl = param(ctx.params, 'token_url', BING_TOKEN_DEFAULT)
  const base = param(ctx.params, 'url', BING_DEFAULT)
  const response = await ctx.http.request<string>(tokenUrl, {
    responseType: 'text', timeoutMs: ctx.timeoutMs, signal: ctx.signal,
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/150.0' },
    endpointPolicy: policy(tokenUrl, BING_TOKEN_DEFAULT)
  })
  ensureOk(response)
  if (!String(response.data).trim()) throw new Error('Get Token Failed')
  return { token: String(response.data).trim(), base }
}
function bingHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/150.0' }
}
async function bing(ctx: TranslatorContext): Promise<string> {
  const { token, base } = await bingToken(ctx)
  const response = await ctx.http.request<any[]>(`${base.replace(/\/$/, '')}/translate`, {
    method: 'POST', query: { from: ctx.from, to: ctx.to, 'api-version': '3.0', includeSentenceLength: 'true' },
    json: [{ Text: ctx.text }], headers: bingHeaders(token), timeoutMs: ctx.timeoutMs, signal: ctx.signal,
    endpointPolicy: policy(base, BING_DEFAULT)
  })
  ensureOk(response)
  const text = response.data?.[0]?.translations?.[0]?.text
  if (typeof text === 'string') return text.trim()
  throw providerDataError(response.data)
}

const OPENAI_DEFAULT = 'https://api.openai.com/v1/chat/completions'
const OPENAI_PROMPT = JSON.stringify([
  { role: 'system', content: 'You are a professional translation engine, please translate the text into a colloquial, professional, elegant and fluent content, without the style of machine translation. You must only translate the text content, never interpret it.' },
  { role: 'user', content: 'Translate into $to:\n"""\n$text\n"""' }
], undefined, '\t')
async function openai(ctx: TranslatorContext): Promise<string> {
  const url = param(ctx.params, 'url', OPENAI_DEFAULT)
  const apiKey = required(ctx.params, 'apiKey', 'Api Key is required')
  const model = param(ctx.params, 'model', 'gpt-3.5-turbo')
  const prompt = param(ctx.params, 'prompt', OPENAI_PROMPT)
  let messages: any[]
  try {
    const parsed = JSON.parse(prompt)
    if (!Array.isArray(parsed)) throw new Error()
    messages = parsed.map(item => ({ ...item, content: String(item.content).replaceAll('$text', ctx.text).replaceAll('$from', ctx.from).replaceAll('$to', ctx.to) }))
  } catch { throw new Error('Prompt is invalid') }
  const response = await ctx.http.request<Record<string, any>>(url, {
    method: 'POST', headers: { authorization: `Bearer ${apiKey}` },
    json: { model, temperature: 0, stream: false, top_p: 1, frequency_penalty: 1, presence_penalty: 1, messages },
    timeoutMs: ctx.timeoutMs, signal: ctx.signal, endpointPolicy: policy(url, OPENAI_DEFAULT)
  })
  ensureOk(response)
  const text = response.data?.choices?.[0]?.message?.content
  if (typeof text === 'string' && text.trim()) return trimOuterQuote(text.trim())
  throw providerDataError(response.data)
}

const GEMINI_DEFAULT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent'
const GEMINI_PROMPT = JSON.stringify([
  { role: 'user', parts: [{ text: 'You are a professional translation engine, please translate the text into a colloquial, professional, elegant and fluent content, without the style of machine translation. You must only translate the text content, never interpret it.' }] },
  { role: 'model', parts: [{ text: 'Ok, I will only translate the text content, never interpret it.' }] },
  { role: 'user', parts: [{ text: 'Translate into Chinese\n"""\nhello\n"""' }] },
  { role: 'model', parts: [{ text: '你好' }] },
  { role: 'user', parts: [{ text: 'Translate into $to\n"""\n$text\n"""' }] }
], undefined, '\t')
async function gemini(ctx: TranslatorContext): Promise<string> {
  const base = param(ctx.params, 'url', GEMINI_DEFAULT)
  const apiKey = required(ctx.params, 'apiKey', 'Api Key is required')
  const prompt = param(ctx.params, 'prompt', GEMINI_PROMPT)
  let contents: any[]
  try {
    const parsed = JSON.parse(prompt)
    if (!Array.isArray(parsed)) throw new Error()
    contents = parsed.map(item => ({ ...item, parts: [{ text: String(item.parts?.[0]?.text ?? '').replaceAll('$text', ctx.text).replaceAll('$from', ctx.from).replaceAll('$to', ctx.to) }] }))
  } catch { throw new Error('Prompt is invalid') }
  const url = new URL(base)
  url.searchParams.set('key', apiKey)
  const response = await ctx.http.request<Record<string, any>>(url.toString(), {
    method: 'POST', json: { contents, safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
    ] }, timeoutMs: ctx.timeoutMs, signal: ctx.signal, endpointPolicy: policy(base, GEMINI_DEFAULT)
  })
  ensureOk(response)
  const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (typeof text === 'string' && text.trim()) return trimOuterQuote(text.trim())
  throw providerDataError(response.data)
}

async function deepl(ctx: TranslatorContext): Promise<string> {
  const type = param(ctx.params, 'type', 'free')
  if (type === 'api') {
    const key = required(ctx.params, 'authKey', 'Auth Key is required')
    const url = key.endsWith(':fx') ? 'https://api-free.deepl.com/v2/translate' : key.endsWith(':dp') ? 'https://api.deepl-pro.com/v2/translate' : 'https://api.deepl.com/v2/translate'
    const body: Record<string, unknown> = { text: [ctx.text], target_lang: ctx.to }
    if (ctx.from !== 'auto') body.source_lang = ctx.from
    const response = await ctx.http.request<Record<string, any>>(url, {
      method: 'POST', headers: { authorization: `DeepL-Auth-Key ${key}` }, json: body,
      timeoutMs: ctx.timeoutMs, signal: ctx.signal
    })
    ensureOk(response)
    const value = response.data?.translations?.[0]?.text
    if (typeof value === 'string') return value.trim()
    throw providerDataError(response.data)
  }
  if (type === 'deeplx') {
    const url = required(ctx.params, 'url', 'DeepLX URL is required')
    const response = await ctx.http.request<Record<string, any>>(url, {
      method: 'POST', json: { source_lang: ctx.from, target_lang: ctx.to, text: ctx.text },
      timeoutMs: ctx.timeoutMs, signal: ctx.signal, endpointPolicy: 'user-endpoint'
    })
    ensureOk(response)
    if (typeof response.data.data === 'string') return response.data.data
    throw providerDataError(response.data)
  }
  const rand = (Math.floor(Math.random() * 99999) + 100000) * 1000
  const iCount = ctx.text.split('i').length
  const now = Date.now()
  const body = { jsonrpc: '2.0', method: 'LMT_handle_texts', params: {
    splitting: 'newlines', lang: { source_lang_user_selected: ctx.from !== 'auto' ? ctx.from.slice(0, 2) : 'auto', target_lang: ctx.to.slice(0, 2) },
    texts: [{ text: ctx.text, requestAlternatives: 3 }], timestamp: now - (now % iCount) + iCount
  }, id: rand }
  let text = JSON.stringify(body)
  text = text.replace('"method":"', (rand + 5) % 29 === 0 || (rand + 3) % 13 === 0 ? '"method" : "' : '"method": "')
  const response = await ctx.http.request<Record<string, any>>('https://www2.deepl.com/jsonrpc', {
    method: 'POST', text, headers: { 'content-type': 'application/json' }, timeoutMs: ctx.timeoutMs, signal: ctx.signal
  })
  ensureOk(response)
  const value = response.data?.result?.texts?.[0]?.text
  if (typeof value === 'string') return value.trim()
  throw providerDataError(response.data)
}

const CAIYUN_DEFAULT = 'http://api.interpreter.caiyunai.com/v1/translator'
async function caiyun(ctx: TranslatorContext): Promise<string> {
  const url = param(ctx.params, 'url', CAIYUN_DEFAULT)
  const token = required(ctx.params, 'token', 'Token is required')
  const response = await ctx.http.request<Record<string, any>>(url, {
    method: 'POST', headers: { 'x-authorization': `token ${token}` },
    json: { source: [ctx.text], trans_type: `${ctx.from}2${ctx.to}`, request_id: 'demo', detect: true },
    timeoutMs: ctx.timeoutMs, signal: ctx.signal, endpointPolicy: policy(url, CAIYUN_DEFAULT, 'legacy-http')
  })
  ensureOk(response)
  if (typeof response.data?.target?.[0] === 'string') return response.data.target[0]
  throw providerDataError(response.data)
}

const ALIBABA_DEFAULT = 'https://translate.alibaba.com/api/translate/text'
async function alibaba(ctx: TranslatorContext): Promise<string> {
  const url = param(ctx.params, 'url', ALIBABA_DEFAULT)
  const response = await ctx.http.request<Record<string, any>>(url, {
    query: { domain: 'general', query: ctx.text, srcLang: ctx.from, tgtLang: ctx.to },
    timeoutMs: ctx.timeoutMs, signal: ctx.signal, endpointPolicy: policy(url, ALIBABA_DEFAULT)
  })
  ensureOk(response)
  if (response.data.success && typeof response.data?.data?.translateText === 'string') return response.data.data.translateText
  throw providerDataError(response.data)
}

export function tencentHeaders(input: { endpoint: string; service: string; action: string; version: string; region: string; secretId: string; secretKey: string; payload: string; contentType?: string; signAction?: boolean }): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const contentType = input.contentType ?? 'application/json'
  const canonicalHeaders = `content-type:${contentType}\nhost:${input.endpoint}\n${input.signAction ? `x-tc-action:${input.action.toLowerCase()}\n` : ''}`
  const signedHeaders = input.signAction ? 'content-type;host;x-tc-action' : 'content-type;host'
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(input.payload)}`
  const scope = `${date}/${input.service}/tc3_request`
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`
  const kDate = hmac(Buffer.from(`TC3${input.secretKey}`), date)
  const kService = hmac(kDate, input.service)
  const kSigning = hmac(kService, 'tc3_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')
  return {
    authorization: `TC3-HMAC-SHA256 Credential=${input.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'content-type': contentType, host: input.endpoint,
    'x-tc-action': input.action, 'x-tc-timestamp': String(timestamp),
    'x-tc-version': input.version, 'x-tc-region': input.region
  }
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }
function hmac(key: string | Buffer, value: string): Buffer { return createHmac('sha256', key).update(value).digest() }
function param(params: Record<string, unknown>, key: string, fallback: string): string {
  const value = params[key]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}
function required(params: Record<string, unknown>, key: string, message: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.trim().length === 0 || value === '••••••••') throw new Error(message)
  return value
}
function hostParam(params: Record<string, unknown>, key: string, fallback: string): string {
  const value = param(params, key, fallback).trim().replace(/^https?:\/\//, '').replace(/\/$/, '')
  if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(value)) throw new Error('腾讯接口地址无效')
  return value
}
function policy(value: string, defaultValue: string, defaultPolicy: EndpointPolicy = 'official'): EndpointPolicy {
  return value.replace(/\/$/, '') === defaultValue.replace(/\/$/, '') ? defaultPolicy : 'user-endpoint'
}
function ensureOk(response: { ok: boolean; status: number; data: unknown }): void {
  if (!response.ok) throw new Error(`Http Request Error\nHttp Status: ${response.status}\n${safeJson(response.data)}`)
}
function safeJson(value: unknown): string {
  try { return JSON.stringify(value).slice(0, 2000) } catch { return '[invalid response]' }
}
function providerDataError(value: unknown): Error { return new Error(`服务返回结果无效：${safeJson(value)}`) }
function stringValue(value: unknown, fallback: string): string { return typeof value === 'string' && value ? value : fallback }
function trimOuterQuote(value: string): string { return value.startsWith('"') && value.endsWith('"') && value.length > 1 ? value.slice(1, -1).trim() : value }
