import { spawn } from 'node:child_process'
import process from 'node:process'
import electronPath from 'electron'

const children = new Set()
function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', shell: false, ...options })
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}
function stop(code = 0) {
  for (const child of children) child.kill('SIGTERM')
  setTimeout(() => process.exit(code), 100).unref()
}
process.once('SIGINT', () => stop(130))
process.once('SIGTERM', () => stop(143))

const build = run(process.execPath, ['scripts/build-electron.mjs'])
const buildCode = await new Promise(resolve => build.once('exit', resolve))
if (buildCode !== 0) process.exit(Number(buildCode) || 1)

const vite = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['exec', '--', 'vite', '--host', '127.0.0.1', '--port', '8080', '--strictPort'])
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    const response = await fetch('http://127.0.0.1:8080/')
    if (response.ok) break
  } catch { /* Vite is still starting */ }
  if (attempt === 99) stop(1)
  await new Promise(resolve => setTimeout(resolve, 100))
}

const electron = run(electronPath, ['.'], {
  env: { ...process.env, TOAE_DEV_SERVER_URL: 'http://127.0.0.1:8080/' }
})
electron.once('exit', code => stop(code ?? 0))
vite.once('exit', code => { if (code) stop(code) })
