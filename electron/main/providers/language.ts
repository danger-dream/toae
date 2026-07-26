import { detect } from 'tinyld'

const SUPPORTED = new Set([
  'en', 'ja', 'ko', 'fr', 'es', 'de', 'ru', 'nl', 'sv', 'it', 'tr', 'ar', 'vi', 'hi'
])

/** Match the canonical language keys returned by the old whichlang command. */
export function detectLanguage(text: string): string {
  const value = text.trim()
  if (!value) return 'en'
  try {
    const language = detect(value)
    if (language === 'zh') return 'zh_cn'
    if (language === 'pt') return 'pt_pt'
    return SUPPORTED.has(language) ? language : 'en'
  } catch {
    return 'en'
  }
}
