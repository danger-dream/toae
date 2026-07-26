import type { TranslatorId } from './translator'

type LanguageMap = Readonly<Record<string, string>>

const GOOGLE: LanguageMap = {
  auto: 'auto', zh_cn: 'zh-CN', zh_tw: 'zh-TW', ja: 'ja', en: 'en', ko: 'ko', fr: 'fr', es: 'es', ru: 'ru', de: 'de',
  it: 'it', tr: 'tr', pt_pt: 'pt', pt_br: 'pt', vi: 'vi', id: 'id', th: 'th', ms: 'ms', ar: 'ar', hi: 'hi', mn_cy: 'mn',
  km: 'km', nb_no: 'no', nn_no: 'no', fa: 'fa', sv: 'sv', pl: 'pl', nl: 'nl'
}

const LLM: LanguageMap = {
  auto: 'Auto', zh_cn: 'Simplified Chinese', zh_tw: 'Traditional Chinese', yue: 'Cantonese', ja: 'Japanese', en: 'English',
  ko: 'Korean', fr: 'French', es: 'Spanish', ru: 'Russian', de: 'German', it: 'Italian', tr: 'Turkish', pt_pt: 'Portuguese',
  pt_br: 'Brazilian Portuguese', vi: 'Vietnamese', id: 'Indonesian', th: 'Thai', ms: 'Malay', ar: 'Arabic', hi: 'Hindi',
  mn_mo: 'Mongolian', mn_cy: 'Mongolian(Cyrillic)', km: 'Khmer', nb_no: 'Norwegian Bokmål', nn_no: 'Norwegian Nynorsk',
  fa: 'Persian', sv: 'Swedish', pl: 'Polish', nl: 'Dutch'
}

const MAPS: Record<TranslatorId, LanguageMap> = {
  youdao: {
    auto: 'auto', zh_cn: 'zh-CHS', zh_tw: 'zh-CHT', yue: 'yue', en: 'en', ja: 'jp', ko: 'kor', fr: 'fra', es: 'spa',
    ru: 'ru', de: 'de', it: 'it', tr: 'tr', pt_pt: 'pt', pt_br: 'pt', vi: 'vie', id: 'id', th: 'th', ms: 'may', ar: 'ar',
    hi: 'hi', mn_mo: 'mn', km: 'km', nb_no: 'no', nn_no: 'no', fa: 'fa', sv: 'sv', pl: 'pl', nl: 'nl'
  },
  baidu: {
    auto: 'auto', zh_cn: 'zh', zh_tw: 'cht', yue: 'yue', en: 'en', ja: 'jp', ko: 'kor', fr: 'fra', es: 'spa', ru: 'ru',
    de: 'de', it: 'it', tr: 'tr', pt_pt: 'pt', pt_br: 'pot', vi: 'vie', id: 'id', th: 'th', ms: 'may', ar: 'ar', hi: 'hi',
    km: 'hkm', nb_no: 'nob', nn_no: 'nno', fa: 'per', sv: 'swe', pl: 'pl', nl: 'nl'
  },
  tencent: {
    auto: 'auto', zh_cn: 'zh', zh_tw: 'zh-TW', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', es: 'es', ru: 'ru', de: 'de',
    it: 'it', tr: 'tr', pt_pt: 'pt', pt_br: 'pt', vi: 'vi', id: 'id', th: 'th', ms: 'ms', ar: 'ar', hi: 'hi'
  },
  google: GOOGLE,
  'google-free': GOOGLE,
  bing: {
    auto: '', zh_cn: 'zh-Hans', zh_tw: 'zh-Hant', yue: 'yue', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', es: 'es', ru: 'ru',
    de: 'de', it: 'it', tr: 'tr', pt_pt: 'pt-pt', pt_br: 'pt', vi: 'vi', id: 'id', th: 'th', ms: 'ms', ar: 'ar', hi: 'hi',
    mn_cy: 'mn-Cyrl', mn_mo: 'mn-Mong', km: 'km', nb_no: 'nb', fa: 'fa', sv: 'sv', pl: 'pl', nl: 'nl'
  },
  openai: LLM,
  'gemini-pro': LLM,
  deepl: {
    auto: 'auto', zh_cn: 'ZH', zh_tw: 'ZH', ja: 'JA', en: 'EN', ko: 'KO', fr: 'FR', es: 'ES', ru: 'RU', de: 'DE',
    it: 'IT', tr: 'TR', pt_pt: 'PT-PT', pt_br: 'PT-BR', id: 'ID', sv: 'SV', pl: 'PL', nl: 'NL'
  },
  caiyun: { auto: 'auto', zh_cn: 'zh', zh_tw: 'zh', en: 'en', ja: 'ja' },
  'alibaba-free': {
    auto: 'auto', zh_cn: 'zh', zh_tw: 'zh-tw', yue: 'yue', ja: 'ja', en: 'en', ko: 'ko', fr: 'fr', es: 'es', ru: 'ru',
    de: 'de', it: 'it', tr: 'tr', pt_pt: 'pt', pt_br: 'pt', vi: 'vi', id: 'id', th: 'th', ms: 'ms', ar: 'ar', hi: 'hi',
    mn_mo: 'mn', km: 'km', nb_no: 'no', nn_no: 'no', fa: 'fa', sv: 'sv', pl: 'pl', nl: 'nl'
  }
}

export function providerLanguageCode(providerId: TranslatorId, canonicalLanguage: string): string {
  const value = MAPS[providerId][canonicalLanguage]
  if (value === undefined) throw new Error(`所选文本翻译服务不支持语种：${canonicalLanguage}`)
  return value
}
