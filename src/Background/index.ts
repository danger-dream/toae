import type { AppConfigurationData, ConfigSnapshot, WindowLabel } from '../contracts'
import { invokeMenuCallback } from './menuCallback'
import {
  handlerLoggerMsg,
  type ILogger,
  type IMenuItem,
  type IMenuOptions,
  type IRequestOptions,
  type IResponse,
  ResponseType,
  type UnlistenFn
} from './BaseBackground'

export type { IMenuItem, IMenuOptions, IRequestOptions, IResponse, UnlistenFn }
export { ResponseType }

type EventHandler<T = unknown> = (payload: T, windowLabel: string) => void
const eventHandlers = new Map<string, Set<EventHandler>>()
let initialized = false
let snapshot: ConfigSnapshot | undefined
let bridgeUnlisteners: UnlistenFn[] = []

function dispatch<T>(name: string, payload: T, sourceLabel: string): void {
  for (const handler of eventHandlers.get(name) ?? []) {
    try { handler(payload, sourceLabel) } catch (error) { console.error(error) }
  }
}

function same(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(left) === JSON.stringify(right) } catch { return left === right }
}

export async function initBackground(): Promise<void> {
  if (initialized) return
  if (!window.toae) throw new Error('Electron preload bridge is unavailable')
  snapshot = await window.toae.config.get()

  bridgeUnlisteners.push(window.toae.config.onChanged((next, sourceLabel) => {
    const previous = snapshot?.config
    snapshot = next
    if (!previous) return
    for (const key of Object.keys(next.config) as Array<keyof AppConfigurationData>) {
      if (!same(previous[key], next.config[key])) {
        dispatch('config://updated', { key, value: next.config[key] }, sourceLabel)
      }
    }
  }))

  if (window.toae.ahk) {
    bridgeUnlisteners.push(window.toae.ahk.onLog(line => dispatch('ahk://event', line, 'setting')))
  }
  if (window.toae.translator) {
    bridgeUnlisteners.push(window.toae.translator.onPayload(payload => {
      dispatch('translator://payload', payload, 'translator')
    }))
    bridgeUnlisteners.push(window.toae.translator.onFocus(clear => {
      dispatch(clear ? 'translator://focus' : 'translator://focus/no-clear', '', 'translator')
    }))
  }

  window.addEventListener('unload', () => {
    for (const unlisten of bridgeUnlisteners.splice(0)) unlisten()
  }, { once: true })
  initialized = true
}

export function getLabel(): WindowLabel { return window.toae.label }
export function scaleFactor(): number { return window.devicePixelRatio || 1 }

export function Logger(): ILogger {
  const write = (level: 'error' | 'warn' | 'info' | 'debug', message: string, args: unknown[]) => {
    window.toae.log(level, handlerLoggerMsg(message, args))
  }
  return {
    error: (message, ...args) => write('error', message, args),
    warn: (message, ...args) => write('warn', message, args),
    info: (message, ...args) => write('info', message, args),
    debug: (message, ...args) => write('debug', message, args)
  }
}

export async function listen<T>(name: string, handler: EventHandler<T>): Promise<UnlistenFn> {
  let handlers = eventHandlers.get(name)
  if (!handlers) {
    handlers = new Set()
    eventHandlers.set(name, handlers)
  }
  handlers.add(handler as EventHandler)
  return () => {
    handlers!.delete(handler as EventHandler)
    if (handlers!.size === 0) eventHandlers.delete(name)
  }
}

export async function once<T>(name: string, handler: EventHandler<T>): Promise<UnlistenFn> {
  let unlisten: UnlistenFn = () => undefined
  unlisten = await listen<T>(name, (payload, sourceLabel) => {
    unlisten()
    handler(payload, sourceLabel)
  })
  return unlisten
}

/** Renderer-local events only; cross-process events have dedicated bridge APIs. */
export function emit(name: string, payload?: unknown): void {
  dispatch(name, payload, getLabel())
}

export function hideWindow(): Promise<void> { return window.toae.window.hide() }
export function closeWindow(): Promise<void> { return window.toae.window.close() }
export function showWindow(): Promise<void> { return window.toae.window.show() }
export function getPosition(): Promise<{ x: number; y: number }> { return window.toae.window.getPosition() }
export function setPosition(x: number, y: number): Promise<void> { return window.toae.window.setPosition({ x, y }) }
export function getSize(): Promise<{ width: number; height: number }> { return window.toae.window.getSize() }
export function setSize(width: number, height: number): Promise<void> {
  return getLabel() === 'translator'
    ? window.toae.window.setTranslatorContentHeight(height)
    : window.toae.window.setSize({ width, height })
}
export function isFocused(): Promise<boolean> { return window.toae.window.isFocused() }
export function setFocus(): Promise<void> { return window.toae.window.focus() }
export function isVisible(): Promise<boolean> { return window.toae.window.isVisible() }
export function setAlwaysOnTop(value: boolean): Promise<void> { return window.toae.window.setAlwaysOnTop(value) }
export function setTitle(title: string): Promise<void> { return window.toae.window.setTitle(title) }
export function setFullscreen(value: boolean): Promise<void> { return window.toae.window.setFullscreen(value) }

export function messageBox(message: string, options?: { title?: string; type?: 'info' | 'error' }): Promise<void> {
  return window.toae.dialog.message({ message, ...options })
}
export function ask(message: string, options?: { title?: string; type?: 'info' | 'warning' | 'error'; okLabel?: string; cancelLabel?: string }): Promise<boolean> {
  return window.toae.dialog.confirm({ message, ...options })
}
export function readClipboardText(): Promise<string> { return window.toae.clipboard.readText() }
export function writeClipboardText(content: string): Promise<boolean> { return window.toae.clipboard.writeText(content) }
export function isRegisteredGlobalShortcut(shortcut: string): Promise<boolean> { return window.toae.shortcut.isRegistered(shortcut) }
export function shellOpen(path: string): Promise<void> { return window.toae.external.open(path) }

export async function showMenu(options?: IMenuOptions, callback?: (payload?: unknown) => void): Promise<unknown> {
  if (!options) return undefined
  try {
    const payload = await window.toae.menu.show(options)
    invokeMenuCallback(payload, callback)
    return payload
  } finally {
    dispatch('menu-did-close', undefined, getLabel())
  }
}

export function isAutostart(): Promise<boolean> {
  return window.toae.startup.get().then(status => status.enabled)
}
export async function setAutostart(enable: boolean): Promise<void> {
  await window.toae.startup.set(enable)
}

/**
 * Compatibility facade for the unchanged Vue components. Every accepted name
 * maps to one fixed business method; no arbitrary IPC channel is exposed.
 */
export async function invoke<T>(command: string, args: Record<string, any> = {}): Promise<T> {
  switch (command) {
    case 'get_config': {
      snapshot = await window.toae.config.get()
      return structuredClone(snapshot.config) as T
    }
    case 'set_config_by_key': {
      const key = String(args.key) as keyof AppConfigurationData
      if (!snapshot) snapshot = await window.toae.config.get()
      try {
        snapshot = await window.toae.config.patch({ expectedRevision: snapshot.revision, patch: { [key]: args.value } })
      } catch {
        snapshot = await window.toae.config.get()
        snapshot = await window.toae.config.patch({ expectedRevision: snapshot.revision, patch: { [key]: args.value } })
      }
      const canonicalValue = snapshot.config[key]
      if (!same(args.value, canonicalValue)) {
        // Feed generated service IDs, masked credentials and other canonical
        // normalization back into the initiating renderer as well.
        dispatch('config://updated', { key, value: structuredClone(canonicalValue) }, 'electron-main')
      }
      return true as T
    }
    case 'show_setting_window':
      await window.toae.app.showSetting(); return undefined as T
    case 'show_trans_win':
      await window.toae.app.showTranslator(Boolean(args.focus)); return undefined as T
    case 'active_window_is_self':
      return await window.toae.app.activeWindowIsSelf() as T
    case 'lang_detect':
      return await window.toae.app.detectLanguage(String(args.text ?? '')) as T
    case 'read_script': {
      if (!window.toae.ahk) throw new Error('AutoHotkey is unavailable in this window')
      return await window.toae.ahk.readScript() as T
    }
    case 'write_script': {
      if (!window.toae.ahk) throw new Error('AutoHotkey is unavailable in this window')
      const status = await window.toae.ahk.saveAndReload(String(args.script ?? ''))
      return (status.state !== 'error') as T
    }
    case 'start_autohotkey': {
      if (!window.toae.ahk) throw new Error('AutoHotkey is unavailable in this window')
      const status = await window.toae.ahk.start()
      return status.running as T
    }
    case 'kill_autohotkey': {
      if (!window.toae.ahk) throw new Error('AutoHotkey is unavailable in this window')
      await window.toae.ahk.stop(); return undefined as T
    }
    case 'is_autohotkey_running': {
      if (!window.toae.ahk) return false as T
      return (await window.toae.ahk.status()).running as T
    }
    default:
      throw new Error(`Unsupported renderer command: ${command}`)
  }
}

/**
 * Legacy provider modules remain as UI metadata, but their request functions
 * are replaced by Main-backed wrappers in the provider indexes. Calling this
 * guard indicates a programming error and never falls back to renderer fetch.
 */
export async function fetch<T>(_url: string, _options?: IRequestOptions): Promise<IResponse<T>> {
  throw new Error('Provider network requests must be routed through Electron Main')
}
