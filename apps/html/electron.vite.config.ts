import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  // @vantage/i18n and @vantage/electron-utils ship as TS source — must be bundled
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'html-draft-worker': resolve(__dirname, 'src/main/html-draft-worker.ts'),
        },
      },
    },
    plugins: [externalizeDepsPlugin({ exclude: ['@vantage/i18n', '@vantage/electron-utils'] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@vantage/i18n', '@vantage/electron-utils'] })],
  },
  renderer: {
    plugins: [react()],
    server: {
      port: Number(process.env.HTML_DEV_PORT) || 5178,
      strictPort: Boolean(process.env.HTML_DEV_PORT),
    },
  },
})
