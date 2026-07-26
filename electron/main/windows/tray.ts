import { Menu, Tray } from 'electron'
import type { ActionRouter } from '../actions/router'
import type { WindowManager } from './manager'

export class TrayService {
  private tray?: Tray

  constructor(
    private readonly iconPath: string,
    private readonly router: ActionRouter,
    private readonly windows: WindowManager,
    private readonly version: string,
    private readonly requestRelaunch: () => void,
    private readonly requestQuit: () => void
  ) {}

  create(): void {
    if (this.tray) return
    const tray = new Tray(this.iconPath)
    tray.setToolTip(`TOAE ${this.version}`)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开翻译窗口', click: () => void this.router.dispatch('show_translator', 'tray') },
      { label: '截图翻译', click: () => void this.router.dispatch('screenshot_translate', 'tray') },
      { label: '图片识别', click: () => void this.router.dispatch('screenshot_recognizer', 'tray') },
      { type: 'separator' },
      { label: '设置', click: () => void this.windows.showSetting() },
      { type: 'separator' },
      { label: '重启', click: this.requestRelaunch },
      { label: '退出', click: this.requestQuit }
    ]))
    tray.on('double-click', () => void this.router.dispatch('show_translator', 'tray'))
    this.tray = tray
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = undefined
  }
}
