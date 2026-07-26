import { app, session } from 'electron'
import { join, resolve } from 'node:path'
import { fileExists } from './config/atomic'
import { runLegacyMigration } from './config/migration'
import { ConfigService } from './config/service'
import { AppLogger } from './logging/logger'
import { ProviderService } from './providers/service'
import { detectLanguage } from './providers/language'
import { NativeService } from './helper/service'
import { WindowManager } from './windows/manager'
import { CaptureService } from './capture/service'
import { ActionRouter } from './actions/router'
import { ShortcutService } from './actions/shortcuts'
import { TrayService } from './windows/tray'
import { LoginItemService } from './startup/login-item'
import { registerIpcHandlers } from './ipc/register'
import type { ActionName } from '../../src/contracts'

app.setName('TOAE')
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.exit(0)
} else {
  void boot()
}

async function boot(): Promise<void> {
  await app.whenReady()
  app.setAppUserModelId('com.danger-dream.toae')
  if (app.isPackaged) process.env.TOAE_PRODUCTION = '1'
  installSessionSecurity()

  const userData = app.getPath('userData')
  const appData = app.getPath('appData')
  const resourcesRoot = app.isPackaged ? process.resourcesPath : resolve('resources')
  const defaultScriptPath = join(resourcesRoot, 'default-script.ahk')
  const configPath = join(userData, 'config.v1.json')
  const hadCanonicalConfig = await fileExists(configPath)

  const logger = new AppLogger(userData)
  let migrationImportedConfig = false
  try {
    const report = await runLegacyMigration({ userData, appData, defaultScriptPath })
    migrationImportedConfig = Boolean(report?.files.some(file => file.name === '.config.dat' && file.imported))
    if (report) logger.log('info', 'legacy migration completed', {
      imported: report.files.filter(file => file.imported).map(file => file.name),
      skipped: report.files.filter(file => file.error).length
    })
  } catch (error) {
    logger.log('error', 'legacy migration failed', error)
  }

  const config = new ConfigService(userData)
  await config.initialize()
  const providers = new ProviderService(config, logger, userData)
  await providers.initialize()

  const preloadPath = join(__dirname, '..', 'preload', 'index.cjs')
  const rendererIndex = join(app.getAppPath(), 'dist', 'renderer', 'index.html')
  const iconPath = app.isPackaged ? join(process.resourcesPath, 'icon.png') : resolve('resources', 'icon.png')
  const windows = new WindowManager(preloadPath, rendererIndex, iconPath, logger)
  const native = new NativeService(config, userData, process.resourcesPath, app.isPackaged, logger)
  const capture = new CaptureService(windows, native, providers, config, logger)
  const router = new ActionRouter(windows, capture, native, config, logger)
  const shortcuts = new ShortcutService(router, logger)
  const startup = new LoginItemService()

  let tray: TrayService
  let removeIpcHandlers: (() => void) | undefined
  let shutdownPromise: Promise<void> | undefined
  let exited = false

  const shutdown = (relaunch = false): Promise<void> => {
    if (shutdownPromise) return shutdownPromise
    shutdownPromise = (async () => {
      router.stopAccepting()
      shortcuts.dispose()
      await capture.cancelActive('application shutdown')
      providers.cancelAll()
      await providers.cache.dispose().catch(error => logger.log('error', 'cache flush failed', error))
      await native.shutdown().catch(error => logger.log('error', 'native helper shutdown failed', error))
      removeIpcHandlers?.()
      tray?.destroy()
      windows.setQuitting()
      windows.closeAll()
      if (relaunch) app.relaunch()
      exited = true
      app.exit(0)
    })()
    return shutdownPromise
  }

  tray = new TrayService(
    iconPath,
    router,
    windows,
    app.getVersion(),
    () => { void shutdown(true) },
    () => { void shutdown(false) }
  )

  removeIpcHandlers = registerIpcHandlers({
    windows,
    config,
    providers,
    capture,
    native,
    startup,
    logger,
    detectLanguage,
    onConfigChanged: async (_previous, next, changedKeys) => {
      if (changedKeys.some(key => ['show_translator', 'screenshot_translate', 'selection_translate', 'screenshot_recognizer'].includes(key))) {
        shortcuts.apply(next)
      }
      if (changedKeys.includes('pinup')) windows.get('translator')?.setAlwaysOnTop(next.pinup)
      if (changedKeys.some(key => ['cache_day', 'cache_max_count', 'reserve_word'].includes(key))) providers.cache.prune()
    }
  })

  windows.setCaptureWindowHiddenHandler(() => { void capture.cancelActive('capture window closed') })
  native.onAction(action => {
    if (router.isAllowed(String(action))) void router.dispatch(action as ActionName, 'ahk')
    else logger.log('warn', 'native helper emitted a rejected action')
  })

  // Production windows are created lazily. This keeps --autostart strictly
  // tray/helper-only and still preserves the same first visible state.
  tray.create()
  shortcuts.apply(config.value())
  await native.initialize()

  const autostartLaunch = process.argv.includes('--autostart')
  const firstRun = !hadCanonicalConfig && !migrationImportedConfig
  if (!autostartLaunch && firstRun) await windows.showSetting()

  app.on('second-instance', (_event, commandLine) => {
    // Use the new instance's intent, not the first instance's launch mode. A
    // manual launch after a silent logon start must reveal the translator.
    if (!commandLine.includes('--autostart')) void router.dispatch('show_translator', 'app')
  })
  app.on('activate', () => { void router.dispatch('show_translator', 'app') })
  app.on('before-quit', event => {
    if (exited) return
    event.preventDefault()
    void shutdown(false)
  })
  app.on('window-all-closed', () => {
    // Deliberately remain resident in the tray on Windows.
  })
  process.once('SIGTERM', () => { void shutdown(false) })
  process.once('SIGINT', () => { void shutdown(false) })
}

function installSessionSecurity(): void {
  const target = session.defaultSession
  target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  target.setPermissionCheckHandler(() => false)
  target.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders }
    if (app.isPackaged && details.resourceType === 'mainFrame') {
      headers['Content-Security-Policy'] = [
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-src 'none'; worker-src 'self' blob:; form-action 'none'; base-uri 'self'"
      ]
    }
    callback({ responseHeaders: headers })
  })
}

process.on('uncaughtException', error => {
  // Electron also reports this to stderr. Avoid continuing silently while not
  // force-killing helper state; the normal shutdown handlers remain installed.
  console.error(error)
})
process.on('unhandledRejection', error => console.error(error))
