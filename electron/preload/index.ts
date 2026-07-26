import { contextBridge, ipcRenderer } from 'electron'
import type {
  CaptureFramePayload,
  ConfigSnapshot,
  ProviderCallRequest,
  ProviderDraftTestRequest,
  ToaeBridge,
  WindowLabel
} from '../../src/contracts'
import { IPC } from '../shared/channels'

function readWindowLabel(): WindowLabel {
  const argument = process.argv.find(value => value.startsWith('--toae-window='))
  const label = argument?.slice('--toae-window='.length)
  if (label === 'translator' || label === 'setting' || label === 'screen-capture') return label
  throw new Error('preload did not receive a valid window identity')
}

const label = readWindowLabel()
const invoke = <T>(channel: string, input?: unknown): Promise<T> => ipcRenderer.invoke(channel, input) as Promise<T>

function subscribe(channel: string, callback: (...args: any[]) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: any[]) => callback(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

function toArrayBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice().buffer
  }
  if (value && typeof value === 'object' && Array.isArray((value as any).data)) {
    return Uint8Array.from((value as any).data).buffer
  }
  throw new Error('capture frame did not contain binary data')
}

const bridge: ToaeBridge = {
  label,
  platform: process.platform,
  config: {
    get: () => invoke(IPC.configGet),
    patch: input => invoke(IPC.configPatch, input),
    onChanged: handler => subscribe(IPC.configChanged, (snapshot: ConfigSnapshot, sourceLabel: WindowLabel) => handler(snapshot, sourceLabel))
  },
  app: {
    showSetting: () => invoke(IPC.appShowSetting),
    showTranslator: focus => invoke(IPC.appShowTranslator, { focus }),
    activeWindowIsSelf: () => invoke(IPC.appActiveWindowIsSelf),
    detectLanguage: text => invoke(IPC.appDetectLanguage, { text })
  },
  window: {
    hide: () => invoke(IPC.windowHide),
    close: () => invoke(IPC.windowClose),
    show: () => invoke(IPC.windowShow),
    focus: () => invoke(IPC.windowFocus),
    isFocused: () => invoke(IPC.windowIsFocused),
    isVisible: () => invoke(IPC.windowIsVisible),
    getPosition: () => invoke(IPC.windowGetPosition),
    setPosition: position => invoke(IPC.windowSetPosition, position),
    getSize: () => invoke(IPC.windowGetSize),
    setSize: size => invoke(IPC.windowSetSize, size),
    setAlwaysOnTop: value => invoke(IPC.windowAlwaysOnTop, { value }),
    setTitle: title => invoke(IPC.windowSetTitle, { title }),
    setFullscreen: value => invoke(IPC.windowSetFullscreen, { value }),
    setTranslatorContentHeight: heightDip => invoke(IPC.windowTranslatorHeight, { heightDip })
  },
  clipboard: {
    readText: () => invoke(IPC.clipboardReadText),
    writeText: text => invoke(IPC.clipboardWriteText, { text })
  },
  dialog: {
    message: input => invoke(IPC.dialogMessage, input),
    confirm: input => invoke(IPC.dialogConfirm, input)
  },
  menu: {
    show: options => invoke(IPC.menuShow, options)
  },
  external: {
    open: url => invoke(IPC.externalOpen, { url })
  },
  shortcut: {
    isRegistered: accelerator => invoke(IPC.shortcutIsRegistered, { accelerator })
  },
  startup: {
    get: () => invoke(IPC.startupGet),
    set: enabled => invoke(IPC.startupSet, { enabled })
  },
  log: (level, message) => ipcRenderer.send(IPC.rendererLog, { level, message })
}

if (label === 'translator' || label === 'setting') {
  bridge.provider = {
    call: (request: ProviderCallRequest) => invoke(IPC.providerCall, request),
    cancel: requestId => invoke(IPC.providerCancel, { requestId }),
    testDraft: (request: ProviderDraftTestRequest) => invoke(IPC.providerTestDraft, request),
    fetchAudio: async token => {
      const result = await invoke<{ bytes: unknown; mime: string }>(IPC.providerAudio, { token })
      return { bytes: toArrayBuffer(result.bytes), mime: String(result.mime) }
    }
  }
}

if (label === 'screen-capture') {
  bridge.capture = {
    onFrame: handler => subscribe(IPC.captureFrame, (payload: CaptureFramePayload) => {
      handler({ meta: payload.meta, bytes: toArrayBuffer(payload.bytes) })
    }),
    onError: handler => subscribe(IPC.captureError, (message: string) => handler(String(message))),
    confirm: input => invoke(IPC.captureConfirm, input),
    cancel: sessionId => invoke(IPC.captureCancel, { sessionId })
  }
}

if (label === 'setting') {
  bridge.ahk = {
    readScript: () => invoke(IPC.ahkReadScript),
    saveAndReload: script => invoke(IPC.ahkSaveReload, { script }),
    start: () => invoke(IPC.ahkStart),
    stop: () => invoke(IPC.ahkStop),
    status: () => invoke(IPC.ahkStatus),
    onLog: handler => subscribe(IPC.ahkLog, (line: string) => handler(String(line)))
  }
}

if (label === 'translator') {
  bridge.translator = {
    onPayload: handler => subscribe(IPC.translatorPayload, handler),
    onFocus: handler => subscribe(IPC.translatorFocus, handler)
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  }
  return value
}

contextBridge.exposeInMainWorld('toae', deepFreeze(bridge))
