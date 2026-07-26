import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('native capture overlay boundary', () => {
  it('keeps screenshot interaction in a persistent Rust window and returns only the confirmed ROI', () => {
    const main = source('native-helper/src/main.rs')
    const overlay = source('native-helper/src/overlay.rs')
    const supervisor = source('native-helper/src/supervisor.rs')
    const captureService = source('electron/main/capture/service.ts')
    const windows = source('electron/main/windows/manager.ts')

    expect(main).toContain('if args.flag("--capture-overlay")')
    expect(supervisor).toContain('.arg("--capture-overlay")')
    expect(supervisor).toContain('persistent native capture overlay ready')
    expect(overlay).toContain('CreateDIBSection(')
    expect(overlay).toContain('SRCCOPY | CAPTUREBLT')
    expect(overlay.indexOf('self.render()')).toBeLessThan(overlay.indexOf('ShowWindow(self.hwnd, SW_SHOW)'))
    expect(overlay).toContain('state.confirm()')
    expect(overlay).toContain('state.cancel()')
    expect(overlay).toContain('surface.crop_png(selection)')
    expect(overlay).toContain('if self.editor.enabled()')
    expect(overlay).toContain('draw_selection_frame(surface, self.selection, self.selection_ready)')
    const editor = source('native-helper/src/overlay_editor.rs')
    expect(editor).toContain('const BUTTONS: [ToolbarButton; 10]')
    expect(editor).toContain('GdipSetSmoothingMode(graphics, SmoothingModeAntiAlias8x8)')
    expect(editor).not.toContain('ToolbarButton::Emoji')
    expect(editor).not.toContain('ToolbarButton::Text')
    expect(captureService).toContain('await this.native.client.captureStart({ action, editor }, 180_000)')
    expect(captureService).toContain("const editor = action === 'screenshot_translate' && this.config.value().image_translate_enabled")
    expect(captureService).toContain("String(selected.meta.intent) === 'translate'")
    expect(captureService).toContain('captureEditorContinue(')
    expect(overlay).toContain('GetSaveFileNameW(&mut options)')
    expect(windows).toContain("if (process.platform !== 'win32') this.createScreenCapture()")
  })
})
