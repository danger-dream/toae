import { createHash } from 'node:crypto'
import { JSONPath } from 'jsonpath-plus'
import type { ProviderHttpClient } from './http'
import { tencentHeaders } from './translator'

export const OCR_IDS = ['baidu', 'tencent', 'custom'] as const
export type OcrId = (typeof OCR_IDS)[number]

export interface OcrPoint {
  x: number
  y: number
}

export interface OcrItem {
  text: string
  confidence: number
  polygon: OcrPoint[]
}

export interface OcrDocument {
  text: string
  items: OcrItem[]
}

export interface OcrContext {
  http: ProviderHttpClient
  params: Record<string, unknown>
  imageBytes: Uint8Array
  signal: AbortSignal
  timeoutMs: number
  /** Request a response variant that includes text coordinates when available. */
  positioned?: boolean
}

interface BaiduToken {
  token: string
  expiresAt: number
}
const baiduTokens = new Map<string, BaiduToken>()
const baiduTokenFlights = new Map<string, Promise<BaiduToken>>()

export function hasOcr(id: string): id is OcrId {
  return (OCR_IDS as readonly string[]).includes(id)
}

export async function invokeOcr(id: OcrId, context: OcrContext): Promise<string> {
  return (await invokeOcrDocument(id, context)).text
}

export async function invokeOcrDocument(id: OcrId, context: OcrContext): Promise<OcrDocument> {
  if (context.imageBytes.byteLength === 0 || context.imageBytes.byteLength > 20 * 1024 * 1024) {
    throw new Error('图片数据为空或超过大小限制')
  }
  switch (id) {
    case 'baidu': return baidu(context)
    case 'tencent': return tencent(context)
    case 'custom': return custom(context)
  }
}

const BAIDU_DEFAULT = 'https://aip.baidubce.com'
const BAIDU_TYPES = new Set(['general_basic', 'general', 'accurate_basic', 'accurate'])

async function baidu(context: OcrContext): Promise<OcrDocument> {
  const base = param(context.params, 'url', BAIDU_DEFAULT).replace(/\/$/, '')
  const clientId = required(context.params, 'client_id', 'Client ID 和 Secret 不可为空')
  const clientSecret = required(context.params, 'client_secret', 'Client ID 和 Secret 不可为空')
  const configuredType = param(context.params, 'type', 'general_basic')
  if (!BAIDU_TYPES.has(configuredType)) throw new Error('类型无效')
  const type = context.positioned
    ? configuredType === 'general_basic' ? 'general' : configuredType === 'accurate_basic' ? 'accurate' : configuredType
    : configuredType
  const cacheKey = createHash('sha256').update(`${base}\0${clientId}\0${clientSecret}\0${type}`).digest('hex')
  let token = await getBaiduToken(context, base, clientId, clientSecret, cacheKey, type)
  for (let authAttempt = 0; authAttempt < 2; authAttempt += 1) {
    const response = await context.http.request<Record<string, any>>(`${base}/rest/2.0/ocr/v1/${type}`, {
      method: 'POST', query: { access_token: token.token },
      form: { detect_direction: 'false', image: Buffer.from(context.imageBytes).toString('base64') },
      timeoutMs: context.timeoutMs, signal: context.signal,
      endpointPolicy: base === BAIDU_DEFAULT ? 'official' : 'user-endpoint'
    })
    ensureOk(response)
    if (Array.isArray(response.data.words_result)) {
      const words = response.data.words_result.map(item => String(item.words ?? ''))
      const items = response.data.words_result
        .map(item => ocrItem(String(item.words ?? ''), item.probability?.average, item.location))
        .filter((item): item is OcrItem => Boolean(item))
      return makeDocument(words.join('\n'), items)
    }
    const code = Number(response.data.error_code)
    if ((code === 110 || code === 111) && authAttempt === 0) {
      baiduTokens.delete(cacheKey)
      token = await getBaiduToken(context, base, clientId, clientSecret, cacheKey, type)
      continue
    }
    throwBaiduError(code, response.data)
  }
  throw new Error('Token无效或已过期且超过重试次数')
}

async function getBaiduToken(context: OcrContext, base: string, clientId: string, clientSecret: string, cacheKey: string, type: string): Promise<BaiduToken> {
  const cached = baiduTokens.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached
  const inFlight = baiduTokenFlights.get(cacheKey)
  if (inFlight) return inFlight
  const flight = (async () => {
    const response = await context.http.request<Record<string, any>>(`${base}/oauth/2.0/token`, {
      method: 'POST', query: { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret },
      timeoutMs: context.timeoutMs, signal: context.signal,
      endpointPolicy: base === BAIDU_DEFAULT ? 'official' : 'user-endpoint'
    })
    ensureOk(response)
    if (typeof response.data.access_token !== 'string') throw new Error('Get Access Token Failed!')
    const scope = `brain_ocr_${type}`
    if (typeof response.data.scope === 'string' && !response.data.scope.includes(scope)) throw new Error('Access Token 不支持所选 OCR 类型')
    const seconds = Math.max(120, Number(response.data.expires_in) || 2592000)
    const token = { token: response.data.access_token, expiresAt: Date.now() + seconds * 1000 - 60_000 }
    baiduTokens.set(cacheKey, token)
    return token
  })().finally(() => baiduTokenFlights.delete(cacheKey))
  baiduTokenFlights.set(cacheKey, flight)
  return flight
}

function throwBaiduError(code: number, data: unknown): never {
  const messages: Record<number, string> = {
    17: '单日请求量超过可用限额', 18: '超过并发限制，请稍后重试',
    19: '请求总量超过限额', 216604: '请求总量超过限额',
    216102: '不支持该类型的服务', 110: 'Token无效', 111: 'Token已过期'
  }
  throw new Error(messages[code] ?? `百度 OCR 错误：${safeJson(data)}`)
}

const TENCENT_DEFAULT = 'ocr.tencentcloudapi.com'
async function tencent(context: OcrContext): Promise<OcrDocument> {
  const endpoint = hostParam(context.params, 'url', TENCENT_DEFAULT)
  const region = param(context.params, 'region', 'ap-guangzhou')
  const secretId = required(context.params, 'secretId', 'SecretId 和 SecretKey 不能为空')
  const secretKey = required(context.params, 'secretKey', 'SecretId 和 SecretKey 不能为空')
  const action = param(context.params, 'type', 'GeneralAccurateOCR')
  if (action !== 'GeneralBasicOCR' && action !== 'GeneralAccurateOCR') throw new Error('类型无效')
  const payload = JSON.stringify({ ImageBase64: Buffer.from(context.imageBytes).toString('base64') })
  const headers = tencentHeaders({
    endpoint, service: 'ocr', action, version: '2018-11-19', region, secretId, secretKey, payload,
    contentType: 'application/json; charset=utf-8', signAction: true
  })
  const response = await context.http.request<Record<string, any>>(`https://${endpoint}`, {
    method: 'POST', text: payload, headers, timeoutMs: context.timeoutMs, signal: context.signal
  })
  ensureOk(response)
  const result = response.data.Response
  if (result?.Error) throwTencentError(String(result.Error.Code ?? ''), String(result.Error.Message ?? ''))
  if (Array.isArray(result?.TextDetections)) {
    const words = result.TextDetections.map((item: any) => String(item.DetectedText ?? ''))
    const items = result.TextDetections
      .map((item: any) => ocrItem(String(item.DetectedText ?? ''), item.Confidence, item.Polygon ?? item.ItemPolygon))
      .filter((item: OcrItem | undefined): item is OcrItem => Boolean(item))
    return makeDocument(words.join('\n'), items)
  }
  throw new Error(`腾讯 OCR 返回结果无效：${safeJson(result)}`)
}

const CUSTOM_DEFAULT_DATA = JSON.stringify({ method: 'POST', headers: {}, body: {}, query: {}, timeout: 5000 }, undefined, '\t')
async function custom(context: OcrContext): Promise<OcrDocument> {
  const url = required(context.params, 'url', '连接地址不能为空')
  const template = param(context.params, 'data', CUSTOM_DEFAULT_DATA)
  const bodyType = param(context.params, 'bodyType', 'json')
  const resultType = param(context.params, 'resType', 'text')
  const jsonpath = param(context.params, 'jsonpath', '$')
  if (!template.includes('{image}')) throw new Error('请求参数中不包含"{image}"')
  const encoded = Buffer.from(context.imageBytes).toString('base64')
  let request: Record<string, any>
  try {
    request = JSON.parse(template.replaceAll('{image}', encoded))
  } catch (error) {
    throw new Error(`请求参数解析失败: ${error instanceof Error ? error.message : String(error)}`)
  }
  const method = String(request.method ?? 'POST').toUpperCase()
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) throw new Error('请求 method 无效')
  const timeoutMs = Math.min(context.timeoutMs, Math.max(100, Number(request.timeout) || 5000))
  const options: Parameters<ProviderHttpClient['request']>[1] = {
    method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
    headers: cleanStringRecord(request.headers, 64),
    query: cleanQueryRecord(request.query, 64),
    timeoutMs,
    responseType: resultType === 'text' ? 'text' : 'json',
    endpointPolicy: 'custom-ocr',
    signal: context.signal
  }
  const body = request.body
  if (body !== undefined) {
    if (bodyType === 'text') options.text = typeof body === 'string' ? body : JSON.stringify(body)
    else if (bodyType === 'form') options.form = cleanFormRecord(body, 128)
    else if (bodyType === 'json') options.json = body
    else throw new Error('数据类型无效')
  }
  const response = await context.http.request(url, options)
  ensureOk(response)
  if (resultType === 'text') {
    return makeDocument(typeof response.data === 'string' ? response.data : safeJson(response.data), [])
  }
  let text: string
  try {
    const result = JSONPath({ path: jsonpath, json: response.data as any, resultType: 'value' })
    if (!Array.isArray(result) || result.length === 0) throw new Error('未匹配到结果')
    text = result.map(value => typeof value === 'string' ? value : safeJson(value)).join('\n')
  } catch (error) {
    throw new Error(`提取JSON结果错误: ${error instanceof Error ? error.message : String(error)}`)
  }
  return makeDocument(text, parseStructuredItems(response.data))
}

export function parseStructuredItems(value: unknown): OcrItem[] {
  const arrays: unknown[][] = []
  collectItemArrays(value, arrays, 0)
  for (const array of arrays) {
    const items = array
      .slice(0, 2048)
      .map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined
        const record = item as Record<string, unknown>
        const text = firstString(record, ['text', 'words', 'DetectedText', 'detectedText'])
        const confidence = firstNumber(record, ['score', 'confidence', 'Confidence', 'probability'])
        const box = record.box ?? record.polygon ?? record.Polygon ?? record.itemPolygon ?? record.ItemPolygon ?? record.text_region ?? record.textRegion ?? record.location
        return ocrItem(text, confidence, box)
      })
      .filter((item): item is OcrItem => Boolean(item))
    if (items.length > 0) return items
  }
  return []
}

function collectItemArrays(value: unknown, target: unknown[][], depth: number): void {
  if (depth > 3 || !value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    if (value.length > 0 && value.some(item => item && typeof item === 'object' && !Array.isArray(item))) target.push(value)
    for (const item of value.slice(0, 8)) collectItemArrays(item, target, depth + 1)
    return
  }
  const record = value as Record<string, unknown>
  for (const key of ['items', 'TextDetections', 'words_result']) {
    if (Array.isArray(record[key])) target.push(record[key] as unknown[])
  }
  for (const key of ['data', 'result', 'results', 'response', 'Response']) {
    if (record[key] !== undefined) collectItemArrays(record[key], target, depth + 1)
  }
}

function ocrItem(textValue: unknown, confidenceValue: unknown, boxValue: unknown): OcrItem | undefined {
  const text = typeof textValue === 'string' ? textValue.trim() : ''
  const polygon = normalizePolygon(boxValue)
  if (!text || text.length > 20_000 || polygon.length < 4) return undefined
  let confidence = Number(confidenceValue)
  if (!Number.isFinite(confidence)) confidence = 1
  if (confidence > 1 && confidence <= 100) confidence /= 100
  confidence = Math.max(0, Math.min(1, confidence))
  return { text, confidence, polygon }
}

function normalizePolygon(value: unknown): OcrPoint[] {
  if (Array.isArray(value)) {
    if (value.length === 4 && value.every(item => Number.isFinite(Number(item)))) {
      const [x0, y0, x1, y1] = value.map(Number)
      return rectanglePolygon(x0, y0, x1 - x0, y1 - y0)
    }
    const points = value.map(point => {
      if (Array.isArray(point) && point.length >= 2) return finitePoint(point[0], point[1])
      if (point && typeof point === 'object') {
        const record = point as Record<string, unknown>
        return finitePoint(record.x ?? record.X, record.y ?? record.Y)
      }
      return undefined
    }).filter((point): point is OcrPoint => Boolean(point))
    return points.length >= 4 ? points : []
  }
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const left = record.left ?? record.x ?? record.X
  const top = record.top ?? record.y ?? record.Y
  const width = record.width ?? record.Width
  const height = record.height ?? record.Height
  return rectanglePolygon(Number(left), Number(top), Number(width), Number(height))
}

function rectanglePolygon(x: number, y: number, width: number, height: number): OcrPoint[] {
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return []
  return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }]
}

function finitePoint(xValue: unknown, yValue: unknown): OcrPoint | undefined {
  const x = Number(xValue)
  const y = Number(yValue)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined
}

function makeDocument(text: string, items: OcrItem[]): OcrDocument {
  const normalizedItems = items.filter(item => item.text && item.confidence >= 0 && item.polygon.length >= 4)
  const normalizedText = text.trim() || normalizedItems.map(item => item.text).join('\n').trim()
  return { text: normalizedText, items: normalizedItems }
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) if (typeof record[key] === 'string') return String(record[key])
  return ''
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number') return value
    if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).average === 'number') {
      return Number((value as Record<string, unknown>).average)
    }
  }
  return undefined
}

function cleanStringRecord(value: unknown, max: number): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > max) throw new Error('自定义请求字段过多')
  return Object.fromEntries(entries.map(([key, item]) => {
    if (key.length > 128 || typeof item !== 'string' || item.length > 8192) throw new Error('自定义请求字段无效')
    return [key, item]
  }))
}
function cleanQueryRecord(value: unknown, max: number): Record<string, string> { return cleanStringRecord(value, max) }
function cleanFormRecord(value: unknown, max: number): Record<string, string> { return cleanStringRecord(value, max) }

function throwTencentError(code: string, message: string): never {
  const map: Record<string, string> = {
    'AuthFailure.SignatureExpire': '密钥已失效', 'AuthFailure.SignatureFailure': '密钥已失效',
    'AuthFailure.TokenFailure': '密钥已失效', UnauthorizedOperation: '请求未授权',
    ActionOffline: '接口已下线', 'AuthFailure.InvalidSecretId': '密钥非法',
    'AuthFailure.SecretIdNotFound': '密钥非法', IpInBlacklist: 'IP在黑名单中',
    IpNotInWhitelist: 'IP地址不在白名单中', LimitExceeded: '超过配额限制',
    RequestLimitExceeded: '请求次数超过限制', RequestSizeLimitExceeded: '请求包超过限制大小',
    ResourceInsufficient: '资源不足', ResourceNotFound: '资源不存在',
    ResourceUnavailable: '资源不可用', ServiceUnavailable: '当前服务暂时不可用',
    'FailedOperation.ArrearsError': '账号已欠费', 'ResourceUnavailable.InArrears': '账号已欠费',
    'FailedOperation.CountLimitError': '今日次数达到限制', 'FailedOperation.ImageBlur': '图片模糊',
    'FailedOperation.ImageDecodeFailed': '图片解码失败', 'FailedOperation.ImageNoText': '图片中未检测到文本',
    'FailedOperation.ImageSizeTooLarge': '图片尺寸过大', 'FailedOperation.OcrFailed': '腾讯云接口结果：OCR识别失败',
    'FailedOperation.UnOpenError': '服务未开通'
  }
  throw new Error(map[code] ?? (message || code))
}

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
function ensureOk(response: { ok: boolean; status: number; data: unknown }): void {
  if (!response.ok) throw new Error(`Http Request Error\nHttp Status: ${response.status}\n${safeJson(response.data)}`)
}
function safeJson(value: unknown): string {
  try { return JSON.stringify(value).slice(0, 2000) } catch { return '[invalid response]' }
}
