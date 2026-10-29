// Vantage Productivity addition (2026): exercise real workspace controls and local audit IPC.
import { test, expect } from '@playwright/test'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { RecoveryEntry } from '../apps/shell/src/shared/vantage-api'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

test.describe('Vantage workspace', () => {
  test('command keyboard navigation contains focus, runs a tool and restores focus', async () => {
    test.setTimeout(120_000)
    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'vantage-command-keyboard',
    })
    const { page } = launched
    try {
      const trigger = page.getByRole('button', { name: 'Find a command', exact: true })
      await trigger.focus()
      await page.keyboard.press('ControlOrMeta+k')
      const palette = page.getByRole('dialog', { name: 'What would you like to do?', exact: true })
      const input = palette.getByRole('combobox', { name: 'Search commands', exact: true })
      const options = palette.getByRole('option')
      await expect(input).toBeFocused()
      const firstId = await options.nth(0).getAttribute('id')
      const secondId = await options.nth(1).getAttribute('id')
      expect(firstId).toBeTruthy()
      expect(secondId).toBeTruthy()
      await expect(input).toHaveAttribute('aria-activedescendant', firstId!)
      await page.keyboard.press('ArrowDown')
      await expect(input).toHaveAttribute('aria-activedescendant', secondId!)
      await page.keyboard.press('ArrowUp')
      await expect(input).toHaveAttribute('aria-activedescendant', firstId!)

      await input.fill('inspect')
      await expect(options).toHaveCount(1)
      await page.keyboard.press('Enter')
      await expect(palette).toHaveCount(0)
      const inspector = page.getByRole('dialog', {
        name: 'A clearer view of your document',
        exact: true,
      })
      const choose = inspector.getByRole('button', { name: 'Choose a file to check', exact: true })
      const close = inspector.getByRole('button', { name: 'Close dialog', exact: true })
      await expect(choose).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(close).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(choose).toBeFocused()
      await page.keyboard.press('ControlOrMeta+k')
      await expect(page.getByRole('dialog')).toHaveCount(1)
      await page.keyboard.press('Escape')
      await expect(inspector).toHaveCount(0)
      await expect(trigger).toBeFocused()
    } finally {
      await closeAndSaveVideo(launched, 'vantage-command-keyboard')
    }
  })

  test('inspects a real Markdown file without changing it and reports picker cancellation', async () => {
    test.setTimeout(120_000)
    const scratch = await mkdtemp(join(tmpdir(), 'vantage-inspector-'))
    const file = join(scratch, 'inspected-note.md')
    const source = '# Vantage sample\n\nA local file for structural inspection.\n'
    await writeFile(file, source, 'utf8')
    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'vantage-local-inspector',
    })
    const { app, page } = launched
    try {
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [path],
        })) as typeof dialog.showOpenDialog
      }, file)
      await page.getByRole('button', { name: /A clearer view before you share/ }).click()
      const inspector = page.getByRole('dialog', {
        name: 'A clearer view of your document',
        exact: true,
      })
      await inspector.getByRole('button', { name: 'Choose a file to check', exact: true }).click()
      await expect(
        inspector.getByRole('heading', { name: 'inspected-note.md', exact: true }),
      ).toBeVisible()
      await expect(inspector.locator('.vantage-result-file p')).toHaveText(file)
      await expect(inspector.getByRole('status')).toHaveText(
        'Inspection complete: inspected-note.md',
      )
      await expect(inspector.locator('.vantage-check-list')).toBeVisible()
      expect(await readFile(file, 'utf8')).toBe(source)

      await app.evaluate(({ dialog }) => {
        dialog.showOpenDialog = (async () => ({
          canceled: true,
          filePaths: [],
        })) as typeof dialog.showOpenDialog
      })
      await inspector.getByRole('button', { name: 'Check another file', exact: true }).click()
      await expect(inspector.getByRole('status')).toHaveText(
        'Inspection cancelled. The previous inspection remains below.',
      )
      await expect(
        inspector.getByRole('heading', { name: 'inspected-note.md', exact: true }),
      ).toBeVisible()
      expect(await readFile(file, 'utf8')).toBe(source)
    } finally {
      await closeAndSaveVideo(launched, 'vantage-local-inspector')
    }
  })

  test('shows the actual empty recovery list and its bounded storage policy', async () => {
    test.setTimeout(120_000)
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'vantage-empty-recovery' })
    const { page } = launched
    try {
      const entrance = page.getByRole('button', { name: /A way back to your work/ })
      await entrance.click()
      const vault = page.getByRole('dialog', { name: 'A way back to your work', exact: true })
      await expect(vault.getByRole('status')).toHaveText('0 recorded snapshots')
      await expect(
        vault.getByRole('heading', { name: 'No snapshots recorded yet.', exact: true }),
      ).toBeVisible()
      await expect(
        vault.getByRole('list', { name: 'Recorded recovery snapshots', exact: true }),
      ).toHaveCount(0)
      const policy = vault.getByRole('complementary', { name: 'Recovery limits', exact: true })
      await expect(policy).toContainText('Previous versions larger than 32 MiB are excluded.')
      await expect(policy).toContainText('128 MiB of document data')
      await expect(policy).toContainText('plus snapshot metadata')
      await expect(policy).toContainText('Existing plaintext history remains unencrypted.')
      await expect(vault.getByRole('button', { name: 'Refresh', exact: true })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(vault).toHaveCount(0)
      await expect(entrance).toBeFocused()
    } finally {
      await closeAndSaveVideo(launched, 'vantage-empty-recovery')
    }
  })

  test('recovers the previous version captured by a real Markdown editor save', async () => {
    test.setTimeout(180_000)
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'vantage-editor-recovery-')))
    const file = join(scratch, 'live-note.md')
    const recovered = join(scratch, 'recovered-note.md')
    const original = '# Original note\n\nKeep this saved version.\n'
    await writeFile(file, original, 'utf8')
    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'vantage-editor-recovery',
      openFile: file,
    })
    const { app } = launched
    try {
      const shell = await waitForPageWithUrl(app, 'shell/out')
      const editorPage = await waitForPageWithUrl(app, '://markdown/')
      const editor = editorPage.locator('.doc-editor')
      await expect(editor.locator('h1')).toHaveText('Original note')
      await editor.focus()
      // Match the editor's existing save test: shell focus can arrive late,
      // so confirm the caret remains in the last block before real typing.
      await expect
        .poll(async () => {
          await editor.evaluate((element) => {
            const last = element.lastElementChild
            const selection = window.getSelection()
            if (!last || !selection) throw new Error('Markdown editor has no final block')
            const range = document.createRange()
            range.selectNodeContents(last)
            range.collapse(false)
            selection.removeAllRanges()
            selection.addRange(range)
          })
          await editorPage.waitForTimeout(150)
          return editor.evaluate((element) => {
            const selection = window.getSelection()
            return Boolean(
              selection?.isCollapsed &&
              selection.anchorNode &&
              element.lastElementChild?.contains(selection.anchorNode),
            )
          })
        })
        .toBe(true)
      await editorPage.keyboard.press('Enter')
      await editorPage.keyboard.type('Saved by the actual Vantage editor.')
      await editorPage.keyboard.press('ControlOrMeta+s')
      await expect(editorPage.locator('.status-save')).toHaveText(/Saved/)
      await expect
        .poll(() => readFile(file, 'utf8'))
        .toContain('Saved by the actual Vantage editor.')
      const edited = await readFile(file, 'utf8')
      expect(edited).not.toBe(original)

      const snapshots: RecoveryEntry[] = await shell.evaluate(async () =>
        window.vantage!.recoveryList(),
      )
      const previous = snapshots.filter((entry) => entry.originalPath === file)
      expect(previous).toHaveLength(1)
      expect(previous[0]!.sha256).toBe(createHash('sha256').update(original).digest('hex'))
      expect(previous[0]!.bytes).toBe(Buffer.byteLength(original))

      await shell.locator('.tab-bar .tab-item.tab-home').click()
      await shell.getByRole('button', { name: /A way back to your work/ }).click()
      const vault = shell.getByRole('dialog', { name: 'A way back to your work', exact: true })
      const entry = vault.getByRole('listitem').filter({ hasText: 'live-note.md' })
      await expect(entry).toHaveCount(1)
      await app.evaluate(({ dialog }, path) => {
        dialog.showSaveDialog = (async () => ({
          canceled: false,
          filePath: path,
        })) as typeof dialog.showSaveDialog
      }, recovered)
      await entry.getByRole('button', { name: 'Recover a copy', exact: true }).click()
      await expect(vault.getByText('Recovered copy created', { exact: true })).toBeVisible()
      expect(await readFile(recovered, 'utf8')).toBe(original)
      expect(await readFile(file, 'utf8')).toBe(edited)
    } finally {
      await closeAndSaveVideo(launched, 'vantage-editor-recovery')
    }
  })
})
