import { app } from 'electron'
import type { LoginItemStatus } from '../../../src/contracts'

const AUTOSTART_ARGS = ['--autostart']

export class LoginItemService {
  get(): LoginItemStatus {
    if (process.platform !== 'win32' || !app.isPackaged) {
      return { supported: false, enabled: false, executableWillLaunchAtLogin: false }
    }
    const status = app.getLoginItemSettings({ path: process.execPath, args: AUTOSTART_ARGS })
    return {
      supported: true,
      enabled: Boolean(status.openAtLogin && status.executableWillLaunchAtLogin),
      executableWillLaunchAtLogin: Boolean(status.executableWillLaunchAtLogin)
    }
  }

  set(enabled: boolean): LoginItemStatus {
    if (process.platform !== 'win32' || !app.isPackaged) throw new Error('开机自启动仅支持 Windows 安装版')
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: AUTOSTART_ARGS
    })
    const readBack = this.get()
    if (enabled !== readBack.enabled) throw new Error('Windows 未确认开机自启动设置')
    return readBack
  }
}
