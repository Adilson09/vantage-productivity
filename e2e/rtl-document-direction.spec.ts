// Vantage Productivity modification (2026): use editor names without depending on launcher order.
import { test, expect, type Page } from '@playwright/test'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

/**
 * An RTL UI must mirror the chrome, never the document (vantage#1861).
 *
 * `dir="rtl"` on <html> is inherited by everything, so an English document
 * opened under the Arabic UI was laid out — and, for the canvas editors, drawn —
 * right-to-left on screen while its saved content stayed left-to-right. The six
 * document surfaces pin `direction: ltr`; these cases assert the *computed*
 * style, which is what Konva and Univer pick up through their inherited
 * `ctx.direction`.
 */

/** Stable accessible names keep these language tests independent of card order. */
const APPS = [
  { name: 'docs', launcher: 'Create document', url: '://docs/', host: '.editor-scroll' },
  { name: 'sheets', launcher: 'Create spreadsheet', url: '://sheets/', host: '#univer-container' },
  { name: 'slides', launcher: 'Create presentation', url: '://slides/', host: '.stage-wrap' },
  { name: 'markdown', launcher: 'Create Markdown', url: '://markdown/', host: '.editor-scroll' },
  { name: 'html', launcher: 'Create HTML', url: '://html/', host: '.preview-stage' },
  { name: 'pdf', launcher: 'Create PDF', url: '://pdf/', host: '.pdf-scroll' },
] as const

const directionOf = (page: Page, host: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)
    return el ? getComputedStyle(el).direction : null
  }, host)

test('the UI chrome itself mirrors under ar', async () => {
  test.setTimeout(180_000)
  const launched = await launchShell({ onboardingSeen: true, lang: 'ar', videoDir: 'rtl-chrome' })
  try {
    await expect(launched.page.locator('html')).toHaveAttribute('dir', 'rtl')
  } finally {
    await closeAndSaveVideo(launched, 'rtl-chrome')
  }
})

for (const { name, launcher, url, host } of APPS) {
  test(`${name}: a new document's surface stays ltr`, async () => {
    test.setTimeout(240_000)
    const launched = await launchShell({
      onboardingSeen: true,
      lang: 'ar',
      videoDir: `rtl-${name}`,
    })
    try {
      await launched.page.getByRole('button', { name: launcher, exact: true }).click()
      const page = await waitForPageWithUrl(launched.app, url)
      const surface = page.locator(host).first()
      await expect(surface).toBeVisible({ timeout: 45_000 })
      // the assertion the review asked for
      expect(await directionOf(page, host)).toBe('ltr')
      // and what depends on it: an RTL scroller reports a negative scrollLeft,
      // which is what sent zoom-to-cursor jumping in docs, pdf and slides
      const scrollLeft = await surface.evaluate((el) => el.scrollLeft)
      expect(scrollLeft).toBeGreaterThanOrEqual(0)
    } finally {
      await closeAndSaveVideo(launched, `rtl-${name}`)
    }
  })
}
