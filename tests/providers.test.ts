import { describe, expect, it } from 'vitest'
import type { ProviderHttpClient } from '../electron/main/providers/http'
import { invokeOcr, invokeOcrDocument, OCR_IDS } from '../electron/main/providers/ocr'
import { invokeTranslator, tencentHeaders, TRANSLATOR_IDS, type TranslatorId } from '../electron/main/providers/translator'

interface MockResponse {
  ok?: boolean
  status?: number
  data: unknown
  headers?: Headers
}

class MockHttp {
  readonly calls: Array<{ url: string; options: any }> = []
  constructor(private readonly responses: MockResponse[]) {}

  async request<T>(url: string, options: any = {}) {
    this.calls.push({ url, options })
    const next = this.responses.shift()
    if (!next) throw new Error(`missing mock response for ${url}`)
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      data: next.data as T,
      headers: next.headers ?? new Headers()
    }
  }
}

function translatorContext(http: MockHttp, params: Record<string, unknown> = {}) {
  return {
    http: http as unknown as ProviderHttpClient,
    params,
    text: 'hello',
    from: 'en',
    to: 'zh_cn',
    signal: new AbortController().signal,
    timeoutMs: 5000
  }
}

describe('translation provider adapters', () => {
  it('keeps the exact 11 stable provider IDs', () => {
    expect(TRANSLATOR_IDS).toEqual([
      'youdao', 'baidu', 'tencent', 'google', 'google-free', 'bing',
      'openai', 'gemini-pro', 'deepl', 'caiyun', 'alibaba-free'
    ])
  })

  const cases: Array<{
    id: TranslatorId
    params?: Record<string, unknown>
    responses: MockResponse[]
    expected: string
  }> = [
    { id: 'youdao', params: { appKey: 'id', key: 'key' }, responses: [{ data: { errorCode: '0', translation: ['你好'] } }], expected: '你好' },
    { id: 'baidu', params: { appid: 'id', secret: 'key' }, responses: [{ data: { trans_result: [{ dst: '你好' }] } }], expected: '你好' },
    { id: 'tencent', params: { secretId: 'id', secretKey: 'key' }, responses: [{ data: { Response: { TargetText: '你好' } } }], expected: '你好' },
    { id: 'google', params: { apiKey: 'key' }, responses: [{ data: { data: { translations: [{ translatedText: '你好' }] } } }], expected: '你好' },
    { id: 'google-free', responses: [{ data: [[['你好']]] }], expected: '你好' },
    { id: 'bing', responses: [{ data: 'token' }, { data: [{ translations: [{ text: '你好' }] }] }], expected: '你好' },
    { id: 'openai', params: { apiKey: 'key' }, responses: [{ data: { choices: [{ message: { content: '你好' } }] } }], expected: '你好' },
    { id: 'gemini-pro', params: { apiKey: 'key' }, responses: [{ data: { candidates: [{ content: { parts: [{ text: '你好' }] } }] } }], expected: '你好' },
    { id: 'deepl', params: { type: 'api', authKey: 'key:fx' }, responses: [{ data: { translations: [{ text: '你好' }] } }], expected: '你好' },
    { id: 'caiyun', params: { token: 'token' }, responses: [{ data: { target: ['你好'] } }], expected: '你好' },
    { id: 'alibaba-free', responses: [{ data: { success: true, data: { translateText: '你好' } } }], expected: '你好' }
  ]

  for (const testCase of cases) {
    it(`maps a successful ${testCase.id} response`, async () => {
      const http = new MockHttp(testCase.responses.map(value => structuredClone(value)))
      const result = await invokeTranslator(testCase.id, 'translate', translatorContext(http, testCase.params))
      expect(result).toBe(testCase.expected)
      expect(http.calls.length).toBeGreaterThan(0)
    })
  }

  it('sends Google Free dt values as repeated query keys and parses dictionary data', async () => {
    const http = new MockHttp([{ data: [
      [['你好'], ['问候', null, null, 'nǐ hǎo']],
      [['名词', null, [['你好'], ['您好']]]]
    ] }])
    const result = await invokeTranslator('google-free', 'dict', translatorContext(http))
    const request = http.calls[0]
    const url = new URL(request.url)

    expect(url.searchParams.getAll('dt')).toEqual(['at', 'bd', 'ex', 'ld', 'md', 'qca', 'rw', 'rm', 'ss', 't'])
    expect(request.options.query).not.toHaveProperty('dt')
    expect(`${request.url}${JSON.stringify(request.options.query)}`).not.toMatch(/dt=[^&"}]*,/)
    expect(result).toMatchObject({
      text: '你好问候',
      pronunciations: [{ symbol: 'nǐ hǎo', voice: '' }],
      explanations: [{ trait: '名词', explains: ['你好', '您好'] }]
    })
  })

  it('keeps Google Free empty translation responses invalid', async () => {
    const http = new MockHttp([{ data: [] }])
    await expect(invokeTranslator('google-free', 'translate', translatorContext(http))).rejects.toThrow(/服务返回结果无效/)
  })

  it('uses the OCR-specific Tencent canonical signed headers', () => {
    const headers = tencentHeaders({
      endpoint: 'ocr.tencentcloudapi.com', service: 'ocr', action: 'GeneralAccurateOCR',
      version: '2018-11-19', region: 'ap-guangzhou', secretId: 'id', secretKey: 'key',
      payload: '{}', contentType: 'application/json; charset=utf-8', signAction: true
    })
    expect(headers['content-type']).toBe('application/json; charset=utf-8')
    expect(headers.authorization).toContain('SignedHeaders=content-type;host;x-tc-action')
  })
})

describe('OCR provider adapters', () => {
  it('keeps exactly Baidu, Tencent and Custom', () => {
    expect(OCR_IDS).toEqual(['baidu', 'tencent', 'custom'])
  })

  it('runs Baidu token acquisition and OCR parsing', async () => {
    const http = new MockHttp([
      { data: { access_token: 'token', expires_in: 3600, scope: 'brain_ocr_general_basic' } },
      { data: { words_result: [{ words: '第一行' }, { words: '第二行' }] } }
    ])
    const result = await invokeOcr('baidu', {
      http: http as unknown as ProviderHttpClient,
      params: { client_id: 'unique-client-test', client_secret: 'secret', type: 'general_basic' },
      imageBytes: new Uint8Array([1, 2, 3]), signal: new AbortController().signal, timeoutMs: 5000
    })
    expect(result).toBe('第一行\n第二行')
    expect(http.calls).toHaveLength(2)
  })

  it('signs and parses Tencent OCR', async () => {
    const http = new MockHttp([{ data: { Response: { TextDetections: [{ DetectedText: '文字' }] } } }])
    const result = await invokeOcr('tencent', {
      http: http as unknown as ProviderHttpClient,
      params: { secretId: 'id', secretKey: 'key', type: 'GeneralAccurateOCR' },
      imageBytes: new Uint8Array([1, 2, 3]), signal: new AbortController().signal, timeoutMs: 5000
    })
    expect(result).toBe('文字')
    expect(http.calls[0].options.headers.authorization).toContain('SignedHeaders=content-type;host;x-tc-action')
  })

  it('substitutes image bytes only inside the configured Custom request template', async () => {
    const http = new MockHttp([{ data: '自定义结果' }])
    const data = JSON.stringify({ method: 'POST', headers: {}, body: { image: '{image}' }, query: {}, timeout: 5000 })
    const result = await invokeOcr('custom', {
      http: http as unknown as ProviderHttpClient,
      params: { url: 'https://ocr.example.test/api', data, bodyType: 'json', resType: 'text' },
      imageBytes: new Uint8Array([1, 2, 3]), signal: new AbortController().signal, timeoutMs: 5000
    })
    expect(result).toBe('自定义结果')
    expect(http.calls[0].options.json.image).toBe('AQID')
  })

  it('retains PaddleOCR text coordinates for direct image translation', async () => {
    const http = new MockHttp([{ data: {
      items: [
        { text: 'Hello world', score: 0.998, box: [[10, 12], [110, 12], [110, 30], [10, 30]] },
        { text: 'Second line', score: 0.97, box: [[10, 35], [95, 35], [95, 53], [10, 53]] }
      ],
      texts: ['Hello world', 'Second line']
    } }])
    const data = JSON.stringify({ method: 'POST', headers: {}, body: { image: '{image}' }, query: {}, timeout: 5000 })
    const result = await invokeOcrDocument('custom', {
      http: http as unknown as ProviderHttpClient,
      params: { url: 'https://ocr.example.test/api', data, bodyType: 'json', resType: 'json', jsonpath: '$.texts[*]' },
      imageBytes: new Uint8Array([1, 2, 3]), signal: new AbortController().signal, timeoutMs: 5000
    })
    expect(result.text).toBe('Hello world\nSecond line')
    expect(result.items).toEqual([
      { text: 'Hello world', confidence: 0.998, polygon: [{ x: 10, y: 12 }, { x: 110, y: 12 }, { x: 110, y: 30 }, { x: 10, y: 30 }] },
      { text: 'Second line', confidence: 0.97, polygon: [{ x: 10, y: 35 }, { x: 95, y: 35 }, { x: 95, y: 53 }, { x: 10, y: 53 }] }
    ])
  })
})
