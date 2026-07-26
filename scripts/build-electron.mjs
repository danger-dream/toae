import { build } from 'esbuild'
import { rm, mkdir } from 'node:fs/promises'

await rm('dist-electron', { recursive: true, force: true })
await mkdir('dist-electron/main', { recursive: true })
await mkdir('dist-electron/preload', { recursive: true })

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: true,
  sourcesContent: false,
  legalComments: 'none',
  external: ['electron'],
  logLevel: 'info'
}

await Promise.all([
  build({
    ...common,
    entryPoints: ['electron/main/index.ts'],
    outfile: 'dist-electron/main/index.cjs'
  }),
  build({
    ...common,
    entryPoints: ['electron/preload/index.ts'],
    outfile: 'dist-electron/preload/index.cjs'
  })
])
