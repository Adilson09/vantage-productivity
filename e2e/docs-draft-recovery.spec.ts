import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, type LaunchedApp } from './helpers'

test('unnamed Docs typing with AutoSave off survives its real journal timer, crash, restart, restore and reopen', async () => {
  test.setTimeout(480_000)
  const scratchRoot = resolve(tmpdir())
  const scratch = await mkdtemp(join(scratchRoot, 'vantage-docx-draft-e2e-'))
  const profile = join(scratch, 'profile'),
    documents = join(scratch, 'documents')
  await mkdir(profile)
  await mkdir(documents)
  const text = 'Unnamed Docs recovery keeps this real typed sentence.'
  const original = await launchShell({
    userDataDir: profile,
    onboardingSeen: true,
    settings: { defaultSaveDir: documents },
    videoDir: 'docx-draft-before-crash',
  })
  let crashed = false,
    restarted: LaunchedApp | undefined
  try {
    await original.page.getByRole('button', { name: 'Create document', exact: true }).click()
    const docs = await waitForPageWithUrl(original.app, '://docs/')
    const editor = docs.locator('.ProseMirror[contenteditable="true"]').first()
    await expect(editor).toBeVisible({ timeout: 60_000 })
    const autoSave = docs.locator('.autosave-toggle input[type="checkbox"]')
    if (await autoSave.isChecked()) await docs.locator('.autosave-toggle').click()
    await expect(autoSave).not.toBeChecked()
    await editor.click()
    await docs.keyboard.type(text)
    await expect(editor).toContainText(text)
    // Do not invoke the draft IPC or serialize the editor here: the live
    // production thirty-second timer must discover and journal these edits.
    await expect
      .poll(
        async () =>
          original.page.evaluate(
            async () =>
              (await window.vantage!.draftList()).filter((entry) => entry.module === 'docs').length,
          ),
        { timeout: 90_000, intervals: [1000, 2000, 5000] },
      )
      .toBe(1)
    let [draft] = await original.page.evaluate(async () =>
      (await window.vantage!.draftList()).filter((entry) => entry.module === 'docs'),
    )
    expect(draft.documentPath).toBeNull()
    expect(await readdir(documents)).toEqual([])
    const closeState = await original.app.evaluate(
      ({ ipcMain, webContents }) =>
        new Promise<{ dirty: boolean; autoSave: boolean; filePath: string | null }>(
          (done, reject) => {
            const contents = webContents
              .getAllWebContents()
              .find((entry) => entry.getURL().includes('://docs/'))
            if (!contents) return reject(new Error('The Docs view is missing'))
            const listener = (
              event: Electron.IpcMainEvent,
              state: { dirty: boolean; autoSave: boolean; filePath: string | null },
            ) => {
              if (event.sender.id !== contents.id) return
              clearTimeout(timer)
              ipcMain.removeListener('docs:close-check-result', listener)
              done(state)
            }
            const timer = setTimeout(() => {
              ipcMain.removeListener('docs:close-check-result', listener)
              reject(new Error('Docs close state did not answer'))
            }, 15_000)
            ipcMain.on('docs:close-check-result', listener)
            contents.send('docs:close-check')
          },
        ),
    )
    expect(closeState).toEqual({ dirty: true, autoSave: false, filePath: null })
    let manifest = JSON.parse(
      await readFile(join(profile, 'recovery', 'drafts', `${draft.id}.json`), 'utf8'),
    ) as { sha256: string }
    const candidate = join(scratch, 'declined-candidate.docx')
    await writeFile(candidate, '')
    await original.app.evaluate(({ dialog, webContents }, path) => {
      const state = globalThis as typeof globalThis & { __docxDraftOpenCanceled?: boolean }
      state.__docxDraftOpenCanceled = false
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async () => {
        state.__docxDraftOpenCanceled = true
        return { response: 2, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
      webContents
        .getAllWebContents()
        .find((entry) => entry.getURL().includes('://docs/'))!
        .send('menu:command', 'open')
    }, candidate)
    await expect
      .poll(() =>
        original.app.evaluate(
          () =>
            (globalThis as typeof globalThis & { __docxDraftOpenCanceled?: boolean })
              .__docxDraftOpenCanceled,
        ),
      )
      .toBe(true)
    await expect(editor).toContainText(text)
    await editor.click()
    await docs.keyboard.press('ControlOrMeta+End')
    const laterText = ' This stays in the current draft after canceled Open.'
    await docs.keyboard.type(laterText)
    const earlierHash = manifest.sha256
    await expect
      .poll(
        async () => {
          const current = JSON.parse(
            await readFile(join(profile, 'recovery', 'drafts', `${draft.id}.json`), 'utf8'),
          ) as { sha256: string }
          return current.sha256
        },
        { timeout: 90_000, intervals: [1000, 2000, 5000] },
      )
      .not.toBe(earlierHash)
    const afterCancel = await original.page.evaluate(async () =>
      (await window.vantage!.draftList()).filter((entry) => entry.module === 'docs'),
    )
    expect(afterCancel).toHaveLength(1)
    expect(afterCancel[0]).toMatchObject({ id: draft.id, documentPath: null })
    expect(await readdir(documents)).toEqual([])
    await docs.screenshot({ path: test.info().outputPath('docx-draft-before-crash.png') })
    manifest = JSON.parse(
      await readFile(join(profile, 'recovery', 'drafts', `${draft.id}.json`), 'utf8'),
    ) as { sha256: string }
    const discardedToken = draft.id
    await original.page.evaluate(async (id) => window.vantage!.discardDraft(id), discardedToken)
    // One full real timer period must pass without recreating discarded,
    // unchanged content while its document view remains open.
    await docs.waitForTimeout(35_000)
    expect(
      (await original.page.evaluate(async () => window.vantage!.draftList())).filter(
        (entry) => entry.module === 'docs',
      ),
    ).toHaveLength(0)
    await editor.click()
    await docs.keyboard.press('ControlOrMeta+End')
    const freshText = ' A new edit starts a new recovery activation.'
    await docs.keyboard.type(freshText)
    await expect
      .poll(
        async () =>
          original.page.evaluate(
            async () =>
              (await window.vantage!.draftList()).filter((entry) => entry.module === 'docs').length,
          ),
        { timeout: 90_000, intervals: [1000, 2000, 5000] },
      )
      .toBe(1)
    ;[draft] = await original.page.evaluate(async () =>
      (await window.vantage!.draftList()).filter((entry) => entry.module === 'docs'),
    )
    expect(draft.id).not.toBe(discardedToken)
    expect(draft.documentPath).toBeNull()
    manifest = JSON.parse(
      await readFile(join(profile, 'recovery', 'drafts', `${draft.id}.json`), 'utf8'),
    ) as { sha256: string }
    const child = original.app.process()
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      throw new Error('The owned test application exited before crash injection')
    if (process.platform === 'win32')
      await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
      })
    else child.kill('SIGKILL')
    crashed = true
    await expect
      .poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 30_000 })
      .toBe(true)
    restarted = await launchShell({ userDataDir: profile, videoDir: 'docx-draft-after-crash' })
    expect(
      (await restarted.page.evaluate(async () => window.vantage!.draftList())).some(
        (entry) => entry.id === draft.id,
      ),
    ).toBe(true)
    const recovered = join(scratch, 'recovered-unnamed.docx')
    await restarted.app.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: destination,
      })) as typeof dialog.showSaveDialog
    }, recovered)
    expect(
      await restarted.page.evaluate(async (id) => window.vantage!.restoreDraft(id), draft.id),
    ).toBe(recovered)
    const recoveredBytes = await readFile(recovered)
    expect(createHash('sha256').update(recoveredBytes).digest('hex')).toBe(manifest.sha256)
    expect(
      await (await JSZip.loadAsync(recoveredBytes)).file('word/document.xml')!.async('string'),
    ).toContain(text)
    expect(
      await (await JSZip.loadAsync(recoveredBytes)).file('word/document.xml')!.async('string'),
    ).toContain(laterText)
    expect(
      await (await JSZip.loadAsync(recoveredBytes)).file('word/document.xml')!.async('string'),
    ).toContain(freshText)
    await restarted.page.evaluate(async (path) => window.aiOffice.openPath(path), recovered)
    const reopened = await waitForPageWithUrl(restarted.app, '://docs/')
    await expect(reopened.locator('.ProseMirror').first()).toContainText(text, { timeout: 60_000 })
    await expect(reopened).toHaveTitle('recovered-unnamed.docx')
    await reopened.screenshot({ path: test.info().outputPath('docx-draft-recovered.png') })
    await test.info().attach('docx-draft-proof', {
      body: Buffer.from(
        JSON.stringify(
          {
            module: 'docs',
            documentPath: null,
            autoSave: false,
            remainedDirty: closeState.dirty,
            candidateOpenCanceled: true,
            realTimerSnapshots: 3,
            forcedOwnedCrash: true,
            activeRecoveryDiscardStayedDiscarded: true,
            sameProfileRestart: true,
            restoredAndReopened: true,
            recoveredSha256: createHash('sha256').update(recoveredBytes).digest('hex'),
          },
          null,
          2,
        ),
      ),
      contentType: 'application/json',
    })
    await restarted.page.evaluate(async (id) => window.vantage!.discardDraft(id), draft.id)
    expect(
      (await restarted.page.evaluate(async () => window.vantage!.draftList())).some(
        (entry) => entry.id === draft.id,
      ),
    ).toBe(false)
    expect(await readFile(recovered)).toEqual(recoveredBytes)
  } finally {
    if (!crashed) await closeAndSaveVideo(original, 'docx-draft-before-crash')
    if (restarted) await closeAndSaveVideo(restarted, 'docx-draft-after-crash')
    if (
      !resolve(scratch).startsWith(`${scratchRoot}\\`) &&
      !resolve(scratch).startsWith(`${scratchRoot}/`)
    )
      throw new Error('Unexpected Docs validation directory')
    await rm(scratch, { recursive: true, force: true })
  }
})
