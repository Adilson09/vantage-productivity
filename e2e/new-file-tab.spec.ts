// Aster Office modification (2026): use named real editor launchers.
import { test, expect } from '@playwright/test'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'

test.describe('new file from home', () => {
  test('Create document launcher opens a docs editor tab', async () => {
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'new-doc-tab' })
    const { app, page } = launched
    try {
      await expect(page.locator('.tab-bar .tab-home')).toContainText('Aster Office')
      await expect(
        page.getByRole('button', { name: 'Create document', exact: true }),
      ).toContainText('Create document')

      await page.getByRole('button', { name: 'Create document', exact: true }).click()

      const editorTab = page.locator('.tab-bar .tab-item:not(.tab-home)')
      await expect(editorTab).toHaveCount(1)
      await expect(editorTab).toHaveClass(/active/)
      await page.screenshot({ path: screenshotPath('new-doc-tab-bar') })

      // the docs editor loads in a WebContentsView, which surfaces as a new
      // page — poll for it instead of waitForLoadState, which hangs on Linux
      // when Playwright attaches mid-navigation and misses lifecycle events
      const editorPage = await waitForPageWithUrl(app, '://docs/')
      await expect(editorPage.locator('.ProseMirror[contenteditable="true"]').first()).toBeVisible({
        timeout: 30_000,
      })
      await expect(editorPage.getByText(/^Opening(?:\.\.\.|…)$/)).toHaveCount(0)
      await editorPage.screenshot({ path: screenshotPath('new-doc-editor') })
    } finally {
      await closeAndSaveVideo(launched, 'new-doc-tab')
    }
  })
})
