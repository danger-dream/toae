import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const source = resolve('native-helper/target/x86_64-pc-windows-gnu/release/native-helper.exe')
const outputDirectory = resolve('resources/win32-x64')
const output = resolve(outputDirectory, 'native-helper.exe')
await mkdir(outputDirectory, { recursive: true })
await copyFile(source, output)

const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const manifest = {
  protocol: 1,
  arch: 'x86_64',
  helperSha256: await digest(output),
  dllSha256: await digest(resolve(outputDirectory, 'AutoHotkey_H.dll')),
  defaultScriptSha256: await digest(resolve('resources/default-script.ahk'))
}
await writeFile(resolve(outputDirectory, 'resource-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify(manifest, null, 2))
