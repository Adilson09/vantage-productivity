import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, type LaunchedApp } from './helpers'

test('an unnamed Markdown draft survives a process crash and restores exact bytes to a new copy', async () => {
  test.setTimeout(240_000)
  const scratch = await mkdtemp(join(tmpdir(), 'vantage-draft-recovery-e2e-'))
  const text = 'Crash recovery keeps this unnamed note.'
  const original = await launchShell({
    onboardingSeen: true,
    videoDir: 'unnamed-draft-before-crash',
  })
  let originalCrashed = false
  let restarted: LaunchedApp | undefined
  try {
    await original.page.getByRole('button', { name: 'Create Markdown', exact: true }).click()
    const editorPage = await waitForPageWithUrl(original.app, '://markdown/')
    const editor = editorPage.locator('.doc-editor')
    await expect(editor).toBeVisible()
    await editor.click()
    await editorPage.keyboard.type(text)
    await expect(editor).toContainText(text)
    // This waits for the real renderer's journal timer. Calling writeDraft
    // directly would skip the serialization/dirty/unnamed-document integration.
    await expect
      .poll(
        async () => original.page.evaluate(async () => (await window.vantage!.draftList()).length),
        { timeout: 45_000 },
      )
      .toBe(1)
    const [draft] = await original.page.evaluate(async () => window.vantage!.draftList())
    expect(draft!.documentPath).toBeNull()
    expect(draft!.module).toBe('markdown')
    const journalDir = join(original.userDataDir, 'recovery', 'drafts')
    const manifest = JSON.parse(await readFile(join(journalDir, `${draft!.id}.json`), 'utf8')) as {
      payload: string
      sha256: string
    }
    const journalBytes = await readFile(join(journalDir, manifest.payload))
    expect(journalBytes.toString('utf8')).toContain(text)
    expect(createHash('sha256').update(journalBytes).digest('hex')).toBe(manifest.sha256)

    // Terminate without the close dialog, which deliberately discards drafts
    // when the user selects Don't Save. The next launch uses the same profile.
    const child = original.app.process()
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      throw new Error('The test application exited before crash injection')
    if (process.platform === 'win32') {
      // Kill only the process tree launched by this test. Main-only SIGKILL
      // can leave Chromium children holding the Playwright transport open.
      await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
      })
    } else child.kill('SIGKILL')
    originalCrashed = true
    await expect
      .poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 15_000 })
      .toBe(true)
    restarted = await launchShell({
      userDataDir: original.userDataDir,
      videoDir: 'unnamed-draft-after-crash',
    })
    const retained = await restarted.page.evaluate(async () => window.vantage!.draftList())
    expect(retained.some((entry) => entry.id === draft!.id)).toBe(true)
    const recovered = join(scratch, 'recovered-unnamed.md')
    await restarted.app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: path,
      })) as typeof dialog.showSaveDialog
    }, recovered)
    const destination = await restarted.page.evaluate(
      async (id) => window.vantage!.restoreDraft(id),
      draft!.id,
    )
    expect(destination && resolve(destination)).toBe(resolve(recovered))
    expect(await readFile(recovered)).toEqual(journalBytes)
    // Restoring a copy does not implicitly discard the sole crash journal.
    expect(
      (await restarted.page.evaluate(async () => window.vantage!.draftList())).some(
        (entry) => entry.id === draft!.id,
      ),
    ).toBe(true)
    await restarted.page.evaluate(async (id) => window.vantage!.discardDraft(id), draft!.id)
    expect(
      (await restarted.page.evaluate(async () => window.vantage!.draftList())).some(
        (entry) => entry.id === draft!.id,
      ),
    ).toBe(false)
    expect(await readFile(recovered)).toEqual(journalBytes)
  } finally {
    if (!originalCrashed) await closeAndSaveVideo(original, 'unnamed-draft-before-crash')
    if (restarted) await closeAndSaveVideo(restarted, 'unnamed-draft-after-crash')
    if (!scratch.startsWith(join(tmpdir(), 'vantage-draft-recovery-e2e-')))
      throw new Error('Unexpected test directory')
    await rm(scratch, { recursive: true, force: true })
  }
})
