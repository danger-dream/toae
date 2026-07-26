import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const SECRET_PATTERN = /(authorization|api[_-]?key|secret|token|password|client_secret)(["'\s:=]+)([^\s,"'}]+)/gi
const QUERY_SECRET_PATTERN = /([?&](?:key|token|secret|signature|sign|appid|client_secret)=)[^&\s]+/gi

export function redact(value: unknown): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = '[unserializable]'
  }
  return text
    .replace(SECRET_PATTERN, '$1$2[REDACTED]')
    .replace(QUERY_SECRET_PATTERN, '$1[REDACTED]')
    .slice(0, 4000)
}

export class AppLogger {
  private queue: Promise<void> = Promise.resolve()
  private readonly logPath: string

  constructor(userData: string) {
    this.logPath = join(userData, 'logs', 'main.log')
  }

  log(level: 'error' | 'warn' | 'info' | 'debug', message: unknown, details?: unknown): void {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redact(message)}${details === undefined ? '' : ` ${redact(details)}`}\n`
    if (process.env.NODE_ENV !== 'production') {
      const method = level === 'debug' ? 'log' : level
      console[method](line.trimEnd())
    }
    this.queue = this.queue
      .then(async () => {
        await mkdir(join(this.logPath, '..'), { recursive: true, mode: 0o700 })
        await appendFile(this.logPath, line, { encoding: 'utf8', mode: 0o600 })
      })
      .catch(() => undefined)
  }
}
