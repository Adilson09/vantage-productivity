import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// resolve sibling source packages by path (not via node_modules), so a git
// worktree whose node_modules is linked to another checkout still tests
// against this checkout's edits (same convention as packages/pdf2docx)
const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@vantage/docx-engine/lazy-media': local('../../packages/docx-engine/src/lazy-media.ts'),
      '@vantage/docx-engine': local('../../packages/docx-engine/src/index.ts'),
      '@vantage/font-metrics/resolve': local('../../packages/font-metrics/src/resolve.ts'),
      '@vantage/font-metrics/word-faces.json': local('../../packages/font-metrics/word-faces.json'),
      '@vantage/font-metrics': local('../../packages/font-metrics/src/index.ts'),
      // subpath before the bare name: string aliases are prefix replacements
      '@vantage/electron-utils/headless-export': local(
        '../../packages/electron-utils/src/headless-export.ts',
      ),
      '@vantage/electron-utils/atomic-write': local(
        '../../packages/electron-utils/src/atomic-write.ts',
      ),
      '@vantage/electron-utils/safe-external-url': local(
        '../../packages/electron-utils/src/safe-external-url.ts',
      ),
      '@vantage/electron-utils/print-job': local('../../packages/electron-utils/src/print-job.ts'),
      '@vantage/electron-utils': local('../../packages/electron-utils/src/index.ts'),
      '@vantage/ai-provider/browser': local('../../packages/ai-provider/src/browser.ts'),
      '@vantage/ai-provider': local('../../packages/ai-provider/src/index.ts'),
      '@vantage/i18n': local('../../packages/i18n/src/index.ts'),
      '@vantage/ui': local('../../packages/ui/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // the engine's display-only `effective` keys stay out of saved-model toEqual
    setupFiles: [local('../../packages/docx-engine/tests/setup-equality.ts')],
    environment: 'jsdom',
    testTimeout: 20000,
  },
})
