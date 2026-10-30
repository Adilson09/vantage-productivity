import { test, expect, type Page } from '@playwright/test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo } from './helpers'

async function calendarPanel(page: Page) {
  await page
    .getByRole('button', { name: /Tools and privacy/ })
    .first()
    .click()
  const panel = page.getByRole('dialog', { name: 'Tools and privacy', exact: true })
  await panel.getByRole('button', { name: 'Calendar and contacts', exact: true }).click()
  const workspace = panel.getByRole('region', { name: 'Saved calendar workspace', exact: true })
  await expect(workspace.getByRole('button', { name: 'Refresh agenda', exact: true })).toBeEnabled({
    timeout: 120_000,
  })
  return { panel, workspace }
}

test('saves recurring local events, edits one occurrence, exports messages and fences external changes across restart', async () => {
  test.setTimeout(600_000)
  const scratch = await mkdtemp(join(tmpdir(), 'vantage-calendar-workspace-'))
  const original = join(scratch, 'personal.ics'),
    copy = join(scratch, 'separate.ics'),
    message = join(scratch, 'invitation.ics')
  let launched = await launchShell({ onboardingSeen: true, videoDir: 'calendar-workspace' })
  try {
    const { page, app } = launched
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    })
    const { panel, workspace } = await calendarPanel(page)
    await workspace.getByLabel('New calendar name', { exact: true }).fill('Personal calendar')
    await workspace.getByRole('button', { name: 'Add calendar', exact: true }).click()
    await expect(
      workspace.getByRole('combobox', { name: 'Calendar to show', exact: true }),
    ).toContainText('Personal calendar', { timeout: 120_000 })
    await workspace.getByLabel('From date', { exact: true }).fill('2026-11-01')
    await workspace.getByLabel('Through date', { exact: true }).fill('2026-11-30')
    await workspace.getByRole('button', { name: 'Refresh agenda', exact: true }).click()
    await workspace.getByRole('button', { name: 'New event', exact: true }).click()
    const editor = workspace.getByRole('form', { name: 'Calendar event editor', exact: true })
    await editor.getByLabel('Event name', { exact: true }).fill('Weekly planning')
    await editor.getByLabel('Event starts', { exact: true }).fill('2026-11-02T10:00:00')
    await editor.getByLabel('Event ends', { exact: true }).fill('2026-11-02T11:00:00')
    await editor.getByLabel('Event time zone', { exact: true }).fill('America/Toronto')
    await editor.getByRole('combobox', { name: 'Repeats', exact: true }).selectOption('WEEKLY')
    await editor.getByLabel('Number of occurrences, optional', { exact: true }).fill('3')
    await editor.getByLabel('Organizer address', { exact: true }).fill('owner@example.test')
    await editor
      .getByLabel('Attendee addresses, one per line', { exact: true })
      .fill('guest@example.test')
    await editor
      .getByLabel('Prepare a local invitation/update message for the attendees', { exact: true })
      .check()
    await editor.getByRole('button', { name: 'Save event', exact: true }).click()
    await expect(workspace.getByRole('status')).toContainText('Event saved.', { timeout: 120_000 })
    await expect(
      workspace.getByRole('table').getByText('Weekly planning', { exact: true }),
    ).toHaveCount(3)
    await workspace
      .getByRole('table')
      .getByRole('button', { name: 'Edit event', exact: true })
      .first()
      .click()
    await editor.getByLabel('Event time zone', { exact: true }).fill('America/New_York')
    await editor.getByRole('button', { name: 'Save event', exact: true }).click()
    await expect(workspace.getByRole('status')).toContainText('Event updated.', {
      timeout: 120_000,
    })
    await expect(
      workspace.getByRole('table').getByText('Event zone: America/New_York', { exact: true }),
    ).toHaveCount(1)
    await workspace
      .getByRole('table')
      .getByRole('button', { name: 'Edit event', exact: true })
      .nth(1)
      .click()
    await editor.getByLabel('Event location', { exact: true }).fill('Remote room')
    await editor.getByRole('button', { name: 'Save event', exact: true }).click()
    await expect(workspace.getByRole('status')).toContainText('Event updated.', {
      timeout: 120_000,
    })
    await expect(
      workspace.getByRole('table').getByText('Remote room', { exact: true }),
    ).toHaveCount(1)
    await workspace
      .getByRole('table')
      .getByRole('button', { name: 'Edit event', exact: true })
      .last()
      .click()
    await editor.getByLabel('Event name', { exact: true }).fill('One-off check-in')
    await editor.getByRole('button', { name: 'Save as a new event', exact: true }).click()
    await expect(workspace.getByRole('status')).toContainText('Event saved.', { timeout: 120_000 })
    await expect(
      workspace.getByRole('table').getByText('One-off check-in', { exact: true }),
    ).toHaveCount(1)
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    }, message)
    await workspace.getByRole('button', { name: 'Export message', exact: true }).first().click()
    await expect(workspace.getByRole('status')).toContainText('exported', { timeout: 120_000 })
    expect(await readFile(message, 'utf8')).toContain('METHOD:REQUEST')
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    }, original)
    await workspace.getByRole('button', { name: 'Export calendar copy', exact: true }).click()
    await expect(workspace.getByRole('status')).toContainText('exported to a new file.', {
      timeout: 120_000,
    })
    const exported = await readFile(original, 'utf8')
    expect(exported).toContain('America/Toronto')
    expect(exported).toContain('RECURRENCE-ID')
    const external = exported + '\r\nExternal edit retained\r\n'
    await writeFile(original, external)
    await workspace.getByRole('button', { name: 'Update linked file', exact: true }).click()
    await expect(workspace.getByRole('alert')).toContainText('destination changed', {
      timeout: 120_000,
    })
    expect(await readFile(original, 'utf8')).toBe(external)
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    }, copy)
    await workspace.getByRole('button', { name: 'Export calendar copy', exact: true }).click()
    await expect(workspace.getByRole('status')).toContainText('exported to a new file.', {
      timeout: 120_000,
    })
    expect(await readFile(copy, 'utf8')).toBe(exported)
    expect(await readFile(original, 'utf8')).toBe(external)
    await workspace.getByRole('button', { name: 'New event', exact: true }).click()
    await editor.getByLabel('Event name', { exact: true }).fill('Unsaved idea')
    await panel.getByRole('button', { name: 'Privacy', exact: true }).click()
    await page.keyboard.press('Escape')
    const warning = panel.getByRole('alertdialog', {
      name: 'Unsaved calendar changes',
      exact: true,
    })
    await expect(warning).toBeVisible()
    await expect(
      warning.getByRole('button', { name: 'Keep editing calendar', exact: true }),
    ).toBeFocused()
    await warning.getByRole('button', { name: 'Keep editing calendar', exact: true }).click()
    await panel.getByRole('button', { name: 'Calendar and contacts', exact: true }).click()
    await expect(editor.getByLabel('Event name', { exact: true })).toHaveValue('Unsaved idea')
    await editor.getByRole('button', { name: 'Cancel event editing', exact: true }).click()
    const profile = launched.userDataDir
    await closeAndSaveVideo(launched, 'calendar-workspace')
    launched = await launchShell({ userDataDir: profile, videoDir: 'calendar-workspace-restart' })
    const reopened = await calendarPanel(launched.page)
    await reopened.workspace.getByLabel('From date', { exact: true }).fill('2026-11-01')
    await reopened.workspace.getByLabel('Through date', { exact: true }).fill('2026-11-30')
    await reopened.workspace.getByRole('button', { name: 'Refresh agenda', exact: true }).click()
    await expect(
      reopened.workspace.getByRole('table').getByText('Weekly planning', { exact: true }),
    ).toHaveCount(3, { timeout: 120_000 })
    await expect(
      reopened.workspace.getByRole('table').getByText('Remote room', { exact: true }),
    ).toHaveCount(1)
  } finally {
    await closeAndSaveVideo(launched, 'calendar-workspace-final').catch(() => {})
  }
})
