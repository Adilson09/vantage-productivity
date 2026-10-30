import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import JSZip from 'jszip'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, type LaunchedApp } from './helpers'

test('unnamed Slides text and notes survive the real timer, active discard, owned crash and restore', async () => {
  test.setTimeout(480_000)
  const scratch = await mkdtemp(join(tmpdir(), 'vantage-slides-draft-e2e-'))
  const profile = join(scratch, 'profile')
  const documents = join(scratch, 'documents')
  await mkdir(profile)
  await mkdir(documents)
  const original = await launchShell({
    userDataDir: profile,
    onboardingSeen: true,
    settings: { defaultSaveDir: documents },
    videoDir: 'slides-draft-before-crash',
  })
  let crashed = false
  let restarted: LaunchedApp | undefined
  try {
    await original.page.getByRole('button', { name: 'Create presentation', exact: true }).click()
    const slides = await waitForPageWithUrl(original.app, '://slides/')
    await expect(slides.locator('.stage-wrap canvas').first()).toBeVisible({ timeout: 60_000 })
    const autoSave = slides.locator('.autosave-toggle input[type="checkbox"]')
    if (await autoSave.isChecked()) await slides.locator('.autosave-toggle').click()
    await expect(autoSave).not.toBeChecked()
    await slides.locator('.ribbon-tab', { hasText: /^Insert$/ }).click()
    await slides.locator('.rb-big', { hasText: /^Text Box$/ }).click()
    await slides.locator('.stage-wrap').click({ position: { x: 180, y: 140 } })
    const editor = slides.locator('.slide-text-editor[contenteditable="true"]')
    await expect(editor).toBeVisible()
    const text = 'This text remains focused during its presentation recovery snapshot.'
    await slides.keyboard.type(text)
    await expect(editor).toContainText(text)
    // No draft IPC, forced blur, or virtual clock: the production 30s timer
    // must discover the pending DOM text itself.
    await expect
      .poll(
        async () =>
          original.page.evaluate(
            async () =>
              (await window.vantage!.draftList()).filter((entry) => entry.module === 'slides')
                .length,
          ),
        { timeout: 90_000, intervals: [1000, 2000, 5000] },
      )
      .toBe(1)
    await expect(editor).toBeFocused()
    expect(await slides.evaluate(() => window.slidesApi.isDirty())).toBe(true)
    let [draft] = await original.page.evaluate(async () =>
      (await window.vantage!.draftList()).filter((entry) => entry.module === 'slides'),
    )
    expect(draft.documentPath).toBeNull()
    expect(await readdir(documents)).toEqual([])
    const before = JSON.parse(
      await readFile(join(profile, 'recovery', 'drafts', `${draft.id}.json`), 'utf8'),
    ) as { sha256: string }
    const notes = slides.locator('.notes-pane textarea')
    await expect(notes).toBeVisible()
    const noteText =
      'Pending speaker notes remain focused and are included in the complete package.'
    await notes.fill(noteText)
    await expect
      .poll(
        async () =>
          JSON.parse(
            await readFile(join(profile, 'recovery', 'drafts', `${draft.id}.json`), 'utf8'),
          ).sha256,
        { timeout: 90_000, intervals: [1000, 2000, 5000] },
      )
      .not.toBe(before.sha256)
    await expect(notes).toBeFocused()
    const oldToken = draft.id
    await original.page.evaluate(async (id) => window.vantage!.discardDraft(id), oldToken)
    await slides.waitForTimeout(35_000)
    expect(
      (await original.page.evaluate(async () => window.vantage!.draftList())).filter(
        (entry) => entry.module === 'slides',
      ),
    ).toHaveLength(0)
    await notes.press('End')
    const laterNotes = ' A new edit starts a fresh recovery activation.'
    await notes.pressSequentially(laterNotes)
    await expect
      .poll(
        async () =>
          original.page.evaluate(
            async () =>
              (await window.vantage!.draftList()).filter((entry) => entry.module === 'slides')
                .length,
          ),
        { timeout: 90_000, intervals: [1000, 2000, 5000] },
      )
      .toBe(1)
    ;[draft] = await original.page.evaluate(async () =>
      (await window.vantage!.draftList()).filter((entry) => entry.module === 'slides'),
    )
    expect(draft.id).not.toBe(oldToken)
    expect(draft.documentPath).toBeNull()
    expect(await readdir(documents)).toEqual([])
    const manifest = JSON.parse(
      await readFile(join(profile, 'recovery', 'drafts', `${draft.id}.json`), 'utf8'),
    ) as { sha256: string }
    await slides.screenshot({ path: test.info().outputPath('slides-focused-draft.png') })
    const child = original.app.process()
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      throw new Error('The owned application exited before crash injection')
    if (process.platform === 'win32')
      await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 30_000,
      })
    else child.kill('SIGKILL')
    crashed = true
    await expect
      .poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 30_000 })
      .toBe(true)
    restarted = await launchShell({ userDataDir: profile, videoDir: 'slides-draft-after-crash' })
    expect(
      (await restarted.page.evaluate(async () => window.vantage!.draftList())).some(
        (entry) => entry.id === draft.id,
      ),
    ).toBe(true)
    const recovered = join(scratch, 'recovered-unnamed.pptx')
    await restarted.app.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: destination,
      })) as typeof dialog.showSaveDialog
    }, recovered)
    expect(
      await restarted.page.evaluate(async (id) => window.vantage!.restoreDraft(id), draft.id),
    ).toBe(recovered)
    const bytes = await readFile(recovered)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.sha256)
    const zip = await JSZip.loadAsync(bytes)
    const slideXml = await zip.file('ppt/slides/slide1.xml')!.async('string')
    const notesXml = await zip.file('ppt/notesSlides/notesSlide1.xml')!.async('string')
    expect(slideXml).toContain(text)
    expect(notesXml).toContain(noteText)
    expect(notesXml).toContain(laterNotes)
    await restarted.page.evaluate(async (path) => window.aiOffice.openPath(path), recovered)
    const reopened = await waitForPageWithUrl(restarted.app, '://slides/')
    await expect(reopened.locator('.stage-wrap canvas').first()).toBeVisible({ timeout: 60_000 })
    await expect(reopened.locator('.notes-pane textarea')).toHaveValue(noteText + laterNotes)
    const rendered = await reopened.evaluate(() => window.slidesApi.getRenderSlides())
    const renderedText = (rendered ?? [])
      .flatMap((slide) =>
        slide.nodes.flatMap((node) =>
          'text' in node && node.text
            ? node.text.lines.map((line) => line.runs.map((run) => run.text).join(''))
            : [],
        ),
      )
      .join(' ')
      .replace(/\s+/g, ' ')
    expect(renderedText).toContain(text)
    await test.info().attach('slides-draft-proof', {
      body: Buffer.from(
        JSON.stringify(
          {
            module: 'slides',
            autoSave: false,
            documentPath: null,
            realTimerSnapshots: 3,
            activeDiscardQuietPeriodMs: 35000,
            focusedTextAndNotes: true,
            forcedOwnedCrash: true,
            sameProfileRestart: true,
            restoredAndReopened: true,
            sha256: manifest.sha256,
          },
          null,
          2,
        ),
      ),
      contentType: 'application/json',
    })
    await restarted.page.evaluate(async (id) => window.vantage!.discardDraft(id), draft.id)
    expect(await readFile(recovered)).toEqual(bytes)
  } finally {
    if (!crashed) await closeAndSaveVideo(original, 'slides-draft-before-crash')
    if (restarted) await closeAndSaveVideo(restarted, 'slides-draft-after-crash')
    const target = resolve(scratch)
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith('vantage-slides-draft-e2e-')
    )
      throw new Error('Unexpected Slides test directory')
    await rm(target, { recursive: true, force: true })
  }
})
