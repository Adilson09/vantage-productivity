import { test, expect } from '@playwright/test'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'
import { mkdtemp, writeFile, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A 0-byte office file (touch, aborted download) opens as a blank document
 * that still belongs to its path, so a plain Save writes the file itself
 * instead of failing the parse and silently saving elsewhere.
 */
const KINDS = [
  { ext: 'docx', url: '://docs/', channel: 'menu:command' },
  { ext: 'xlsx', url: '://sheets/', channel: 'menu:action' },
  { ext: 'pptx', url: '://slides/', channel: 'slides:menu' },
]

for (const { ext, url, channel } of KINDS) {
  test(`empty .${ext} opens blank and saves back to its own path`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vantage-empty-'))
    const filePath = join(dir, `empty.${ext}`)
    await writeFile(filePath, '')
    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: `open-empty-${ext}`,
      openFile: filePath,
    })
    const { app } = launched
    try {
      await app.evaluate(({ dialog }) => {
        dialog.showSaveDialog = (async () => {
          throw new Error('Save must not fall back to Save As')
        }) as typeof dialog.showSaveDialog
      })
      const editor = await waitForPageWithUrl(app, url)
      // Vantage Productivity: a navigated WebContents may still be parsing/mounting its
      // editor. Wait for the actual document model instead of a fixed delay.
      if (ext === 'docx') {
        await expect(editor).toHaveTitle('empty.docx', { timeout: 30_000 })
        await expect(editor.locator('.ProseMirror[contenteditable="true"]').first()).toBeVisible({
          timeout: 30_000,
        })
      } else if (ext === 'xlsx') {
        await editor.waitForFunction(() => document.body.textContent?.includes('Sheet1'), null, {
          timeout: 30_000,
        })
        await editor.waitForFunction(
          () =>
            [...document.querySelectorAll('canvas')].some((canvas) => {
              const rect = canvas.getBoundingClientRect()
              return rect.width > 500 && rect.height > 300
            }),
          null,
          { timeout: 30_000 },
        )
        await expect(editor.locator('[data-u-comp="defined-name"] input')).toHaveValue('A1')
      } else {
        await expect(editor.locator('.stage-wrap canvas').first()).toBeVisible({ timeout: 30_000 })
        await expect(editor.locator('.thumb-num').first()).toHaveText('1')
      }
      await app.evaluate(
        ({ webContents }, [u, ch]) => {
          const target = webContents.getAllWebContents().find((w) => w.getURL().includes(u))
          if (!target) throw new Error(`No editor receiver for ${u}`)
          target.send(ch, 'save')
        },
        [url, channel],
      )
      await expect
        .poll(async () => (await stat(filePath)).size, { timeout: 15_000 })
        .toBeGreaterThan(0)
      expect((await readFile(filePath)).subarray(0, 2).toString()).toBe('PK')
      // the tab still shows the file, not an untitled document
      const shellPage = await waitForPageWithUrl(app, 'shell/out')
      await expect(shellPage.locator('.tab-bar .tab-item:not(.tab-home)')).toContainText(
        `empty.${ext}`,
      )
    } finally {
      await closeAndSaveVideo(launched, `open-empty-${ext}`)
    }
  })
}
