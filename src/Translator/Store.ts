import { ref, type Ref, watch } from 'vue'
import {
  emit,
  getSize,
  hideWindow,
  invoke,
  isVisible,
  listen,
  setAlwaysOnTop,
  setFocus,
  setSize,
  writeClipboardText
} from '../Background'
import { type IConfiguration, configuration, generateTransConfig } from '../Configuration.ts'
import { detect, LanguageZh, textConvert, invokeLocalDetect } from '../Plugins/Translator'
import type { IDictResult, ITransServiceConfig } from '../types'
import { uuid } from '../Utils.ts'
import TargetView from './TargetView.vue'
import type { TranslatorPayload } from '../contracts'

class Store {
  public text: Ref<string> = ref('')
  public src: Ref<string> = ref('auto')
  public target: Ref<string> = ref('zh_cn')

  public isDetecting: Ref<boolean> = ref(false)
  public isTranslating: Ref<boolean> = ref(false)
  /** Kept for the existing UI/state contract; OCR itself now runs in Main. */
  public isRecogning: Ref<boolean> = ref(false)
  public detect_language: Ref<string> = ref('')

  public serviceEl: Map<string, InstanceType<typeof TargetView>> = new Map()
  public gorupId = ''
  public checkScrollHeight: Function

  async init(conf: IConfiguration): Promise<void> {
    this.target.value = conf.to
    const self = this

    await listen<{ key: string; value: any }>('config://updated', ({ key, value }) => {
      if (key === 'pinup') setAlwaysOnTop(Boolean(value))
    })

    const acceptPayload = async (payload: TranslatorPayload) => {
      if (self.isTranslating.value || self.isRecogning.value || !payload.text?.trim()) return
      if (!await isVisible()) await invoke('show_trans_win', { focus: false })
      await self.clear()
      self.text.value = payload.text
      if (payload.translate) await self.translate()
      else emit('translator://focus/no-clear')
    }
    await listen<TranslatorPayload>('translator://payload', acceptPayload)

    // Compatibility with the old event name for any in-renderer caller.
    await listen<string>('translator://text', text => acceptPayload({
      requestId: uuid(), text, translate: true, source: 'selection'
    }))

    window.addEventListener('blur', async () => {
      try {
        if (await invoke('active_window_is_self')) return
      } catch { /* hide on an actual application blur */ }
      await setAlwaysOnTop(conf.pinup)
      if (!conf.pinup) await hideWindow()
    })

    watch(this.text, async value => {
      this.detect_language.value = value ? await invokeLocalDetect(value) : ''
    })
  }

  private async language_detect(value: string): Promise<boolean> {
    if (this.isDetecting.value) return false
    this.detect_language.value = ''
    value = value.trim()
    if (!value) return false
    this.isDetecting.value = true
    const services = configuration.trans_services
      .map(generateTransConfig)
      .filter((item): item is ITransServiceConfig => Boolean(item?.service?.Detect && item.detectVerify))
    try {
      this.detect_language.value = await detect(services, value, configuration.detect_type)
    } catch {
      this.detect_language.value = await invokeLocalDetect(value)
    } finally {
      this.isDetecting.value = false
    }
    return true
  }

  async clear(): Promise<void> {
    this.text.value = ''
    this.detect_language.value = ''
    for (const target of this.serviceEl.values()) await target.clear()
  }

  async translate(): Promise<void> {
    if (this.isTranslating.value || this.isRecogning.value || this.serviceEl.size < 1) return
    this.isTranslating.value = true
    if (this.src.value === 'auto') await this.language_detect(this.text.value)

    let total = this.serviceEl.size
    this.gorupId = uuid()
    let copiedFirst = false

    const handleResult = ({ id, data }: { id: string; data: string | IDictResult }) => {
      if (!data) return
      if (configuration.auto_copy && (
        (!copiedFirst && configuration.copy_type === 'first') || id === configuration.copy_type
      )) this.copyResult(data)
      copiedFirst = true
    }
    const handleEnd = () => {
      total -= 1
      if (total === 0) this.isTranslating.value = false
    }

    for (const element of this.serviceEl.values()) {
      if (!element?.translate) { handleEnd(); continue }
      element.translate().then(handleResult).finally(handleEnd)
    }
  }

  async retryTranslate(
    _groupId: string,
    config: ITransServiceConfig,
    text: string,
    from: string,
    to: string,
    useCache: boolean
  ): Promise<string | IDictResult> {
    const service = config.service
    if (from === 'auto' && service.languages[from] === undefined) from = this.detect_language.value
    if (from === to || (from === 'auto' && to === this.detect_language.value)) {
      if (this.detect_language.value !== configuration.to2) {
        to = configuration.to2
      } else {
        const alternative = Object.keys(service.languages).find(language => language !== to && language !== 'auto')
        if (!alternative) {
          throw new Error(`当前设定源语种为: ${LanguageZh[from]}，检测语种为: ${LanguageZh[this.detect_language.value]}, 未找到可用的目标语种`)
        }
        to = alternative
      }
    }
    if (service.languages[from] === undefined) throw new Error('不支持的源语种: ' + LanguageZh[from])
    from = service.languages[from]
    if (service.languages[to] === undefined) throw new Error('不支持的目标语种: ' + LanguageZh[to])
    to = service.languages[to]

    return textConvert(config, text, from, to, configuration.only_dict, useCache)
  }

  async copyResult(result: string | IDictResult): Promise<void> {
    const text = typeof result === 'string' ? result : result.text
    if (text?.trim()) await writeClipboardText(text)
  }

  async resetSize(): Promise<void> {
    const current = await getSize()
    const scrollHeight = document.documentElement.scrollHeight
    let height = Math.min(document.documentElement.offsetHeight, scrollHeight) + 1
    if (!Number.isFinite(height)) height = 230
    await setSize(current.width, Math.floor(height))
    await setFocus()
    this.checkScrollHeight?.()
  }
}

export const TranslatorStore = new Store()
