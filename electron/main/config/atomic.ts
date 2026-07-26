import { open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const WINDOWS_RETRY_DELAYS_MS = [0, 25, 75, 150, 300]

async function sleep(ms: number): Promise<void> {
  if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms))
}

export async function atomicWriteFile(path: string, data: string | Uint8Array): Promise<void> {
  const directory = dirname(path)
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }

  let lastError: unknown
  for (const delay of WINDOWS_RETRY_DELAYS_MS) {
    await sleep(delay)
    try {
      await rename(temporary, path)
      // Best-effort directory flush. Windows does not allow opening a directory
      // this way; the temp file itself has already been flushed there.
      if (process.platform !== 'win32') {
        const directoryHandle = await open(directory, 'r')
        try { await directoryHandle.sync() } finally { await directoryHandle.close() }
      }
      return
    } catch (error) {
      lastError = error
    }
  }
  await rm(temporary, { force: true }).catch(() => undefined)
  throw lastError
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
