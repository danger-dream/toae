import type {
  ProviderCallRequest,
  ProviderCallResult,
  ProviderCapability,
  ServiceConfigData
} from '../contracts'
import { uuid } from '../Utils'

function providerApi() {
  const api = window.toae.provider
  if (!api) throw new Error('当前窗口不允许调用服务')
  return api
}

export async function callConfiguredProvider(input: Omit<ProviderCallRequest, 'requestId'>): Promise<ProviderCallResult> {
  return providerApi().call({ ...input, requestId: uuid() })
}

export async function testDraftProvider(input: {
  kind: 'translate' | 'ocr'
  service: ServiceConfigData
  capability: ProviderCapability
  imageBase64?: string
  text?: string
  from?: string
  to?: string
}): Promise<unknown> {
  return providerApi().testDraft(input)
}
