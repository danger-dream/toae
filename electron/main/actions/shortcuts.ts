import { globalShortcut } from 'electron'
import type { ActionName, AppConfigurationData } from '../../../src/contracts'
import type { AppLogger } from '../logging/logger'
import type { ActionRouter } from './router'

const ACTION_KEYS: ActionName[] = [
  'show_translator',
  'screenshot_translate',
  'selection_translate',
  'screenshot_recognizer'
]

export class ShortcutService {
  constructor(private readonly router: ActionRouter, private readonly logger: AppLogger) {}

  apply(config: Readonly<AppConfigurationData>): void {
    globalShortcut.unregisterAll()
    const seen = new Set<string>()
    for (const action of ACTION_KEYS) {
      const accelerator = config[action].trim()
      if (!accelerator) continue
      const normalized = accelerator.toLowerCase()
      if (seen.has(normalized)) {
        this.logger.log('warn', 'duplicate shortcut ignored', { action, accelerator })
        continue
      }
      seen.add(normalized)
      try {
        const registered = globalShortcut.register(accelerator, () => { void this.router.dispatch(action, 'shortcut') })
        if (!registered) this.logger.log('warn', 'global shortcut registration failed', { action, accelerator })
      } catch (error) {
        this.logger.log('warn', 'invalid global shortcut', { action, accelerator, error: String(error) })
      }
    }
  }

  dispose(): void { globalShortcut.unregisterAll() }
}
