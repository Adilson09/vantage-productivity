// Vantage Productivity modification (2026): verify the six named launchers and retained navigation.
import { test, expect } from '@playwright/test'
import { launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

test.describe('home screen', () => {
  test('shows the Vantage workspace, six creation launchers and tab bar', async () => {
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'home-basics' })
    const { page } = launched
    try {
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      const creation = page.getByRole('group', { name: 'Create a file', exact: true })
      await expect(creation.getByRole('button')).toHaveCount(6)
      for (const name of [
        'Create document',
        'Create spreadsheet',
        'Create presentation',
        'Create PDF',
        'Create Markdown',
        'Create HTML',
      ]) {
        await expect(creation.getByRole('button', { name, exact: true })).toBeVisible()
      }
      await expect(page.getByRole('button', { name: 'Open file', exact: true })).toBeVisible()
      await expect(page.locator('.tab-bar .tab-item.tab-home')).toBeVisible()
      await page.screenshot({ path: screenshotPath('home-overview') })
    } finally {
      await closeAndSaveVideo(launched, 'home-basics')
    }
  })

  test('renders localized UI when VANTAGE_LANG=zh-CN', async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      lang: 'zh-CN',
      videoDir: 'home-zh-cn',
    })
    const { page } = launched
    try {
      await expect(page.locator('.nav-item .nav-label').first()).toHaveText('最近')
      await page.screenshot({ path: screenshotPath('home-zh-cn') })
    } finally {
      await closeAndSaveVideo(launched, 'home-zh-cn')
    }
  })
})
