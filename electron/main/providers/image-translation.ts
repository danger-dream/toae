import type { OcrItem } from './ocr'

export interface ImageRenderRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ImageTextRegion {
  sourceText: string
  translatedText: string
  eraseRects: ImageRenderRect[]
  layoutRect: ImageRenderRect
  fontSize: number
  bold: boolean
  align: 'left' | 'center' | 'right'
  verticalAlign: 'top' | 'center'
}

interface Line {
  text: string
  confidence: number
  rect: ImageRenderRect
}

interface RegionBuilder {
  lines: Line[]
}

export function buildImageTextRegions(items: OcrItem[], imageWidth: number, imageHeight: number): ImageTextRegion[] {
  if (!Number.isSafeInteger(imageWidth) || !Number.isSafeInteger(imageHeight) || imageWidth < 1 || imageHeight < 1) {
    throw new Error('图片尺寸无效')
  }
  const lines = items
    .slice(0, 1024)
    .map(item => toLine(item, imageWidth, imageHeight))
    .filter((line): line is Line => Boolean(line))
    .filter(line => isTranslatableText(line.text))
    .sort(readingOrder)

  const builders: RegionBuilder[] = []
  for (const line of lines) {
    let best: { builder: RegionBuilder; score: number } | undefined
    for (const builder of builders) {
      const previous = builder.lines[builder.lines.length - 1]
      const score = mergeScore(previous, line, imageWidth)
      if (score !== undefined && (!best || score < best.score)) best = { builder, score }
    }
    if (best) best.builder.lines.push(line)
    else builders.push({ lines: [line] })
  }

  return builders
    .map(builder => finalizeRegion(builder.lines, imageWidth))
    .filter((region): region is ImageTextRegion => Boolean(region))
    .sort(regionReadingOrder)
    .slice(0, 256)
}

function toLine(item: OcrItem, imageWidth: number, imageHeight: number): Line | undefined {
  if (!item.text?.trim() || !Number.isFinite(item.confidence) || item.confidence < 0.72 || item.polygon.length < 4) return undefined
  const xs = item.polygon.map(point => Number(point.x)).filter(Number.isFinite)
  const ys = item.polygon.map(point => Number(point.y)).filter(Number.isFinite)
  if (xs.length < 4 || ys.length < 4) return undefined
  const left = clamp(Math.floor(Math.min(...xs)), 0, imageWidth - 1)
  const top = clamp(Math.floor(Math.min(...ys)), 0, imageHeight - 1)
  const right = clamp(Math.ceil(Math.max(...xs)), left + 1, imageWidth)
  const bottom = clamp(Math.ceil(Math.max(...ys)), top + 1, imageHeight)
  const rect = { x: left, y: top, width: right - left, height: bottom - top }
  if (rect.width < 2 || rect.height < 4 || rect.width * rect.height > imageWidth * imageHeight * 0.9) return undefined
  return { text: item.text.trim(), confidence: item.confidence, rect }
}

function readingOrder(left: Line, right: Line): number {
  const leftMiddle = left.rect.y + left.rect.height / 2
  const rightMiddle = right.rect.y + right.rect.height / 2
  const tolerance = Math.min(left.rect.height, right.rect.height) * 0.55
  if (Math.abs(leftMiddle - rightMiddle) <= tolerance) return left.rect.x - right.rect.x
  return leftMiddle - rightMiddle
}

function mergeScore(previous: Line, current: Line, imageWidth: number): number | undefined {
  if (isListItem(current.text)) return undefined
  const previousMiddle = previous.rect.y + previous.rect.height / 2
  const currentMiddle = current.rect.y + current.rect.height / 2
  const minimumHeight = Math.min(previous.rect.height, current.rect.height)
  if (currentMiddle - previousMiddle < minimumHeight * 0.62) return undefined

  const gap = current.rect.y - (previous.rect.y + previous.rect.height)
  const startsLowercase = /^[a-zà-ž]/u.test(current.text)
  const maximumGap = startsLowercase ? Math.max(14, minimumHeight * 1.2) : Math.max(9, minimumHeight * 0.8)
  if (gap < -minimumHeight * 0.2 || gap > maximumGap) return undefined
  const heightRatio = current.rect.height / previous.rect.height
  if (heightRatio < 0.68 || heightRatio > 1.48) return undefined
  const leftDelta = Math.abs(current.rect.x - previous.rect.x)
  if (leftDelta > Math.max(15, minimumHeight * 1.15)) return undefined

  const previousWide = previous.rect.width >= imageWidth * 0.52
  const continuation = /[,，、;；—-]$/.test(previous.text) || startsLowercase
  if (!previousWide && !continuation) return undefined
  if (/[.!?。！？]$/.test(previous.text) && gap > minimumHeight * 0.25) return undefined
  return Math.max(0, gap) * 4 + leftDelta + Math.abs(1 - heightRatio) * 20
}

function finalizeRegion(lines: Line[], imageWidth: number): ImageTextRegion | undefined {
  if (lines.length === 0) return undefined
  lines.sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x)
  const sourceText = smartJoin(lines.map(line => line.text))
  if (!sourceText || sourceText.length > 20_000) return undefined
  const left = Math.min(...lines.map(line => line.rect.x))
  const top = Math.min(...lines.map(line => line.rect.y))
  const right = Math.max(...lines.map(line => line.rect.x + line.rect.width))
  const bottom = Math.max(...lines.map(line => line.rect.y + line.rect.height))
  const heights = lines.map(line => line.rect.height).sort((a, b) => a - b)
  const medianHeight = heights[Math.floor(heights.length / 2)]
  const compactLength = Array.from(sourceText.replace(/\s/g, '')).length
  const singleCompactLabel = lines.length === 1 && compactLength <= 12 && right - left < imageWidth * 0.4
  return {
    sourceText,
    translatedText: '',
    eraseRects: lines.map(line => ({ ...line.rect })),
    layoutRect: { x: left, y: top, width: right - left, height: bottom - top },
    fontSize: clamp(Math.round(medianHeight * 0.94), 8, 96),
    bold: medianHeight >= 20 && compactLength <= 120,
    align: singleCompactLabel ? 'center' : 'left',
    verticalAlign: lines.length === 1 ? 'center' : 'top'
  }
}

function smartJoin(lines: string[]): string {
  let result = ''
  for (const current of lines) {
    if (!result) {
      result = current
      continue
    }
    const previous = result[result.length - 1]
    const first = current[0]
    if (previous === '-') result = result.slice(0, -1) + current
    else if (isCjk(previous) && isCjk(first)) result += current
    else result += ` ${current}`
  }
  return result.trim()
}

function isTranslatableText(text: string): boolean {
  const value = text.trim()
  const letters = Array.from(value.matchAll(/\p{L}/gu)).length
  if (letters < 2) return false
  if (/^[@#]/u.test(value)) return false
  if (/^(?:https?:\/\/|www\.)\S+$/i.test(value)) return false
  if (/^[^\p{L}\p{N}]*[\d.,+\-\s]+(?:[KMBT]|%|次|个|条)$/iu.test(value)) return false
  if (/^[A-Z\d_.+\-]{1,6}$/.test(value)) return false
  if (/^(?:[a-z\d]+-){2,}[a-z\d-]+$/i.test(value)) return false
  if (/^[A-Za-z]:\\\S+$/.test(value) || /^\/(?:[^\s/]+\/)+[^\s]*$/.test(value)) return false
  return true
}

function regionReadingOrder(left: ImageTextRegion, right: ImageTextRegion): number {
  const leftMiddle = left.layoutRect.y + left.layoutRect.height / 2
  const rightMiddle = right.layoutRect.y + right.layoutRect.height / 2
  const tolerance = Math.min(left.layoutRect.height, right.layoutRect.height) * 0.55
  if (Math.abs(leftMiddle - rightMiddle) <= tolerance) return left.layoutRect.x - right.layoutRect.x
  return leftMiddle - rightMiddle
}

function isListItem(text: string): boolean {
  return /^\s*(?:[•●▪◦*-]|\d+[.)、]|[A-Za-z][.)])\s+/.test(text)
}

function isCjk(value: string | undefined): boolean {
  return Boolean(value && /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(value))
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

export async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  signal: AbortSignal,
  operation: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (values.length === 0) return []
  const result = new Array<R>(values.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error('request cancelled')
      const index = cursor
      cursor += 1
      if (index >= values.length) return
      result[index] = await operation(values[index], index)
    }
  })
  await Promise.all(workers)
  return result
}
