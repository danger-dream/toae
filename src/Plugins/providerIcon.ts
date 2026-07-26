const KNOWN_PROVIDER_ICONS = new Set([
  '/icon/alibaba.svg',
  '/icon/baidu.svg',
  '/icon/bing.svg',
  '/icon/caiyun.svg',
  '/icon/custom.svg',
  '/icon/deepl.svg',
  '/icon/geminipro.webp',
  '/icon/google-free.svg',
  '/icon/google.svg',
  '/icon/openai.svg',
  '/icon/tencent.svg',
  '/icon/tencent_cloud.png',
  '/icon/youdao.svg'
])

/** Resolve public Provider artwork relative to the packaged file:// renderer. */
export function providerIconUrl(icon: string, protocol: string, baseUrl: string): string {
  if (protocol !== 'file:' || !KNOWN_PROVIDER_ICONS.has(icon)) return icon
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return `${base}${icon.slice(1)}`
}
