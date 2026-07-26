import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { net } from 'electron'

export type EndpointPolicy = 'official' | 'legacy-http' | 'user-endpoint' | 'custom-ocr' | 'provider-audio'

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  query?: Record<string, string | number | boolean | undefined>
  json?: unknown
  form?: Record<string, string | number | boolean>
  text?: string
  timeoutMs?: number
  responseType?: 'json' | 'text' | 'bytes'
  endpointPolicy?: EndpointPolicy
  signal?: AbortSignal
  maxBytes?: number
}

export interface HttpResponse<T = unknown> {
  ok: boolean
  status: number
  data: T
  headers: Headers
}

const LEGACY_HTTP_HOSTS = new Set(['openapi.youdao.com', 'api.interpreter.caiyunai.com'])
const LEGACY_AUDIO_HOSTS = new Set(['openapi.youdao.com', 'dict.youdao.com', 'tts.youdao.com'])
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export class ProviderHttpClient {
  async request<T = unknown>(urlValue: string, options: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
    const policy = options.endpointPolicy ?? 'official'
    let url = await validateUrl(urlValue, policy)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? 5000, 180_000))
    const controller = new AbortController()
    const abortFromParent = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', abortFromParent, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('provider request timed out')), timeoutMs)

    try {
      let method = options.method ?? 'GET'
      let body: string | URLSearchParams | undefined
      const headers = new Headers(options.headers)
      if (options.json !== undefined) {
        headers.set('content-type', headers.get('content-type') ?? 'application/json')
        body = JSON.stringify(options.json)
      } else if (options.form !== undefined) {
        headers.set('content-type', headers.get('content-type') ?? 'application/x-www-form-urlencoded')
        body = new URLSearchParams(Object.entries(options.form).map(([key, value]) => [key, String(value)] as [string, string]))
      } else if (options.text !== undefined) {
        body = options.text
      }

      for (let redirect = 0; redirect <= 3; redirect += 1) {
        const response = await net.fetch(url.toString(), {
          method,
          headers,
          body,
          signal: controller.signal,
          redirect: 'manual',
          cache: 'no-store',
          credentials: 'omit'
        })
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          if (!location || redirect === 3) throw new Error('provider redirect limit exceeded')
          const nextUrl = await validateUrl(new URL(location, url).toString(), policy)
          if (nextUrl.origin !== url.origin) throw new Error('cross-origin provider redirect is not allowed')
          await response.body?.cancel().catch(() => undefined)
          url = nextUrl
          if (response.status === 303) {
            method = 'GET'
            body = undefined
          }
          continue
        }

        const declaredLength = Number(response.headers.get('content-length') ?? 0)
        const maxBytes = Math.max(1, Math.min(options.maxBytes ?? MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES))
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          await response.body?.cancel().catch(() => undefined)
          throw new Error('provider response exceeds size limit')
        }
        const bytes = await readBoundedBody(response, maxBytes, controller)
        let data: unknown
        if (options.responseType === 'bytes') {
          data = bytes
        } else {
          const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
          if (options.responseType === 'text') {
            data = text
          } else if (text.length === 0) {
            data = null
          } else {
            try { data = JSON.parse(text) } catch { data = text }
          }
        }
        return { ok: response.ok, status: response.status, data: data as T, headers: response.headers }
      }
      throw new Error('provider redirect handling failed')
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abortFromParent)
    }
  }
}

async function readBoundedBody(response: Response, maxBytes: number, controller: AbortController): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        controller.abort(new Error('provider response exceeds size limit'))
        throw new Error('provider response exceeds size limit')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

async function validateUrl(value: string, policy: EndpointPolicy): Promise<URL> {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('provider URL is invalid') }
  if (url.username || url.password) throw new Error('provider URL must not contain credentials')
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('provider URL protocol is not allowed')
  const hostname = url.hostname.toLowerCase()
  const permittedLegacyHttp = LEGACY_HTTP_HOSTS.has(hostname) || (policy === 'provider-audio' && LEGACY_AUDIO_HOSTS.has(hostname))
  if (url.protocol === 'http:' && policy !== 'custom-ocr' && policy !== 'user-endpoint' && !permittedLegacyHttp) {
    throw new Error('insecure provider URL is not allowed')
  }
  if (policy === 'official' || policy === 'legacy-http' || policy === 'provider-audio') await rejectPrivateAddress(url.hostname)
  return url
}

async function rejectPrivateAddress(hostname: string): Promise<void> {
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true })
  if (addresses.length === 0) throw new Error('provider host did not resolve')
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new Error('provider host resolves to a private address')
  }
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '')
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  const parts = normalized.split('.').map(Number)
  if (parts.length !== 4 || parts.some(value => !Number.isInteger(value))) return false
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    parts[0] >= 224
}
