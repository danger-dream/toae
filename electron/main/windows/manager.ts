import { BrowserWindow, screen, shell, type BrowserWindowConstructorOptions, type Rectangle } from 'electron'
import { join, resolve } from 'node:path'
import type {
  AppConfigurationData,
  CaptureFramePayload,
  ConfigSnapshot,
  TranslatorPayload,
  WindowLabel
} from '../../../src/contracts'
import { IPC } from '../../shared/channels'
import type { AppLogger } from '../logging/logger'

const TRANSLATOR_WIDTH = 450
const TRANSLATOR_MIN_HEIGHT = 230
const SETTING_WIDTH = 1024
const SETTING_HEIGHT = 768

export class WindowManager {
  private readonly windows = new Map<WindowLabel, BrowserWindow>()
  private quitting = false
  private onCaptureWindowHidden: (() => void) | undefined
  private nativeMenu: { owner: BrowserWindow; token: symbol } | undefined
  private readonly translatorReadyContents = new Set<number>()
  private readonly translatorReadyWaiters = new Map<number, Set<() => void>>()

  constructor(
    private readonly preloadPath: string,
    private readonly rendererIndex: string,
    private readonly iconPath: string,
    private readonly logger: AppLogger
  ) {}

  setCaptureWindowHiddenHandler(handler: () => void): void {
    this.onCaptureWindowHidden = handler
  }

  get(label: WindowLabel): BrowserWindow | undefined {
    const window = this.windows.get(label)
    return window && !window.isDestroyed() ? window : undefined
  }

  markTranslatorReady(webContentsId: number): void {
    const window = this.get('translator')
    if (!window || window.webContents.id !== webContentsId) throw new Error('translator renderer is unavailable')
    this.translatorReadyContents.add(webContentsId)
    const waiters = this.translatorReadyWaiters.get(webContentsId)
    if (!waiters) return
    this.translatorReadyWaiters.delete(webContentsId)
    for (const resolveWaiter of waiters) resolveWaiter()
  }

  labelForWebContentsId(id: number): WindowLabel | undefined {
    for (const [label, window] of this.windows) {
      if (!window.isDestroyed() && window.webContents.id === id) return label
    }
    return undefined
  }

  owns(window: BrowserWindow): boolean {
    return [...this.windows.values()].some(candidate => candidate === window)
  }

  createInitialWindows(config: Readonly<AppConfigurationData>): void {
    this.createTranslator(config)
    // Windows capture interaction is owned by the persistent Rust overlay.
    // Keep the renderer window only as the non-Windows development fallback.
    if (process.platform !== 'win32') this.createScreenCapture()
  }

  createTranslator(config: Readonly<AppConfigurationData>): BrowserWindow {
    const existing = this.get('translator')
    if (existing) return existing
    const window = this.create('translator', {
      width: TRANSLATOR_WIDTH,
      height: TRANSLATOR_MIN_HEIGHT,
      minWidth: TRANSLATOR_WIDTH,
      maxWidth: TRANSLATOR_WIDTH,
      minHeight: TRANSLATOR_MIN_HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      show: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: Boolean(config.pinup),
      hasShadow: true,
      title: 'TOAE'
    })
    window.setContentSize(TRANSLATOR_WIDTH, TRANSLATOR_MIN_HEIGHT, false)
    const webContentsId = window.webContents.id
    window.webContents.on('did-start-loading', () => { this.translatorReadyContents.delete(webContentsId) })
    window.on('close', event => {
      if (this.quitting) return
      event.preventDefault()
      window.hide()
    })
    window.on('closed', () => {
      this.translatorReadyContents.delete(webContentsId)
      this.translatorReadyWaiters.delete(webContentsId)
    })
    return window
  }

  createSetting(): BrowserWindow {
    const existing = this.get('setting')
    if (existing) return existing
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const width = Math.min(SETTING_WIDTH, display.workArea.width)
    const height = Math.min(SETTING_HEIGHT, display.workArea.height)
    const bounds = centeredBounds(display.workArea, width, height)
    const window = this.create('setting', {
      ...bounds,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      show: false,
      resizable: true,
      skipTaskbar: false,
      hasShadow: true,
      title: '设置 - 通用设置'
    })
    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) { window.show(); window.focus() }
    })
    return window
  }

  createScreenCapture(): BrowserWindow {
    const existing = this.get('screen-capture')
    if (existing) return existing
    const display = screen.getPrimaryDisplay()
    const window = this.create('screen-capture', {
      ...display.bounds,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      title: 'TOAE Screenshot',
      webPreferences: { backgroundThrottling: false }
    })
    window.on('close', event => {
      if (this.quitting) return
      event.preventDefault()
      window.hide()
      this.onCaptureWindowHidden?.()
    })
    return window
  }

  async showSetting(): Promise<void> {
    const window = this.createSetting()
    await this.waitUntilLoaded(window)
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  async showTranslator(focus: boolean, config: Readonly<AppConfigurationData>): Promise<void> {
    const window = this.createTranslator(config)
    await this.waitUntilLoaded(window)
    await this.waitUntilTranslatorReady(window)
    this.positionTranslator(window, config.win_position)
    window.setAlwaysOnTop(true)
    if (focus) {
      await this.focusTranslatorWindow(window)
      this.send(window, IPC.translatorFocus, true)
    } else {
      window.showInactive()
    }
  }

  async toggleTranslator(focus: boolean, config: Readonly<AppConfigurationData>): Promise<void> {
    const visible = this.get('translator')
    if (visible?.isVisible()) {
      visible.hide()
      return
    }
    await this.showTranslator(focus, config)
  }

  async prepareCaptureWindow(displayBounds: Rectangle): Promise<BrowserWindow> {
    const window = this.createScreenCapture()
    await this.waitUntilLoaded(window)
    if (window.isFullScreen()) window.setFullScreen(false)
    window.setBounds(displayBounds, false)
    return window
  }

  async sendCaptureFrame(payload: CaptureFramePayload): Promise<void> {
    const window = this.get('screen-capture')
    if (!window) throw new Error('screen-capture window is unavailable')
    await this.waitUntilLoaded(window)
    this.send(window, IPC.captureFrame, payload)
  }

  sendCaptureError(message: string): void {
    const window = this.get('screen-capture')
    if (window) this.send(window, IPC.captureError, message.slice(0, 1000))
  }

  async sendTranslatorPayload(payload: TranslatorPayload, config: Readonly<AppConfigurationData>): Promise<void> {
    const window = this.createTranslator(config)
    await this.waitUntilLoaded(window)
    await this.waitUntilTranslatorReady(window)
    this.send(window, IPC.translatorPayload, payload)
  }

  broadcastConfig(snapshot: ConfigSnapshot, sourceLabel: WindowLabel): void {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) this.send(window, IPC.configChanged, snapshot, sourceLabel)
    }
  }

  beginNativeMenu(owner: BrowserWindow): () => void {
    if (owner.isDestroyed() || !this.owns(owner)) throw new Error('menu owner is unavailable')
    const context = { owner, token: Symbol('native-menu') }
    this.nativeMenu = context
    return () => {
      if (this.nativeMenu === context) this.nativeMenu = undefined
    }
  }

  activeWindowIsSelf(): boolean {
    const menuOwner = this.nativeMenu?.owner
    if (menuOwner && !menuOwner.isDestroyed() && this.owns(menuOwner)) return true
    if (menuOwner) this.nativeMenu = undefined
    const focused = BrowserWindow.getFocusedWindow()
    return Boolean(focused && this.owns(focused))
  }

  async setTranslatorContentHeight(heightDip: number): Promise<void> {
    const window = this.get('translator')
    if (!window) return
    const current = window.getBounds()
    const display = screen.getDisplayMatching(current)
    const height = Math.max(TRANSLATOR_MIN_HEIGHT, Math.min(Math.ceil(heightDip), display.workArea.height))
    const [, currentContentHeight] = window.getContentSize()
    if (Math.abs(currentContentHeight - height) < 1) return
    window.setContentSize(TRANSLATOR_WIDTH, height, false)
    const resized = window.getBounds()
    const next = clampBounds({ x: current.x, y: current.y, width: resized.width, height: resized.height }, display.workArea)
    window.setBounds(next, false)
  }

  setQuitting(): void { this.quitting = true }

  closeAll(): void {
    this.quitting = true
    this.nativeMenu = undefined
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) window.destroy()
    }
    this.windows.clear()
  }

  private create(label: WindowLabel, options: BrowserWindowConstructorOptions): BrowserWindow {
    const webPreferences = {
      preload: this.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      devTools: !process.env.TOAE_PRODUCTION,
      spellcheck: true,
      additionalArguments: [`--toae-window=${label}`],
      ...options.webPreferences
    }
    const window = new BrowserWindow({
      icon: this.iconPath,
      autoHideMenuBar: true,
      ...options,
      webPreferences
    })
    this.windows.set(label, window)

    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, targetUrl) => {
      const current = window.webContents.getURL()
      try {
        if (current && new URL(targetUrl).origin === new URL(current).origin) return
      } catch { /* reject malformed navigation */ }
      event.preventDefault()
      this.logger.log('warn', 'renderer navigation blocked', { label })
    })
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.on('render-process-gone', (_event, details) => {
      this.logger.log('error', 'renderer process gone', { label, reason: details.reason, exitCode: details.exitCode })
    })
    window.on('closed', () => {
      if (this.nativeMenu?.owner === window) this.nativeMenu = undefined
      if (this.windows.get(label) === window) this.windows.delete(label)
    })

    const devServer = process.env.TOAE_DEV_SERVER_URL
    if (devServer) {
      const url = new URL(devServer)
      url.searchParams.set('window', label)
      void window.loadURL(url.toString())
    } else {
      void window.loadFile(this.rendererIndex, { query: { window: label } })
    }
    return window
  }

  private positionTranslator(window: BrowserWindow, strategy: AppConfigurationData['win_position']): void {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const current = window.getBounds()
    let bounds = { ...current, width: TRANSLATOR_WIDTH }
    if (strategy === 'center') {
      bounds = centeredBounds(display.workArea, bounds.width, bounds.height)
    } else if (strategy === 'right-top') {
      bounds.x = display.workArea.x + display.workArea.width - bounds.width - 50
      bounds.y = display.workArea.y + 50
    } else if (strategy === 'mouse') {
      bounds.x = cursor.x
      bounds.y = cursor.y
    }
    window.setBounds(clampBounds(bounds, display.workArea), false)
  }

  private async waitUntilTranslatorReady(window: BrowserWindow): Promise<void> {
    const webContentsId = window.webContents.id
    if (this.translatorReadyContents.has(webContentsId)) return
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const waiters = this.translatorReadyWaiters.get(webContentsId) ?? new Set<() => void>()
      const timer = setTimeout(() => {
        waiters.delete(done)
        if (waiters.size === 0) this.translatorReadyWaiters.delete(webContentsId)
        rejectPromise(new Error('translator renderer ready timed out'))
      }, 15_000)
      const done = () => {
        clearTimeout(timer)
        resolvePromise()
      }
      waiters.add(done)
      this.translatorReadyWaiters.set(webContentsId, waiters)
    })
  }

  private async focusTranslatorWindow(window: BrowserWindow): Promise<void> {
    if (window.isMinimized()) window.restore()
    let focused = window.isFocused()
    for (let attempt = 0; !focused && attempt < 2; attempt += 1) {
      const focusResult = this.waitForWindowFocus(window, 120)
      window.show()
      window.focus()
      focused = await focusResult
      if (!focused && attempt === 0 && !window.isDestroyed()) {
        window.moveTop()
        await new Promise(resolvePromise => setTimeout(resolvePromise, 16))
      }
    }
    if (!window.webContents.isDestroyed()) window.webContents.focus()
    if (!focused) this.logger.log('warn', 'translator window focus was not confirmed after retry')
  }

  private async waitForWindowFocus(window: BrowserWindow, timeoutMs: number): Promise<boolean> {
    if (window.isFocused()) return true
    return new Promise<boolean>(resolvePromise => {
      let settled = false
      const done = (focused: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        window.removeListener('focus', onFocus)
        resolvePromise(focused)
      }
      const onFocus = () => done(true)
      const timer = setTimeout(() => done(!window.isDestroyed() && window.isFocused()), timeoutMs)
      window.once('focus', onFocus)
    })
  }

  private async waitUntilLoaded(window: BrowserWindow): Promise<void> {
    if (!window.webContents.isLoadingMainFrame()) return
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('renderer load timed out')), 15_000)
      const done = () => { clearTimeout(timer); resolvePromise() }
      window.webContents.once('did-finish-load', done)
      window.webContents.once('did-fail-load', (_event, code, description) => {
        clearTimeout(timer)
        rejectPromise(new Error(`renderer failed to load (${code}): ${description}`))
      })
    })
  }

  private send(window: BrowserWindow, channel: string, ...args: unknown[]): void {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, ...args)
  }
}

function centeredBounds(area: Rectangle, width: number, height: number): Rectangle {
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height
  }
}

function clampBounds(bounds: Rectangle, area: Rectangle): Rectangle {
  const width = Math.min(Math.max(1, bounds.width), area.width)
  const height = Math.min(Math.max(1, bounds.height), area.height)
  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    width,
    height
  }
}
