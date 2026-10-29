import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    // @vantage/* workspace packages ship TS source (no build step, no
    // compiled entry point) — externalizing them makes Node's ESM loader try
    // to resolve their relative imports at runtime and fail. Bundle those;
    // externalize everything else (Electron, zod, node builtins).
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@vantage/ai-provider',
          '@vantage/agent-core',
          '@vantage/ai-search',
          '@vantage/docx-engine',
          '@vantage/file-parse',
          '@vantage/electron-utils',
          '@vantage/i18n',
          '@vantage/pptx-render',
          '@vantage/xlsx-gateway',
        ],
      }),
    ],
  },
  preload: {
    // Sandboxed preload scripts cannot require arbitrary npm packages at
    // runtime, so the drop-open bridge must be bundled, not externalized.
    plugins: [externalizeDepsPlugin({ exclude: ['@vantage/electron-utils'] })],
  },
  renderer: {
    plugins: [react()],
  },
})
