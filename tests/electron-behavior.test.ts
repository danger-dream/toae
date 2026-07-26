import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  menuTemplate: [] as any[],
  popupOptions: undefined as any,
  popupThrows: false,
  focusedWindow: undefined as any
}))

vi.mock('electron', () => {
  class BrowserWindowMock {
    static getFocusedWindow() { return electronState.focusedWindow }
    static fromWebContents(sender: any) { return sender.owner }
  }
  return {
    BrowserWindow: BrowserWindowMock,
    Menu: {
      buildFromTemplate(template: any[]) {
        electronState.menuTemplate = template
        return {
          popup(options: any) {
            electronState.popupOptions = options
            if (electronState.popupThrows) throw new Error('popup failed')
          }
        }
      }
    },
    clipboard: { readText: vi.fn(() => ''), writeText: vi.fn() },
    dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
    globalShortcut: { isRegistered: vi.fn(() => false) },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: any[]) => any) => electronState.handlers.set(channel, handler)),
      removeHandler: vi.fn((channel: string) => electronState.handlers.delete(channel)),
      on: vi.fn(),
      removeListener: vi.fn()
    },
    screen: {},
    shell: { openExternal: vi.fn() }
  }
})

import { ActionRouter } from '../electron/main/actions/router'
import { registerIpcHandlers } from '../electron/main/ipc/register'
import { WindowManager } from '../electron/main/windows/manager'
import { IPC } from '../electron/shared/channels'

beforeEach(() => {
  electronState.handlers.clear()
  electronState.menuTemplate = []
  electronState.popupOptions = undefined
  electronState.popupThrows = false
  electronState.focusedWindow = undefined
  vi.clearAllMocks()
})

describe('show_translator action behavior', () => {
  it('routes shortcut/AHK to toggle and tray/app to unconditional show', async () => {
    const windows = { toggleTranslator: vi.fn(async () => undefined), showTranslator: vi.fn(async () => undefined) }
    const router = new ActionRouter(
      windows as any,
      { start: vi.fn() } as any,
      {} as any,
      { value: () => ({}) } as any,
      { log: vi.fn() } as any
    )

    await router.dispatch('show_translator', 'shortcut')
    await router.dispatch('show_translator', 'ahk')
    await router.dispatch('show_translator', 'tray')
    await router.dispatch('show_translator', 'app')

    expect(windows.toggleTranslator).toHaveBeenCalledTimes(2)
    expect(windows.showTranslator).toHaveBeenCalledTimes(2)
  })

  it('hides a visible translator and shows an absent/hidden translator', async () => {
    const hide = vi.fn()
    const showTranslator = vi.fn(async () => undefined)
    await WindowManager.prototype.toggleTranslator.call({
      get: () => ({ isVisible: () => true, hide }),
      showTranslator
    } as any, true, {} as any)
    expect(hide).toHaveBeenCalledOnce()
    expect(showTranslator).not.toHaveBeenCalled()

    await WindowManager.prototype.toggleTranslator.call({
      get: () => ({ isVisible: () => false, hide }),
      showTranslator
    } as any, true, {} as any)
    expect(showTranslator).toHaveBeenCalledOnce()
  })
})

describe('native menu ownership and coordinates', () => {
  it('treats an open native menu owner as active until its matching close callback', () => {
    const manager = new WindowManager('', '', '', { log: vi.fn() } as any)
    const owner = { isDestroyed: () => false } as any
    vi.spyOn(manager, 'owns').mockReturnValue(true)

    const endMenu = manager.beginNativeMenu(owner)
    expect(manager.activeWindowIsSelf()).toBe(true)
    endMenu()
    expect(manager.activeWindowIsSelf()).toBe(false)
  })

  it('rounds finite DOM coordinates and clears owner state on cancel, selection and popup exception', async () => {
    const endNativeMenu = vi.fn()
    const windows = {
      labelForWebContentsId: vi.fn(() => 'translator'),
      owns: vi.fn(() => true),
      beginNativeMenu: vi.fn(() => endNativeMenu),
      get: vi.fn()
    }
    registerIpcHandlers({
      windows,
      config: { snapshot: vi.fn(() => ({ revision: 0, config: {} })) },
      providers: {},
      capture: {},
      native: { onLog: vi.fn() },
      startup: {},
      logger: { log: vi.fn() },
      detectLanguage: vi.fn(),
      onConfigChanged: vi.fn()
    } as any)
    const menuHandler = electronState.handlers.get(IPC.menuShow)!
    const owner = { isDestroyed: () => false }
    const frame = { url: 'file:///renderer/index.html' }
    const event = { sender: { id: 1, mainFrame: frame, owner }, senderFrame: frame }
    const value = {
      position: { x: 12.49, y: -4.5 },
      items: [{ label: 'English', payload: { lang: 'en' } }]
    }

    const cancelled = menuHandler(event, value)
    expect(electronState.popupOptions.x).toBe(12)
    expect(electronState.popupOptions.y).toBe(-4)
    expect(windows.beginNativeMenu).toHaveBeenCalledWith(owner)
    electronState.popupOptions.callback()
    await expect(cancelled).resolves.toBeUndefined()
    expect(endNativeMenu).toHaveBeenCalledTimes(1)

    endNativeMenu.mockClear()
    const selected = menuHandler(event, value)
    electronState.menuTemplate[0].click()
    await expect(selected).resolves.toEqual({ lang: 'en' })
    expect(endNativeMenu).not.toHaveBeenCalled()
    electronState.popupOptions.callback()
    expect(endNativeMenu).toHaveBeenCalledTimes(1)

    endNativeMenu.mockClear()
    electronState.popupThrows = true
    await expect(menuHandler(event, value)).rejects.toThrow('popup failed')
    expect(endNativeMenu).toHaveBeenCalledTimes(1)
  })
})
