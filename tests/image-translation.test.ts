import { describe, expect, it } from 'vitest'
import { buildImageTextRegions, mapWithConcurrency } from '../electron/main/providers/image-translation'
import type { OcrItem } from '../electron/main/providers/ocr'
import { providerLanguageCode } from '../electron/main/providers/provider-languages'

function item(text: string, x: number, y: number, width: number, height = 16, confidence = 0.99): OcrItem {
  return {
    text,
    confidence,
    polygon: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }]
  }
}

describe('automatic image-translation layout', () => {
  it('merges wrapped paragraph lines while keeping compact labels and list rows separate', () => {
    const regions = buildImageTextRegions([
      item('For you', 114, 14, 61, 21),
      item('Following', 381, 14, 73, 21),
      item('For my first post, I am sharing a letter about why open models', 74, 212, 500, 16),
      item('matter.', 74, 233, 52, 16),
      item('• 5TB cloud storage', 12, 300, 180, 18),
      item('• No credit card required', 12, 321, 220, 18),
      item('https://example.test/path', 10, 400, 180, 16),
      item('163K', 10, 430, 40, 16)
    ], 600, 500)

    expect(regions.map(region => region.sourceText)).toEqual([
      'For you',
      'Following',
      'For my first post, I am sharing a letter about why open models matter.',
      '• 5TB cloud storage',
      '• No credit card required'
    ])
    expect(regions[0]).toMatchObject({ align: 'center', verticalAlign: 'center' })
    expect(regions[2].eraseRects).toHaveLength(2)
    expect(regions[3].eraseRects).toHaveLength(1)
  })

  it('drops low-confidence and out-of-bounds OCR noise', () => {
    const regions = buildImageTextRegions([
      item('valid text', 10, 10, 100),
      item('uncertain text', 10, 50, 100, 16, 0.2),
      item('+', 10, 80, 10)
    ], 300, 200)
    expect(regions).toHaveLength(1)
    expect(regions[0].sourceText).toBe('valid text')
  })

  it('bounds translation request concurrency and preserves result order', async () => {
    let active = 0
    let maximum = 0
    const controller = new AbortController()
    const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, controller.signal, async value => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 2))
      active -= 1
      return value * 2
    })
    expect(maximum).toBe(3)
    expect(result).toEqual([2, 4, 6, 8, 10, 12])
  })
})

describe('Main-side provider language mapping', () => {
  it('uses the exact configured Provider language codes', () => {
    expect(providerLanguageCode('google-free', 'zh_cn')).toBe('zh-CN')
    expect(providerLanguageCode('baidu', 'ja')).toBe('jp')
    expect(providerLanguageCode('bing', 'auto')).toBe('')
    expect(providerLanguageCode('openai', 'zh_cn')).toBe('Simplified Chinese')
  })

  it('rejects a target language unsupported by the selected provider', () => {
    expect(() => providerLanguageCode('caiyun', 'de')).toThrow(/不支持语种/)
  })
})
