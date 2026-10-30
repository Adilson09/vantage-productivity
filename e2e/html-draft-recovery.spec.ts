import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, type LaunchedApp } from './helpers'
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
async function crashOwned(launched: LaunchedApp): Promise<void> {
  const child = launched.app.process()
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    throw new Error('The owned HTML application exited before crash injection')
  if (process.platform === 'win32')
    await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
    })
  else child.kill('SIGKILL')
  await expect
    .poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 30000 })
    .toBe(true)
}
async function scratch() {
  const parent = resolve(process.env.VANTAGE_VALIDATION_TEMP || tmpdir()),
    directory = await mkdtemp(join(parent, 'vantage-html-draft-e2e-')),
    profile = join(directory, 'profile'),
    documents = join(directory, 'documents')
  await mkdir(profile)
  await mkdir(documents)
  return {
    directory,
    profile,
    documents,
    async cleanup() {
      const part = relative(parent, resolve(directory))
      if (!part || part === '..' || part.startsWith('..' + sep))
        throw new Error('Unexpected HTML validation directory')
      await rm(directory, { recursive: true, force: true })
    },
  }
}
async function htmlDrafts(launched: LaunchedApp) {
  return launched.page.evaluate(async () =>
    (await window.vantage!.draftList()).filter((entry) => entry.module === 'html'),
  )
}
async function restoreCopy(launched: LaunchedApp, id: string, path: string) {
  await launched.app.evaluate(({ dialog }, destination) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath: destination,
    })) as typeof dialog.showSaveDialog
  }, path)
  expect(
    await launched.page.evaluate(async (draftId) => window.vantage!.restoreDraft(draftId), id),
  ).toBe(path)
}
test('HTML unnamed typing with AutoSave off survives the real timer, active discard, owned crash and separate-copy reopen', async () => {
  test.setTimeout(480000)
  const f = await scratch(),
    original = await launchShell({
      userDataDir: f.profile,
      onboardingSeen: true,
      settings: { defaultSaveDir: f.documents },
      videoDir: 'html-draft-before-crash',
    })
  let crashed = false,
    restarted: LaunchedApp | undefined
  try {
    await original.page.getByRole('button', { name: 'Create HTML', exact: true }).click()
    const html = await waitForPageWithUrl(original.app, '://html/')
    await expect(html.locator('.ribbon-body')).toBeVisible()
    const toggle = html.locator('.autosave-toggle input[type="checkbox"]')
    if (await toggle.isChecked()) await html.locator('.autosave-toggle').click()
    await expect(toggle).not.toBeChecked()
    await html.locator('.rb-view', { hasText: /Source/ }).click()
    const editor = html.locator('.source-editor .cm-content')
    await editor.click()
    await html.keyboard.type(
      '<!doctype html><html><body><p>Unnamed real typing survives recovery.</p></body></html>',
    )
    // Production timer only: no recovery invoke, forced serialization or blur.
    await expect
      .poll(async () => (await htmlDrafts(original)).length, {
        timeout: 90000,
        intervals: [1000, 2000, 5000],
      })
      .toBe(1)
    const [discarded] = await htmlDrafts(original)
    expect(discarded.documentPath).toBeNull()
    expect(await readdir(f.documents)).toEqual([])
    await original.page.evaluate(async (id) => window.vantage!.discardDraft(id), discarded.id)
    await html.waitForTimeout(35000)
    expect(await htmlDrafts(original)).toHaveLength(0)
    await editor.click()
    await html.keyboard.press('ControlOrMeta+End')
    await html.keyboard.type('<!-- fresh edit after explicit discard -->')
    await expect
      .poll(async () => (await htmlDrafts(original)).length, {
        timeout: 90000,
        intervals: [1000, 2000, 5000],
      })
      .toBe(1)
    const [draft] = await htmlDrafts(original)
    expect(draft.id).not.toBe(discarded.id)
    expect(draft.documentPath).toBeNull()
    expect(await readdir(f.documents)).toEqual([])
    const manifest = JSON.parse(
      await readFile(join(f.profile, 'recovery', 'drafts', draft.id + '.json'), 'utf8'),
    ) as { sha256: string }
    await crashOwned(original)
    crashed = true
    restarted = await launchShell({ userDataDir: f.profile, videoDir: 'html-draft-after-crash' })
    const path = join(f.directory, 'recovered-unnamed.html')
    await restoreCopy(restarted, draft.id, path)
    const bytes = await readFile(path)
    expect(digest(bytes)).toBe(manifest.sha256)
    expect(bytes.toString()).toContain('Unnamed real typing survives recovery.')
    expect(bytes.toString()).toContain('fresh edit after explicit discard')
    await restarted.page.evaluate(async (path) => window.aiOffice.openPath(path), path)
    const reopened = await waitForPageWithUrl(restarted.app, '://html/')
    await expect(reopened.frameLocator('.preview-frame').locator('p')).toHaveText(
      'Unnamed real typing survives recovery.',
    )
    await test.info().attach('html-unnamed-recovery-proof', {
      body: Buffer.from(
        JSON.stringify(
          {
            autoSave: false,
            normalFilesPublished: 0,
            realTimer: true,
            activeDiscardStayedDiscarded: true,
            ownedCrash: true,
            sameProfileRestart: true,
            separateCopyReopened: true,
            sha256: digest(bytes),
          },
          null,
          2,
        ),
      ),
      contentType: 'application/json',
    })
  } finally {
    if (!crashed) await closeAndSaveVideo(original, 'html-draft-before-crash')
    if (restarted) await closeAndSaveVideo(restarted, 'html-draft-after-crash')
    await f.cleanup()
  }
})
test('HTML pending inline and CSS-field edits recover with local assets after the originals are moved', async () => {
  test.setTimeout(420000)
  const f = await scratch(),
    assets = join(f.directory, 'assets')
  await mkdir(assets)
  const source =
    '<!doctype html><html><head><link rel="stylesheet" href="assets/site.css"></head><body><p id="editable">Original <strong>rich</strong> text.</p><img id="picture" src="assets/dot.png"></body></html>'
  const path = join(f.directory, 'page.html')
  await writeFile(path, source)
  await writeFile(join(assets, 'site.css'), 'p{color:rgb(0,0,200)}')
  await writeFile(
    join(assets, 'dot.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    ),
  )
  const original = await launchShell({
    userDataDir: f.profile,
    onboardingSeen: true,
    openFile: path,
    videoDir: 'html-pending-before-crash',
  })
  let crashed = false,
    restarted: LaunchedApp | undefined
  try {
    const html = await waitForPageWithUrl(original.app, '://html/')
    await expect(html.locator('.ribbon-body')).toBeVisible()
    const toggle = html.locator('.autosave-toggle input[type="checkbox"]')
    if (await toggle.isChecked()) await html.locator('.autosave-toggle').click()
    await expect(toggle).not.toBeChecked()
    const paragraph = html.frameLocator('.preview-frame').locator('#editable')
    await paragraph.click()
    await expect(paragraph).toHaveAttribute('contenteditable', 'true')
    await html.keyboard.press('ControlOrMeta+A')
    await html.keyboard.type('Pending inline typing without blur.')
    await expect
      .poll(async () => (await htmlDrafts(original)).length, {
        timeout: 90000,
        intervals: [1000, 2000, 5000],
      })
      .toBe(1)
    await expect(paragraph).toHaveAttribute('contenteditable', 'true')
    expect(await readFile(path, 'utf8')).toBe(source)
    const [first] = await htmlDrafts(original),
      firstManifest = JSON.parse(
        await readFile(join(f.profile, 'recovery', 'drafts', first.id + '.json'), 'utf8'),
      ) as { sha256: string }
    // Focus changes here intentionally commit the earlier inline edit; the CSS
    // field below must remain focused and uncommitted throughout its timer.
    const css = html.locator('.hx-panel input[placeholder^="letter-spacing:"]')
    await css.fill('background: url("unfinished')
    const caret = await css.evaluate((input) => (input as HTMLInputElement).selectionStart)
    await expect
      .poll(
        async () =>
          (
            JSON.parse(
              await readFile(join(f.profile, 'recovery', 'drafts', first.id + '.json'), 'utf8'),
            ) as { sha256: string }
          ).sha256,
        { timeout: 90000, intervals: [1000, 2000, 5000] },
      )
      .not.toBe(firstManifest.sha256)
    await expect(css).toHaveValue('background: url("unfinished')
    expect(await css.evaluate((input) => document.activeElement === input)).toBe(true)
    expect(await css.evaluate((input) => (input as HTMLInputElement).selectionStart)).toBe(caret)
    expect(await readFile(path, 'utf8')).toBe(source)
    const manifest = JSON.parse(
      await readFile(join(f.profile, 'recovery', 'drafts', first.id + '.json'), 'utf8'),
    ) as { sha256: string }
    await crashOwned(original)
    crashed = true
    await rename(assets, join(f.directory, 'assets-moved'))
    restarted = await launchShell({ userDataDir: f.profile, videoDir: 'html-pending-after-crash' })
    const recovered = join(f.directory, 'recovered-pending.html')
    await restoreCopy(restarted, first.id, recovered)
    const bytes = await readFile(recovered)
    expect(digest(bytes)).toBe(manifest.sha256)
    await restarted.page.evaluate(async (path) => window.aiOffice.openPath(path), recovered)
    const opened = await waitForPageWithUrl(restarted.app, '://html/')
    const frame = opened.frameLocator('.preview-frame')
    await expect(frame.locator('#editable')).toHaveText('Pending inline typing without blur.')
    await expect(frame.locator('#editable')).toHaveCSS('color', 'rgb(0, 0, 200)')
    await expect
      .poll(() =>
        frame.locator('#picture').evaluate((node) => (node as HTMLImageElement).naturalWidth),
      )
      .toBe(1)
    await expect(opened.locator('.hx-panel input[placeholder^="letter-spacing:"]')).toHaveValue(
      'background: url("unfinished',
    )
    expect(await readFile(path, 'utf8')).toBe(source)
    await test.info().attach('html-pending-assets-recovery-proof', {
      body: Buffer.from(
        JSON.stringify(
          {
            realTimer: true,
            pendingInlineCapturedWithoutBlur: true,
            pendingCssCapturedWithoutBlur: true,
            focusAndCaretRetained: true,
            originalAssetsMoved: true,
            originalFileUnchanged: true,
            separateCopyReopened: true,
            sha256: digest(bytes),
          },
          null,
          2,
        ),
      ),
      contentType: 'application/json',
    })
  } finally {
    if (!crashed) await closeAndSaveVideo(original, 'html-pending-before-crash')
    if (restarted) await closeAndSaveVideo(restarted, 'html-pending-after-crash')
    await f.cleanup()
  }
})
