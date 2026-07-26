import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { invokeMenuCallback } from '../src/Background/menuCallback'
import { providerIconUrl } from '../src/Plugins/providerIcon'
import { formatHelperExit } from '../electron/main/helper/client'

const root = process.cwd()
const source = (path: string) => readFileSync(join(root, path), 'utf8')

describe('translator visibility regression', () => {
  it('toggles only shortcut/AHK actions and leaves all direct show paths unconditional', () => {
    const router = source('electron/main/actions/router.ts')
    const manager = source('electron/main/windows/manager.ts')
    const ipc = source('electron/main/ipc/register.ts')
    const capture = source('electron/main/capture/service.ts')

    expect(router).toContain("if (source === 'shortcut' || source === 'ahk')")
    expect(router).toContain('await this.windows.toggleTranslator(true, this.config.value())')
    expect(router).toContain('await this.windows.showTranslator(true, this.config.value())')
    expect(manager).toMatch(/toggleTranslator[\s\S]*?isVisible\(\)[\s\S]*?\.hide\(\)[\s\S]*?showTranslator/)
    expect(ipc).toContain('input.windows.showTranslator(Boolean(object(value).focus), input.config.value())')
    expect(capture.match(/this\.windows\.showTranslator\(false, this\.config\.value\(\)\)/g)).toHaveLength(4)
    expect(router).toContain('await this.windows.showTranslator(false, this.config.value())')
  })
})

describe('Electron drag-region regression', () => {
  it('keeps drag regions while marking exact setting interactions as no-drag', () => {
    const css = source('src/style.css')
    const setting = source('src/Setting/App.vue')
    const service = source('src/Setting/Service.vue')
    const translatorHeader = source('src/Translator/HeaderView.vue')

    expect(css).toContain('[data-tauri-drag-region] { -webkit-app-region: drag; }')
    expect(css).toMatch(/\.electron-no-drag\s*\{[\s\S]*?-webkit-app-region:\s*no-drag/)
    expect(setting).toMatch(/group electron-no-drag" @click="closeWindow\(\)"/)
    expect(setting.indexOf('@click="closeWindow()"')).toBeGreaterThan(setting.lastIndexOf('data-tauri-drag-region'))
    expect(setting).toContain('space-y-1 electron-no-drag" data-tauri-drag-region')
    expect(service).toContain('flex px-5 mt-0 electron-no-drag')
    expect(service).toContain('data-tauri-drag-region')
    expect(translatorHeader).toContain('data-tauri-drag-region')
    expect(source('src/components/IconBtn.vue')).toContain('cursor-pointer')
  })
})

describe('native language menu regression', () => {
  it('does not invoke the renderer selection callback when the menu is cancelled', () => {
    const callback = vi.fn()
    invokeMenuCallback(undefined, callback)
    expect(callback).not.toHaveBeenCalled()

    invokeMenuCallback({ target: 'src', lang: 'en' }, callback)
    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith({ target: 'src', lang: 'en' })
    expect(source('src/Background/index.ts')).toContain('invokeMenuCallback(payload, callback)')
  })

  it('uses currentTarget for stable menu anchors in both callers', () => {
    const sourceView = source('src/Translator/SourceView.vue')
    const service = source('src/Setting/Service.vue')
    expect(sourceView).toContain('(e.currentTarget as Element).getBoundingClientRect()')
    expect(service).toContain('(e.currentTarget as Element).getBoundingClientRect()')
    expect(sourceView).not.toContain('(e.target as Element).getBoundingClientRect()')
    expect(service).not.toContain('(e.target as Element).getBoundingClientRect()')
  })
})

describe('packaged Provider artwork regression', () => {
  it('resolves only known Provider icons relative to a file renderer', () => {
    expect(providerIconUrl('/icon/google.svg', 'file:', './')).toBe('./icon/google.svg')
    expect(providerIconUrl('/icon/tencent_cloud.png', 'file:', './')).toBe('./icon/tencent_cloud.png')
    expect(providerIconUrl('/icon/google.svg', 'http:', './')).toBe('/icon/google.svg')
    expect(providerIconUrl('/icon/unknown.svg', 'file:', './')).toBe('/icon/unknown.svg')
    expect(source('src/Plugins/Translator/index.ts')).toContain('providerIconUrl(service.icon, window.location.protocol, import.meta.env.BASE_URL)')
    expect(source('src/Plugins/OCR/index.ts')).toContain('providerIconUrl(service.icon, window.location.protocol, import.meta.env.BASE_URL)')
  })
})

describe('native capture diagnostics regression', () => {
  it('deselects the GDI bitmap before screen-DC GetDIBits and releases resources in order', () => {
    const captureSource = source('native-helper/src/capture.rs')
    const capture = captureSource.slice(captureSource.indexOf('fn capture_rect_gdi'))
    const bitBlt = capture.indexOf('let copied = BitBlt(')
    const deselect = capture.indexOf('let deselected = SelectObject(memory_dc, previous)', bitBlt)
    const getDibits = capture.indexOf('GetDIBits(', deselect)
    const deleteBitmap = capture.indexOf('let bitmap_released = DeleteObject', getDibits)
    const deleteMemoryDc = capture.indexOf('let memory_dc_released = DeleteDC', deleteBitmap)
    const releaseScreenDc = capture.indexOf('let screen_dc_released = ReleaseDC', deleteMemoryDc)

    expect(capture).toContain('if previous.is_invalid()')
    expect(capture).toContain('if deselected.is_invalid()')
    expect(bitBlt).toBeGreaterThanOrEqual(0)
    expect(deselect).toBeGreaterThan(bitBlt)
    expect(getDibits).toBeGreaterThan(deselect)
    expect(capture.slice(getDibits, getDibits + 80)).toContain('screen_dc')
    expect(deleteBitmap).toBeGreaterThan(getDibits)
    expect(deleteMemoryDc).toBeGreaterThan(deleteBitmap)
    expect(releaseScreenDc).toBeGreaterThan(deleteMemoryDc)
    expect(captureSource).toContain('capture stage=wgc.session-started')
    expect(captureSource).toContain('capture stage=wgc.readback-complete')
    expect(capture).toContain('capture stage=gdi.bitblt-complete')
    expect(capture).toContain('capture stage=gdi.bitmap-deselected')
  })

  it('formats Windows helper exit codes in decimal and fixed-width hexadecimal', () => {
    expect(formatHelperExit(1, null)).toBe('native helper exited (code=1 decimal, 0x00000001)')
    expect(formatHelperExit(3221225477, null)).toBe('native helper exited (code=3221225477 decimal, 0xC0000005)')
    const client = source('electron/main/helper/client.ts')
    expect(client).toContain("child.once('close'")
    expect(client).toMatch(/const finish[\s\S]*?flushStderr\(\)[\s\S]*?this\.handleExit/)
  })
})

describe('packaging allowlist regression', () => {
  it('packages only renderer, two runtime bundles and metadata, with node_modules excluded', () => {
    const packageJson = JSON.parse(source('package.json'))
    expect(packageJson.version).toBe('0.1.1')
    expect(packageJson.build.files).toEqual([
      'dist/renderer/**/*',
      'dist-electron/main/index.cjs',
      'dist-electron/preload/index.cjs',
      'package.json',
      'LICENSE',
      '!node_modules/**/*'
    ])
    expect(packageJson.build).not.toHaveProperty('asarUnpack')
    expect(JSON.parse(source('package-lock.json')).version).toBe('0.1.1')
  })
})
