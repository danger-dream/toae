import { Baidu } from './Baidu.ts'
import { Tencent } from './Tencent.ts'
import { Custom } from './Custom.tsx'
import type { IBaseOcrService } from '../../types'
import { testDraftProvider } from '../providerBridge'
import { providerIconUrl } from '../providerIcon'

const providerMetadata: IBaseOcrService[] = [Baidu, Tencent, Custom]

/** Preserve the original OCR configuration UI while running verification in Main. */
function mainBacked(service: IBaseOcrService): IBaseOcrService {
  return {
    ...service,
    icon: providerIconUrl(service.icon, window.location.protocol, import.meta.env.BASE_URL),
    Ocr: service.Ocr
      ? async (params, imageBase64) => String(await testDraftProvider({
          kind: 'ocr',
          service: { name: service.name, params },
          capability: 'ocr',
          imageBase64
        }))
      : undefined
  }
}

export const plugins: IBaseOcrService[] = providerMetadata.map(mainBacked)
