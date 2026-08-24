export const ACTIONS = [
  'show_translator',
  'screenshot_translate',
  'selection_translate',
  'screenshot_recognizer'
] as const

export type ActionName = (typeof ACTIONS)[number]
export type WindowLabel = 'translator' | 'setting' | 'screen-capture'
export type ProviderCapability = 'detect' | 'translate' | 'dict' | 'ocr'

export interface ServiceConfigData {
  id?: string
  name: string
  label?: string
  enable?: boolean
  params?: Record<string, unknown>
  timeout?: number
  retry?: number
  detectVerify?: boolean
  transVerify?: boolean
  dictVerify?: boolean
  ocrVerify?: boolean
}

export interface AppConfigurationData {
  pinup: boolean
  show_translator: string
  screenshot_translate: string
  selection_translate: string
  screenshot_recognizer: string
  image_translate_enabled: boolean
  image_translate_ocr_service: string
  image_translate_trans_service: string
  ocr_type: 'round' | 'concurrent' | 'first'
  ocr_succed_show_win: boolean
  ocr_err_tip: boolean
  detect_type: string
  to: string
  to2: string
  only_dict: boolean
  auto_clear: boolean
  auto_copy: boolean
  copy_type: string
  trans_timeout: number
  trans_retry_count: number
  ocr_timeout: number
  ocr_retry_count: number
  win_position: 'right-top' | 'center' | 'last' | 'mouse'
  enable_cache: boolean
  cache_day: number
  cache_max_count: number
  use_cache: boolean
  reserve_word: boolean
  enable_ahk: boolean
  trans_services: ServiceConfigData[]
  ocr_services: ServiceConfigData[]
}

export interface ConfigSnapshot {
  schemaVersion: 1
  revision: number
  config: AppConfigurationData
}

export interface ProviderCallRequest {
  requestId: string
  capability: Exclude<ProviderCapability, 'ocr'>
  providerId: string
  serviceId?: string
  /** Only the setting window may send draft parameters for provider verification. */
  params?: Record<string, unknown>
  text?: string
  from?: string
  to?: string
  onlyDict?: boolean
  bypassCache?: boolean
  timeoutMs?: number
  retry?: number
}

export interface ProviderCallResult {
  requestId: string
  providerId: string
  capability: Exclude<ProviderCapability, 'ocr'>
  data: string | Record<string, unknown>
  cached?: boolean
  timingMs: number
}

export interface ProviderDraftTestRequest {
  kind: 'translate' | 'ocr'
  service: ServiceConfigData
  capability: ProviderCapability
  /** Used only by the setting page's small built-in OCR verification fixture. */
  imageBase64?: string
  text?: string
  from?: string
  to?: string
}

export interface CaptureDisplay {
  electronDisplayId: string
  dipBounds: { x: number; y: number; width: number; height: number }
  physicalBounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
}

export interface CaptureFrameMeta {
  sessionId: string
  action: 'screenshot_translate' | 'screenshot_recognizer'
  width: number
  height: number
  mime: 'image/png'
  backend: 'wgc' | 'gdi-fallback'
  display: CaptureDisplay
}

export interface CaptureFramePayload {
  meta: CaptureFrameMeta
  bytes: ArrayBuffer
}

/** ROI is local to the overlay window and expressed in Electron DIP. */
export interface CaptureRoiDip {
  x: number
  y: number
  width: number
  height: number
}

export interface AhkStatus {
  enabled: boolean
  running: boolean
  state: 'unsupported' | 'stopped' | 'starting' | 'running' | 'error'
  message?: string
  helperVersion?: string
  dllSha256?: string
  dllVersion?: string
}

export interface LoginItemStatus {
  supported: boolean
  enabled: boolean
  executableWillLaunchAtLogin: boolean
}

export interface TranslatorPayload {
  requestId: string
  text: string
  translate: boolean
  source: 'selection' | 'screenshot'
}

export interface MenuOptions {
  position: { x: number; y: number }
  items: Array<{ label: string; checked?: boolean; payload?: unknown }>
}

/**
 * Narrow, business-named API exposed by the sandboxed preload. It deliberately
 * contains neither ipcRenderer, arbitrary channels, arbitrary file paths nor a
 * general-purpose network method.
 */
export interface ToaeBridge {
  readonly label: WindowLabel
  readonly platform: string
  config: {
    get(): Promise<ConfigSnapshot>
    patch(input: { expectedRevision: number; patch: Partial<AppConfigurationData> }): Promise<ConfigSnapshot>
    onChanged(handler: (snapshot: ConfigSnapshot, sourceLabel: WindowLabel) => void): () => void
  }
  app: {
    showSetting(): Promise<void>
    showTranslator(focus: boolean): Promise<void>
    activeWindowIsSelf(): Promise<boolean>
    detectLanguage(text: string): Promise<string>
  }
  window: {
    hide(): Promise<void>
    close(): Promise<void>
    show(): Promise<void>
    focus(): Promise<void>
    isFocused(): Promise<boolean>
    isVisible(): Promise<boolean>
    getPosition(): Promise<{ x: number; y: number }>
    setPosition(position: { x: number; y: number }): Promise<void>
    getSize(): Promise<{ width: number; height: number }>
    setSize(size: { width: number; height: number }): Promise<void>
    setAlwaysOnTop(value: boolean): Promise<void>
    setTitle(title: string): Promise<void>
    setFullscreen(value: boolean): Promise<void>
    setTranslatorContentHeight(heightDip: number): Promise<void>
  }
  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<boolean>
  }
  dialog: {
    message(input: { message: string; title?: string; type?: 'info' | 'error' }): Promise<void>
    confirm(input: { message: string; title?: string; type?: 'info' | 'warning' | 'error'; okLabel?: string; cancelLabel?: string }): Promise<boolean>
  }
  menu: {
    show(options: MenuOptions): Promise<unknown>
  }
  external: {
    open(url: string): Promise<void>
  }
  shortcut: {
    isRegistered(accelerator: string): Promise<boolean>
  }
  startup: {
    get(): Promise<LoginItemStatus>
    set(enabled: boolean): Promise<LoginItemStatus>
  }
  provider?: {
    call(request: ProviderCallRequest): Promise<ProviderCallResult>
    cancel(requestId: string): Promise<void>
    testDraft(request: ProviderDraftTestRequest): Promise<unknown>
    fetchAudio(token: string): Promise<{ bytes: ArrayBuffer; mime: string }>
  }
  capture?: {
    onFrame(handler: (frame: CaptureFramePayload) => void): () => void
    onError(handler: (message: string) => void): () => void
    confirm(input: { sessionId: string; roiDip: CaptureRoiDip }): Promise<void>
    cancel(sessionId: string): Promise<void>
  }
  ahk?: {
    readScript(): Promise<string>
    saveAndReload(script: string): Promise<AhkStatus>
    start(): Promise<AhkStatus>
    stop(): Promise<AhkStatus>
    status(): Promise<AhkStatus>
    onLog(handler: (line: string) => void): () => void
  }
  translator?: {
    ready(): Promise<void>
    onPayload(handler: (payload: TranslatorPayload) => void): () => void
    onFocus(handler: (clear: boolean) => void): () => void
  }
  log(level: 'error' | 'warn' | 'info' | 'debug', message: string): void
}

declare global {
  interface Window {
    toae: Readonly<ToaeBridge>
  }
}
