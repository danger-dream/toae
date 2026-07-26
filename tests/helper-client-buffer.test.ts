import { describe, expect, it, vi } from 'vitest'
import { HelperClient, type HelperHandshake } from '../electron/main/helper/client'

const handshake: HelperHandshake = {
  protocol: 1,
  helperVersion: 'test',
  arch: 'x86_64',
  capabilities: ['selection.uia', 'selection.clipboard', 'capture.native-overlay', 'capture.editor.in-place-translation', 'capture.gdi', 'image.translate.render', 'ahk.worker'],
  dllSha256: 'test',
  dllVersion: 'test'
}

describe('HelperClient process framing buffer', () => {
  it('drops stale incremental parser state before a new start and when a helper exits', async () => {
    const logger = { log: vi.fn() }
    const client = new HelperClient(logger as any, '/resources', '/user-data', true)
    const internals = client as any

    internals.stdoutHeaderBytes = 3
    internals.stdoutFrame = Buffer.from([0xff, 0xff, 0xff])
    internals.stdoutFrameBytes = 2
    client.supported = () => true
    internals.startProcess = async () => {
      expect(internals.stdoutHeaderBytes).toBe(0)
      expect(internals.stdoutFrame).toBeUndefined()
      expect(internals.stdoutFrameBytes).toBe(0)
      return handshake
    }
    await client.start()

    internals.stdoutHeaderBytes = 2
    internals.stdoutFrame = Buffer.from([1, 2, 3, 4])
    internals.stdoutFrameBytes = 3
    internals.handleExit(new Error('test helper exit'))
    expect(internals.stdoutHeaderBytes).toBe(0)
    expect(internals.stdoutFrame).toBeUndefined()
    expect(internals.stdoutFrameBytes).toBe(0)
  })
})
