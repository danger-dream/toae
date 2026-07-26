import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AppConfigurationData } from '../../../src/contracts'

const JsonPrimitive = z.union([z.string(), z.number(), z.boolean(), z.null()])
type JsonValue = z.infer<typeof JsonPrimitive> | JsonValue[] | { [key: string]: JsonValue }
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitive, z.array(JsonValueSchema), z.record(JsonValueSchema)])
)

export const ServiceConfigSchema = z.object({
  id: z.string().trim().min(1).max(128).optional(),
  name: z.string().trim().min(1).max(64),
  label: z.string().max(128).optional(),
  enable: z.boolean().optional(),
  params: z.record(JsonValueSchema).optional(),
  timeout: z.number().int().min(0).max(180_000).optional(),
  retry: z.number().int().min(0).max(10).optional(),
  detectVerify: z.boolean().optional(),
  transVerify: z.boolean().optional(),
  dictVerify: z.boolean().optional(),
  ocrVerify: z.boolean().optional()
}).strict()

export const ConfigSchema = z.object({
  pinup: z.boolean(),
  show_translator: z.string().max(128),
  screenshot_translate: z.string().max(128),
  selection_translate: z.string().max(128),
  screenshot_recognizer: z.string().max(128),
  image_translate_enabled: z.boolean(),
  image_translate_ocr_service: z.string().max(128),
  image_translate_trans_service: z.string().max(128),
  ocr_type: z.enum(['round', 'concurrent', 'first']),
  ocr_succed_show_win: z.boolean(),
  ocr_err_tip: z.boolean(),
  detect_type: z.string().max(128),
  to: z.string().max(32),
  to2: z.string().max(32),
  only_dict: z.boolean(),
  auto_clear: z.boolean(),
  auto_copy: z.boolean(),
  copy_type: z.string().max(128),
  trans_timeout: z.number().int().min(0).max(180_000),
  trans_retry_count: z.number().int().min(0).max(10),
  ocr_timeout: z.number().int().min(0).max(180_000),
  ocr_retry_count: z.number().int().min(0).max(10),
  win_position: z.enum(['right-top', 'center', 'last', 'mouse']),
  enable_cache: z.boolean(),
  cache_day: z.number().int().min(0).max(36500),
  cache_max_count: z.number().int().min(0).max(1_000_000),
  use_cache: z.boolean(),
  reserve_word: z.boolean(),
  enable_ahk: z.boolean(),
  trans_services: z.array(ServiceConfigSchema).max(128),
  ocr_services: z.array(ServiceConfigSchema).max(64)
}).strict()

export const DEFAULT_CONFIG: AppConfigurationData = Object.freeze({
  pinup: false,
  show_translator: '',
  screenshot_translate: '',
  selection_translate: '',
  screenshot_recognizer: '',
  image_translate_enabled: false,
  image_translate_ocr_service: '',
  image_translate_trans_service: '',
  ocr_type: 'round',
  ocr_succed_show_win: false,
  ocr_err_tip: true,
  detect_type: 'concurrent',
  to: 'zh_cn',
  to2: 'en',
  only_dict: false,
  auto_clear: false,
  auto_copy: false,
  copy_type: '',
  trans_timeout: 5000,
  trans_retry_count: 1,
  ocr_timeout: 5000,
  ocr_retry_count: 1,
  win_position: 'right-top',
  enable_cache: true,
  cache_day: 0,
  cache_max_count: 0,
  use_cache: true,
  reserve_word: false,
  enable_ahk: false,
  trans_services: [],
  ocr_services: []
})

export const REMOVED_SELECTION_ASSISTANT_FIELDS = new Set([
  'enable_selection_assistant',
  'pickword_type',
  'assistant_hide_timer',
  'assistants',
  'enable_rule',
  'assistant_rules'
])

export function normalizeConfig(input: unknown): AppConfigurationData {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}
  const merged = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>
  for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof AppConfigurationData>) {
    if (source[key] !== undefined) merged[key] = source[key]
  }
  // The old UI exposed "random" but the implementation never honored it. Keep
  // deterministic semantics rather than silently selecting a random provider.
  if (merged.ocr_type === 'random') merged.ocr_type = 'round'
  const parsed = ConfigSchema.parse(merged) as AppConfigurationData
  ensureStableServiceIds(parsed.trans_services, 'trans')
  ensureStableServiceIds(parsed.ocr_services, 'ocr')
  return ConfigSchema.parse(parsed) as AppConfigurationData
}

function ensureStableServiceIds(services: AppConfigurationData['trans_services'], kind: string): void {
  const seen = new Set<string>()
  services.forEach((service, index) => {
    let id = service.id?.trim()
    if (!id || seen.has(id)) {
      const digest = createHash('sha256')
        .update(JSON.stringify({ kind, index, name: service.name, params: service.params ?? {} }))
        .digest('hex')
        .slice(0, 16)
      id = `legacy-${kind}-${service.name}-${digest}`.slice(0, 128)
    }
    while (seen.has(id)) id = `${id.slice(0, 118)}-${index}`
    service.id = id
    seen.add(id)
  })
}

const SECRET_KEY = /(?:secret|token|api.?key|auth(?:orization)?|password|client_secret|key)$/i

export function redactConfigForRenderer(config: AppConfigurationData): AppConfigurationData {
  const copy = structuredClone(config)
  const redact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redact)
    if (!value || typeof value !== 'object') return value
    const target: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      target[key] = SECRET_KEY.test(key) && typeof nested === 'string' && nested.length > 0
        ? '••••••••'
        : redact(nested)
    }
    return target
  }
  return redact(copy) as AppConfigurationData
}

export function isMaskedSecret(value: unknown): boolean {
  return value === '••••••••'
}
