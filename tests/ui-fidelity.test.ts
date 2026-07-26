import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTIONS } from '../src/contracts'
import { DEFAULT_CONFIG, REMOVED_SELECTION_ASSISTANT_FIELDS } from '../electron/main/config/schema'
import { OCR_IDS } from '../electron/main/providers/ocr'
import { TRANSLATOR_IDS } from '../electron/main/providers/translator'

const oldRoot = '/opt/workspace/tosa'
const newRoot = process.cwd()
const hasBaseline = existsSync(join(oldRoot, 'src'))

function files(root: string): string[] {
  const result: string[] = []
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      if (statSync(path).isDirectory()) visit(path)
      else result.push(path)
    }
  }
  visit(root)
  return result
}

function vueTemplate(path: string): string {
  const source = readFileSync(path, 'utf8')
  const start = source.indexOf('<template>')
  const end = source.lastIndexOf('</template>')
  if (start < 0 || end < start) return ''
  return source.slice(start, end + '</template>'.length)
    // Non-visual Electron adapter hooks do not change layout, text or styling.
    .replace(' ref="rootEl"', '')
    .replaceAll(' electron-no-drag', '')
    .replace(/\r\n/g, '\n')
    .trim()
}

const SETTING_CLOSE_BUTTON = [
  '\t\t<!-- close button -->',
  '\t\t<div class="absolute right-0 top-0 z-40 px-4 py-2 hover:bg-[#c42b1c] group" @click="closeWindow()">',
  '\t\t\t<svg-icon icon="close" :size="14" class="cursor-pointer group-hover:text-white" />',
  '\t\t</div>'
].join('\n')

const GENERAL_IMAGE_TRANSLATION_BLOCK = [
  '\t\t\t<el-divider content-position="left">截图翻译功能配置</el-divider>',
  '\t\t\t<el-form-item label="图片直译">',
  '\t\t\t\t<ElCheckbox v-model="conf.image_translate_enabled">开启图片直译</ElCheckbox>',
  '\t\t\t\t<div class="item-tip">',
  '\t\t\t\t\t开启后，可在截图工具中点击翻译图标预览或取消译图；完成、双击或保存时才输出当前图片，截图识别不受影响。',
  '\t\t\t\t</div>',
  '\t\t\t</el-form-item>',
  '\t\t\t<el-form-item label="首选图片识别服务">',
  '\t\t\t\t<ElSelect v-model="conf.image_translate_ocr_service" :disabled="!conf.image_translate_enabled"',
  '\t\t\t\t\tclearable placeholder="请选择支持文字坐标的图片识别服务" style="width: 250px">',
  '\t\t\t\t\t<ElOption v-for="item in imageOcr" :key="item.id" :label="item.label" :value="item.id"/>',
  '\t\t\t\t</ElSelect>',
  '\t\t\t\t<div class="item-tip">仅显示能够返回文字坐标的已启用图片识别服务。</div>',
  '\t\t\t</el-form-item>',
  '\t\t\t<el-form-item label="首选文本翻译服务">',
  '\t\t\t\t<ElSelect v-model="conf.image_translate_trans_service" :disabled="!conf.image_translate_enabled"',
  '\t\t\t\t\tclearable placeholder="请选择图片直译使用的文本翻译服务" style="width: 250px">',
  '\t\t\t\t\t<ElOption v-for="item in imageTrans" :key="item.id" :label="item.label" :value="item.id"/>',
  '\t\t\t\t</ElSelect>',
  '\t\t\t\t<div class="item-tip">该选择独立于翻译窗口当前使用的服务。</div>',
  '\t\t\t</el-form-item>'
].join('\n')

function generalTemplateWithImageTranslationSettings(baseline: string): string {
  const marker = '\n\t\t\t<el-form-item label="翻译窗口位置">'
  if (!baseline.includes(marker)) throw new Error('Setting/General.vue baseline insertion marker changed')
  return baseline.replace(marker, `\n\n${GENERAL_IMAGE_TRANSLATION_BLOCK}\n${marker}`)
}

function settingTemplateWithApprovedCloseButtonMove(baseline: string): string {
  const original = `${SETTING_CLOSE_BUTTON}\n\n\t\t<!-- menus sider -->`
  if (!baseline.includes(original)) throw new Error('Setting/App.vue baseline close button block changed')
  const withoutCloseButton = baseline.replace(original, '\t\t<!-- menus sider -->')
  const rootEnd = '\n\t</div>\n</template>'
  if (!withoutCloseButton.endsWith(rootEnd)) throw new Error('Setting/App.vue baseline root changed')
  return `${withoutCloseButton.slice(0, -rootEnd.length)}\n\n${SETTING_CLOSE_BUTTON}${rootEnd}`
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('static baseline fidelity', () => {
  it.skipIf(!hasBaseline)('keeps every migrated Vue template byte-equivalent except the approved Electron fixes and image-translation settings', () => {
    const currentComponents = files(join(newRoot, 'src'))
      .filter(path => path.endsWith('.vue'))
      .map(path => relative(join(newRoot, 'src'), path))
    for (const component of currentComponents) {
      const baseline = join(oldRoot, 'src', component)
      if (!existsSync(baseline)) continue
      const baselineTemplate = vueTemplate(baseline)
      const expected = component === 'Setting/App.vue'
        ? settingTemplateWithApprovedCloseButtonMove(baselineTemplate)
        : component === 'Setting/General.vue'
          ? generalTemplateWithImageTranslationSettings(baselineTemplate)
          : baselineTemplate
      expect(vueTemplate(join(newRoot, 'src', component)), component).toBe(expected)
    }
  })

  it.skipIf(!hasBaseline)('keeps all public fonts, icons and Provider artwork byte-identical', () => {
    const baselineFiles = files(join(oldRoot, 'public')).map(path => relative(join(oldRoot, 'public'), path)).sort()
    const currentFiles = files(join(newRoot, 'public')).map(path => relative(join(newRoot, 'public'), path)).sort()
    expect(currentFiles).toEqual(baselineFiles)
    for (const file of baselineFiles) {
      expect(digest(join(newRoot, 'public', file)), file).toBe(digest(join(oldRoot, 'public', file)))
    }
  })

  it('maps all retained actions, Providers and canonical configuration fields', () => {
    expect(ACTIONS).toEqual(['show_translator', 'screenshot_translate', 'selection_translate', 'screenshot_recognizer'])
    expect(TRANSLATOR_IDS).toHaveLength(11)
    expect(OCR_IDS).toEqual(['baidu', 'tencent', 'custom'])
    expect(Object.keys(DEFAULT_CONFIG).sort()).toEqual([
      'auto_clear', 'auto_copy', 'cache_day', 'cache_max_count', 'copy_type', 'detect_type',
      'enable_ahk', 'enable_cache', 'image_translate_enabled', 'image_translate_ocr_service',
      'image_translate_trans_service', 'ocr_err_tip', 'ocr_retry_count', 'ocr_services',
      'ocr_succed_show_win', 'ocr_timeout', 'ocr_type', 'only_dict', 'pinup', 'reserve_word',
      'screenshot_recognizer', 'screenshot_translate', 'selection_translate', 'show_translator',
      'to', 'to2', 'trans_retry_count', 'trans_services', 'trans_timeout', 'use_cache', 'win_position'
    ].sort())
    expect([...REMOVED_SELECTION_ASSISTANT_FIELDS].sort()).toEqual([
      'assistant_hide_timer', 'assistant_rules', 'assistants', 'enable_rule',
      'enable_selection_assistant', 'pickword_type'
    ])
  })

  it('contains no production selection-translator window mapping', () => {
    const productionFiles = [
      join(newRoot, 'src', 'main.ts'),
      join(newRoot, 'electron', 'main', 'windows', 'manager.ts'),
      join(newRoot, 'electron', 'main', 'index.ts')
    ]
    for (const path of productionFiles) expect(readFileSync(path, 'utf8')).not.toContain('selection-translator')
    expect(existsSync(join(newRoot, 'src', 'SelectionTranslator'))).toBe(false)
    expect(existsSync(join(newRoot, 'src', 'Plugins', 'Selection'))).toBe(false)
  })
})
