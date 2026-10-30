import { test, expect } from '@playwright/test'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

test.describe('integrated local productivity tools', () => {
  test('creates a calendar through the actual event form and reopens its event', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'vantage-calendar-create-'))
    const path = join(scratch, 'created.ics')
    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'engineering-calendar-create',
    })
    try {
      const { page, app } = launched
      await app.evaluate(({ dialog }, destination) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
      }, path)
      await page
        .getByRole('button', { name: /Tools and privacy/ })
        .first()
        .click()
      const panel = page.getByRole('dialog', { name: 'Tools and privacy', exact: true })
      await panel.getByRole('button', { name: 'Calendar and contacts', exact: true }).click()
      await panel.getByText('Calendar files and contacts', { exact: true }).click()
      await panel.getByLabel('Event title', { exact: true }).fill('Local planning session')
      await panel
        .getByLabel('Starts at (your local time)', { exact: true })
        .fill('2026-11-02T10:00')
      await panel.getByLabel('Ends at (your local time)', { exact: true }).fill('2026-11-02T11:00')
      await panel.getByRole('button', { name: 'Save new calendar', exact: true }).click()
      await expect(panel.getByRole('status').filter({ hasText: 'Calendar created:' })).toBeVisible()
      const bytes = await readFile(path, 'utf8')
      expect(bytes).toContain('BEGIN:VCALENDAR')
      expect(bytes).toContain('SUMMARY:Local planning session')
      const expectedStart = await page.evaluate(() =>
        new Date('2026-11-02T10:00').toISOString().replace(/[-:]/g, '').replace('.000', ''),
      )
      expect(bytes).toContain(`DTSTART:${expectedStart}`)
    } finally {
      await closeAndSaveVideo(launched, 'engineering-calendar-create')
    }
  })
  test('runs the installed qpdf against malformed PDF bytes without changing the source', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'vantage-qpdf-ui-'))
    const path = join(scratch, 'malformed.pdf')
    const source = '%PDF-1.7\nThis is not a PDF object tree.\n%%EOF\n'
    await writeFile(path, source)
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'engineering-qpdf' })
    try {
      const { page, app } = launched
      const engines = await page.evaluate(() => window.vantage!.engineeringStatus())
      test.skip(
        !engines.engines.some((e) => e.id === 'qpdf' && e.available),
        'qpdf is not installed for this candidate; structural native acceptance remains unavailable.',
      )
      await app.evaluate(({ dialog }, destination) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] })
      }, path)
      await page
        .getByRole('button', { name: /Tools and privacy/ })
        .first()
        .click()
      const panel = page.getByRole('dialog', { name: 'Tools and privacy', exact: true })
      await panel.getByRole('button', { name: 'Document engines', exact: true }).click()
      await panel.getByRole('button', { name: 'Check PDF structure', exact: true }).click()
      await expect(panel.getByRole('status')).toHaveText('qpdf: fail.')
      expect(await readFile(path, 'utf8')).toBe(source)
    } finally {
      await closeAndSaveVideo(launched, 'engineering-qpdf')
    }
  })
  test('persists remote permissions, blocks main fetch, and contains keyboard focus at 200% zoom', async () => {
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'engineering-privacy' })
    try {
      const { page, app, userDataDir } = launched
      await page
        .getByRole('button', { name: /Tools and privacy/ })
        .first()
        .click()
      const panel = page.getByRole('dialog', { name: 'Tools and privacy', exact: true })
      await expect(
        panel.getByRole('heading', { name: 'You choose which services can connect' }),
      ).toBeVisible()
      const localMode = panel.getByLabel(
        'Local mode: block remote requests from the document workspace',
      )
      await expect(localMode).toBeChecked()
      const decision = await app.evaluate(async () => {
        try {
          await fetch('https://example.invalid/privacy-test')
          return 'unexpected connection'
        } catch (e) {
          return String(e)
        }
      })
      expect(decision).toContain('Local mode')
      await panel.getByRole('button', { name: 'Save privacy choices', exact: true }).click()
      await expect(panel.getByRole('status')).toContainText('Privacy choices saved')
      expect(
        JSON.parse(await readFile(join(userDataDir, 'app-settings.json'), 'utf8')).networkPolicy
          .localOnly,
      ).toBe(true)
      await page.evaluate(() => {
        document.documentElement.style.zoom = '2'
      })
      await panel.getByRole('button', { name: 'Save privacy choices', exact: true }).focus()
      await page.keyboard.press('Tab')
      await expect(panel.getByRole('button', { name: 'Close dialog', exact: true })).toBeFocused()
      await mkdir(join(screenshotPath('engineering-privacy'), '..'), { recursive: true })
      await page.screenshot({ path: screenshotPath('engineering-privacy'), fullPage: true })
      await page.keyboard.press('Escape')
      await expect(panel).toHaveCount(0)
    } finally {
      await closeAndSaveVideo(launched, 'engineering-privacy')
    }
  })
  test('creates a real SQLite database, enters a record and reopens its saved bytes', async () => {
    test.setTimeout(120_000)
    const scratch = await mkdtemp(join(tmpdir(), 'vantage-db-ui-'))
    const path = join(scratch, 'records.vdb')
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'engineering-database' })
    try {
      const { page, app } = launched
      await app.evaluate(({ dialog }, destination) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
      }, path)
      await page
        .getByRole('button', { name: /Tools and privacy/ })
        .first()
        .click()
      const panel = page.getByRole('dialog', { name: 'Tools and privacy', exact: true })
      await panel.getByRole('button', { name: 'Database', exact: true }).click()
      await panel.getByRole('button', { name: 'Create database', exact: true }).click()
      await expect(panel.getByRole('status')).toHaveText('Database created.')
      await panel.getByRole('button', { name: 'Create table', exact: true }).click()
      await expect(panel.getByRole('status')).toHaveText('Table created.')
      await panel.getByLabel('Name', { exact: true }).fill('Ada Lovelace')
      await panel.getByLabel('Notes', { exact: true }).fill('First integrated database record')
      await panel.getByRole('button', { name: 'Add record', exact: true }).click()
      await expect(panel.getByRole('status')).toHaveText('Record added.')
      await panel.getByRole('button', { name: 'View records', exact: true }).click()
      await expect(panel.getByRole('cell', { name: 'Ada Lovelace', exact: true })).toBeVisible()
      expect((await readFile(path)).subarray(0, 15).toString()).toBe('SQLite format 3')
      await app.evaluate(({ dialog }, destination) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] })
      }, path)
      await panel.getByRole('button', { name: 'Open database', exact: true }).click()
      await expect(panel.getByRole('status')).toHaveText('Database opened.')
      await panel.getByRole('button', { name: 'View records', exact: true }).click()
      await expect(panel.getByRole('cell', { name: 'Ada Lovelace', exact: true })).toBeVisible()
    } finally {
      await closeAndSaveVideo(launched, 'engineering-database')
    }
  })
  test('imports an actual local recurring calendar and leaves source bytes unchanged', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'vantage-calendar-ui-'))
    const path = join(scratch, 'calendar.ics')
    const stamp = new Date(Date.now() + 86400000).toISOString().slice(0, 10).replaceAll('-', '')
    const source = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Vantage Test//EN\r\nBEGIN:VEVENT\r\nUID:local-recurrence\r\nDTSTAMP:${stamp}T090000Z\r\nDTSTART:${stamp}T090000Z\r\nDTEND:${stamp}T100000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Engine planning\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`
    await writeFile(path, source)
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'engineering-calendar' })
    try {
      const { page, app } = launched
      await app.evaluate(({ dialog }, destination) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] })
      }, path)
      await page
        .getByRole('button', { name: /Tools and privacy/ })
        .first()
        .click()
      const panel = page.getByRole('dialog', { name: 'Tools and privacy', exact: true })
      await panel.getByRole('button', { name: 'Calendar and contacts', exact: true }).click()
      await panel.getByText('Calendar files and contacts', { exact: true }).click()
      await panel.getByRole('button', { name: 'Open calendar', exact: true }).click()
      await expect(
        panel.getByRole('status').filter({ hasText: '3 calendar occurrences loaded.' }),
      ).toBeVisible()
      await expect(panel.getByText('Engine planning', { exact: true })).toHaveCount(3)
      expect(await readFile(path, 'utf8')).toBe(source)
    } finally {
      await closeAndSaveVideo(launched, 'engineering-calendar')
    }
  })
})
