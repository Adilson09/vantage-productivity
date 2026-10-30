import { test, expect } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

test('default Markdown SaveAs retains unchanged raw bytes, then saves and reopens an actual edit', async () => {
  test.setTimeout(180_000)
  const root = await mkdtemp(join(tmpdir(), 'vantage-default-source-e2e-'))
  if (!resolve(root).startsWith(resolve(join(tmpdir(), 'vantage-default-source-e2e-'))))
    throw new Error('Unexpected test folder')
  const sourcePath = join(root, 'original.md'),
    copyPath = join(root, 'copy.md')
  const source =
    '\uFEFF---\r\ntitle: Keep this metadata\n---\r\n\n# Source retention\r\n\r\nEditable paragraph.\n\n<div data-kind="retain">Raw HTML</div>\r\n\n[Manual][ref]\n\n[ref]: https://example.com  "Keep quote"\r\n'
  await writeFile(sourcePath, source)
  const launched = await launchShell({
    onboardingSeen: true,
    openFile: sourcePath,
    videoDir: 'markdown-default-source',
  })
  const failures: unknown[] = []
  try {
    const page = await waitForPageWithUrl(launched.app, '://markdown/')
    const editor = page.locator('.doc-editor')
    await expect(editor.locator('h1')).toHaveText('Source retention')
    expect(await page.evaluate(() => localStorage.getItem('mdapp.experimentalRoundTrip'))).not.toBe(
      '1',
    )
    await launched.app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: path,
      })) as typeof dialog.showSaveDialog
    }, copyPath)
    await page.getByRole('button', { name: 'Save As…', exact: true }).click()
    await expect
      .poll(async () => {
        try {
          return await readFile(copyPath, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
          throw error
        }
      })
      .toBe(source)
    await expect(page.locator('.status-save')).toHaveText(/Saved/)
    expect(await readFile(sourcePath, 'utf8')).toBe(source)
    const paragraph = editor.locator('p').filter({ hasText: 'Editable paragraph.' }).first()
    await paragraph.click()
    await expect(editor).toBeFocused()
    await page.keyboard.press('End')
    await page.keyboard.type(' With a verified edit.')
    await expect(editor).toContainText('With a verified edit.')
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(async () => readFile(copyPath, 'utf8')).toContain('With a verified edit.')
    const written = await readFile(copyPath, 'utf8')
    expect(written).toContain('Keep this metadata')
    expect(written).toContain('<div data-kind="retain">Raw HTML</div>')
    expect(written).toContain('[ref]: https://example.com  "Keep quote"')
    expect(await readFile(sourcePath, 'utf8')).toBe(source)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('.doc-editor')).toContainText('With a verified edit.')
    expect(await page.evaluate(() => localStorage.getItem('mdapp.experimentalRoundTrip'))).not.toBe(
      '1',
    )
  } catch (error) {
    failures.push(error)
  } finally {
    for (const cleanup of [
      () => closeAndSaveVideo(launched, 'markdown-default-source'),
      () => rm(root, { recursive: true, force: true }),
    ]) {
      try {
        await cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1)
    throw new AggregateError(failures, 'Source retention workflow or cleanup failed.', {
      cause: failures[0],
    })
})
