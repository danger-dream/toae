import {
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from 'electron'
import type { AppConfigurationData, ProviderDraftTestRequest, WindowLabel } from '../../../src/contracts'
import { IPC } from '../../shared/channels'
import type { CaptureService } from '../capture/service'
import type { ConfigService } from '../config/service'
import { ServiceConfigSchema } from '../config/schema'
import type { NativeService } from '../helper/service'
import type { AppLogger } from '../logging/logger'
import type { ProviderService } from '../providers/service'
import type { LoginItemService } from '../startup/login-item'
import type { WindowManager } from '../windows/manager'

const EXTERNAL_HOSTS = new Set([
  'api.fanyi.baidu.com', 'cloud.baidu.com', 'cloud.google.com', 'cloud.tencent.com',
  'www.tencentcloud.com', 'open.caiyunapp.com', 'ai.youdao.com', 'goessner.net', 'jsonpath.com'
])

type ConfigChangedHandler = (
  previous: Readonly<AppConfigurationData>,
  next: Readonly<AppConfigurationData>,
  changedKeys: Array<keyof AppConfigurationData>,
  sourceLabel: WindowLabel
) => Promise<void> | void

export function registerIpcHandlers(input: {
  windows: WindowManager
  config: ConfigService
  providers: ProviderService
  capture: CaptureService
  native: NativeService
  startup: LoginItemService
  logger: AppLogger
  detectLanguage(text: string): string
  onConfigChanged: ConfigChangedHandler
}): () => void {
  const channels: string[] = []
  const handle = (
    channel: string,
    allowed: readonly WindowLabel[],
    handler: (event: IpcMainInvokeEvent, label: WindowLabel, value: any) => unknown | Promise<unknown>
  ) => {
    channels.push(channel)
    ipcMain.handle(channel, async (event, value) => {
      const label = validateSender(event, input.windows, allowed)
      return handler(event, label, value)
    })
  }

  handle(IPC.configGet, ['translator', 'setting', 'screen-capture'], () => input.config.snapshot(false))
  handle(IPC.configPatch, ['translator', 'setting'], async (_event, label, value) => {
    const record = object(value)
    const expectedRevision = integer(record.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision')
    const patch = object(record.patch) as Partial<AppConfigurationData>
    if (expectedRevision !== input.config.snapshot(false).revision) {
      // Let ConfigService return its canonical revision-conflict error without side effects.
      return input.config.patch(expectedRevision, patch)
    }
    const keys = Object.keys(patch) as Array<keyof AppConfigurationData>
    if (label === 'translator' && (keys.length !== 1 || keys[0] !== 'pinup')) throw new Error('translator may only update pinup')
    const previous = structuredClone(input.config.value())
    const ahkToggle = keys.includes('enable_ahk') && typeof patch.enable_ahk === 'boolean' && patch.enable_ahk !== previous.enable_ahk
    if (ahkToggle) await input.native.applyEnabled(Boolean(patch.enable_ahk))
    let snapshot
    try {
      snapshot = await input.config.patch(expectedRevision, patch)
    } catch (error) {
      if (ahkToggle) await input.native.applyEnabled(previous.enable_ahk).catch(() => undefined)
      throw error
    }
    const next = input.config.value()
    const changedKeys = keys.filter(key => !same(previous[key], next[key]))
    input.windows.broadcastConfig(snapshot, label)
    await input.onConfigChanged(previous, next, changedKeys, label)
    return snapshot
  })

  handle(IPC.appShowSetting, ['translator'], () => input.windows.showSetting())
  handle(IPC.appShowTranslator, ['translator'], (_event, _label, value) => input.windows.showTranslator(Boolean(object(value).focus), input.config.value()))
  handle(IPC.translatorReady, ['translator'], event => { input.windows.markTranslatorReady(event.sender.id) })
  handle(IPC.appActiveWindowIsSelf, ['translator'], () => input.windows.activeWindowIsSelf())
  handle(IPC.appDetectLanguage, ['translator'], (_event, _label, value) => {
    const text = boundedString(object(value).text, 100_000, 'text')
    return input.detectLanguage(text)
  })

  const ownWindow = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || !input.windows.owns(window)) throw new Error('sender window is unavailable')
    return window
  }
  handle(IPC.windowHide, ['translator', 'setting', 'screen-capture'], event => { ownWindow(event).hide() })
  handle(IPC.windowClose, ['translator', 'setting', 'screen-capture'], event => { ownWindow(event).close() })
  handle(IPC.windowShow, ['translator', 'setting', 'screen-capture'], event => { ownWindow(event).show() })
  handle(IPC.windowFocus, ['translator', 'setting', 'screen-capture'], event => { ownWindow(event).focus() })
  handle(IPC.windowIsFocused, ['translator', 'setting', 'screen-capture'], event => ownWindow(event).isFocused())
  handle(IPC.windowIsVisible, ['translator', 'setting', 'screen-capture'], event => ownWindow(event).isVisible())
  handle(IPC.windowGetPosition, ['translator', 'setting', 'screen-capture'], event => {
    const [x, y] = ownWindow(event).getPosition(); return { x, y }
  })
  handle(IPC.windowSetPosition, ['translator', 'setting'], (event, _label, value) => {
    const record = object(value)
    ownWindow(event).setPosition(integer(record.x, -1_000_000, 1_000_000, 'x'), integer(record.y, -1_000_000, 1_000_000, 'y'))
  })
  handle(IPC.windowGetSize, ['translator', 'setting', 'screen-capture'], event => {
    const [width, height] = ownWindow(event).getSize(); return { width, height }
  })
  handle(IPC.windowSetSize, ['setting'], (event, _label, value) => {
    const record = object(value)
    ownWindow(event).setSize(integer(record.width, 300, 4000, 'width'), integer(record.height, 300, 4000, 'height'))
  })
  handle(IPC.windowAlwaysOnTop, ['translator', 'screen-capture'], (event, _label, value) => {
    ownWindow(event).setAlwaysOnTop(boolean(object(value).value, 'value'))
  })
  handle(IPC.windowSetTitle, ['setting'], (event, _label, value) => {
    ownWindow(event).setTitle(boundedString(object(value).title, 200, 'title'))
  })
  handle(IPC.windowSetFullscreen, ['screen-capture'], (event, _label, value) => {
    ownWindow(event).setFullScreen(boolean(object(value).value, 'value'))
  })
  handle(IPC.windowTranslatorHeight, ['translator'], (_event, _label, value) => {
    const height = finiteNumber(object(value).heightDip, 1, 100_000, 'heightDip')
    return input.windows.setTranslatorContentHeight(height)
  })

  handle(IPC.clipboardReadText, ['translator', 'setting', 'screen-capture'], () => clipboard.readText().slice(0, 1_000_000))
  handle(IPC.clipboardWriteText, ['translator', 'setting', 'screen-capture'], (_event, _label, value) => {
    clipboard.writeText(boundedString(object(value).text, 1_000_000, 'text')); return true
  })

  handle(IPC.dialogMessage, ['translator', 'setting'], async (event, _label, value) => {
    const record = object(value)
    await dialog.showMessageBox(ownWindow(event), {
      type: record.type === 'error' ? 'error' : 'info',
      title: optionalString(record.title, 200),
      message: boundedString(record.message, 10_000, 'message')
    })
  })
  handle(IPC.dialogConfirm, ['translator', 'setting'], async (event, _label, value) => {
    const record = object(value)
    const result = await dialog.showMessageBox(ownWindow(event), {
      type: record.type === 'error' || record.type === 'warning' ? record.type : 'info',
      title: optionalString(record.title, 200),
      message: boundedString(record.message, 10_000, 'message'),
      buttons: [optionalString(record.okLabel, 64) || '确定', optionalString(record.cancelLabel, 64) || '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    return result.response === 0
  })

  handle(IPC.menuShow, ['translator', 'setting'], (event, _label, value) => {
    const record = object(value)
    const position = object(record.position)
    const x = Math.round(finiteNumber(position.x, -100_000, 100_000, 'menu x'))
    const y = Math.round(finiteNumber(position.y, -100_000, 100_000, 'menu y'))
    const items = Array.isArray(record.items) ? record.items : []
    if (items.length < 1 || items.length > 256) throw new Error('menu item count is invalid')
    const owner = ownWindow(event)
    return new Promise((resolvePromise, rejectPromise) => {
      let selected = false
      const template: MenuItemConstructorOptions[] = items.map(raw => {
        const item = object(raw)
        const payload = cloneMenuPayload(item.payload)
        const checked = item.checked
        return {
          label: boundedString(item.label, 200, 'menu label'),
          type: typeof checked === 'boolean' ? 'checkbox' : 'normal',
          checked: typeof checked === 'boolean' ? checked : undefined,
          click: () => { selected = true; resolvePromise(payload) }
        }
      })
      const endNativeMenu = input.windows.beginNativeMenu(owner)
      try {
        Menu.buildFromTemplate(template).popup({
          window: owner,
          x,
          y,
          callback: () => {
            endNativeMenu()
            if (!selected) resolvePromise(undefined)
          }
        })
      } catch (error) {
        endNativeMenu()
        rejectPromise(error)
      }
    })
  })

  handle(IPC.externalOpen, ['setting'], async (_event, _label, value) => {
    const raw = boundedString(object(value).url, 2048, 'url')
    const url = new URL(raw)
    if (url.protocol !== 'https:' || !EXTERNAL_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password) {
      throw new Error('external URL is not allowed')
    }
    await shell.openExternal(url.toString())
  })
  handle(IPC.shortcutIsRegistered, ['setting'], (_event, _label, value) => {
    const accelerator = boundedString(object(value).accelerator, 128, 'accelerator')
    return globalShortcut.isRegistered(accelerator)
  })
  handle(IPC.startupGet, ['setting'], () => input.startup.get())
  handle(IPC.startupSet, ['setting'], (_event, _label, value) => input.startup.set(boolean(object(value).enabled, 'enabled')))

  handle(IPC.providerCall, ['translator', 'setting'], (_event, label, value) => input.providers.call(value, label as 'translator' | 'setting'))
  handle(IPC.providerCancel, ['translator', 'setting'], (_event, _label, value) => {
    const requestId = boundedString(object(value).requestId, 128, 'requestId')
    input.providers.cancel(requestId)
  })
  handle(IPC.providerTestDraft, ['setting'], (_event, _label, value) => {
    const request = value as ProviderDraftTestRequest
    if (!request || (request.kind !== 'translate' && request.kind !== 'ocr')) throw new Error('provider draft kind is invalid')
    const serialized = JSON.stringify(request)
    if (serialized.length > 4_500_000) throw new Error('provider draft exceeds size limit')
    const service = ServiceConfigSchema.parse(request.service)
    if (!['detect', 'translate', 'dict', 'ocr'].includes(request.capability)) throw new Error('provider draft capability is invalid')
    const imageBytes = request.kind === 'ocr' ? decodeSmallBase64(request.imageBase64) : undefined
    return input.providers.testDraft({
      kind: request.kind,
      service,
      capability: request.capability,
      imageBytes,
      text: optionalString(request.text, 100_000),
      from: optionalString(request.from, 64),
      to: optionalString(request.to, 64)
    })
  })
  handle(IPC.providerAudio, ['translator'], async (_event, _label, value) => {
    const token = boundedString(object(value).token, 64, 'audio token')
    return input.providers.fetchAudio(token)
  })

  handle(IPC.captureConfirm, ['screen-capture'], (_event, _label, value) => {
    const record = object(value)
    const roi = object(record.roiDip)
    return input.capture.confirm(boundedString(record.sessionId, 128, 'sessionId'), {
      x: finiteNumber(roi.x, -1, 100_000, 'roi x'),
      y: finiteNumber(roi.y, -1, 100_000, 'roi y'),
      width: finiteNumber(roi.width, 0, 100_000, 'roi width'),
      height: finiteNumber(roi.height, 0, 100_000, 'roi height')
    })
  })
  handle(IPC.captureCancel, ['screen-capture'], (_event, _label, value) => input.capture.cancel(boundedString(object(value).sessionId, 128, 'sessionId')))

  handle(IPC.ahkReadScript, ['setting'], () => input.native.readScript())
  handle(IPC.ahkSaveReload, ['setting'], (_event, _label, value) => input.native.saveAndReload(boundedString(object(value).script, 2 * 1024 * 1024, 'script')))
  handle(IPC.ahkStart, ['setting'], () => input.native.startAhk())
  handle(IPC.ahkStop, ['setting'], () => input.native.stopAhk())
  handle(IPC.ahkStatus, ['setting'], () => input.native.status())

  const logListener = (event: Electron.IpcMainEvent, value: unknown) => {
    try {
      const label = validateSender(event as unknown as IpcMainInvokeEvent, input.windows, ['translator', 'setting', 'screen-capture'])
      const record = object(value)
      const level = ['error', 'warn', 'info', 'debug'].includes(String(record.level)) ? record.level : 'info'
      input.logger.log(level, boundedString(record.message, 4000, 'message'), { renderer: label })
    } catch { /* reject malformed/untrusted renderer logs silently */ }
  }
  ipcMain.on(IPC.rendererLog, logListener)

  input.native.onLog(line => {
    const setting = input.windows.get('setting')
    if (setting && !setting.isDestroyed()) setting.webContents.send(IPC.ahkLog, String(line).slice(0, 2000))
  })

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
    ipcMain.removeListener(IPC.rendererLog, logListener)
  }
}

function validateSender(event: IpcMainInvokeEvent, windows: WindowManager, allowed: readonly WindowLabel[]): WindowLabel {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error('subframe IPC is not allowed')
  const label = windows.labelForWebContentsId(event.sender.id)
  if (!label || !allowed.includes(label)) throw new Error('sender is not allowed for this IPC method')
  const url = event.senderFrame.url
  const devServer = process.env.TOAE_DEV_SERVER_URL
  if (devServer) {
    if (new URL(url).origin !== new URL(devServer).origin) throw new Error('renderer origin is not trusted')
  } else if (!url.startsWith('file:')) {
    throw new Error('packaged renderer origin is not trusted')
  }
  return label
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('IPC input must be an object')
  return value as Record<string, any>
}
function boundedString(value: unknown, max: number, name: string): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${name} is invalid`)
  return value
}
function optionalString(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return boundedString(value, max, 'string')
}
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} is invalid`)
  return value
}
function finiteNumber(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} is invalid`)
  return value
}
function integer(value: unknown, min: number, max: number, name: string): number {
  const number = finiteNumber(value, min, max, name)
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer`)
  return number
}
function same(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(left) === JSON.stringify(right) } catch { return left === right }
}
function cloneMenuPayload(value: unknown): unknown {
  const serialized = JSON.stringify(value)
  if (serialized !== undefined && serialized.length > 16_384) throw new Error('menu payload exceeds size limit')
  return structuredClone(value)
}
function decodeSmallBase64(value: unknown): Uint8Array {
  const text = boundedString(value, 4 * 1024 * 1024, 'imageBase64')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) throw new Error('OCR test image is not valid base64')
  const bytes = Buffer.from(text, 'base64')
  if (bytes.byteLength === 0 || bytes.byteLength > 2 * 1024 * 1024) throw new Error('OCR test image exceeds size limit')
  return new Uint8Array(bytes)
}
