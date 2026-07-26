import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import { createSvgIconsPlugin } from 'vite-plugin-svg-icons'
import ElementPlus from 'unplugin-element-plus/vite'

export default defineConfig({
  base: './',
  clearScreen: false,
  plugins: [
    vue(),
    vueJsx(),
    createSvgIconsPlugin({
      iconDirs: [resolve(process.cwd(), 'src/icons')],
      symbolId: 'icon-[name]'
    }),
    ElementPlus({})
  ],
  server: {
    host: '127.0.0.1',
    port: 8080,
    strictPort: true,
    open: false
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'chrome150',
    minify: 'esbuild',
    sourcemap: false
  }
})
