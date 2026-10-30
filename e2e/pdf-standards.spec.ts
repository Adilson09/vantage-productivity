import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchShell, closeAndSaveVideo } from './helpers'

test('runs real PDF/A and PDF/UA standards checks through the document engines controls', async ({}, testInfo) => {
  test.setTimeout(600_000)
  const runTag = `pdf-standards-${Date.now()}`
  const manifest = process.env.VANTAGE_TEST_ENGINE_MANIFEST
  const corpus = process.env.VANTAGE_TEST_VERAPDF_FIXTURES
  test.skip(
    !manifest || !corpus,
    'A verified private veraPDF runtime and official pinned corpus are not configured; native standards acceptance is unavailable.',
  )
  const scratch = await mkdtemp(join(tmpdir(), 'vantage-standards-ui-'))
  const malformed = join(scratch, 'malformed.pdf')
  await writeFile(
    malformed,
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 99 0 R >>\nendobj\n%%EOF\n',
  )
  const launched = await launchShell({
    onboardingSeen: true,
    videoDir: runTag,
    env: { VANTAGE_ENGINE_MANIFEST: manifest!, VANTAGE_ENGINE_TEMP_DIR: scratch },
  })
  const uiEvents: unknown[] = []
  try {
    const { app, page } = launched
    const action = (name: string, detail?: unknown) =>
      uiEvents.push({
        at: new Date().toISOString(),
        kind: 'test-action',
        name,
        detail,
      })
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame())
        uiEvents.push({ at: new Date().toISOString(), kind: 'page-navigation', url: frame.url() })
    })
    page.on('pageerror', (error) =>
      uiEvents.push({ at: new Date().toISOString(), kind: 'page-error', error: String(error) }),
    )
    page.on('crash', () => uiEvents.push({ at: new Date().toISOString(), kind: 'page-crash' }))
    await page.exposeBinding('__vantagePdfUiObservation', (_source, value: unknown) => {
      uiEvents.push(value)
      if (uiEvents.length > 1000) uiEvents.shift()
    })
    const installObservation = () => {
      const host = window as unknown as {
        __vantagePdfUiInstalled?: boolean
        __vantagePdfUiObservation?: (value: unknown) => Promise<unknown>
      }
      if (host.__vantagePdfUiInstalled) return
      host.__vantagePdfUiInstalled = true
      const target = (value: EventTarget | null) =>
        value instanceof Element
          ? {
              tag: value.tagName,
              role: value.getAttribute('role'),
              label: value.getAttribute('aria-label'),
              className: value.className,
              text: value.textContent?.slice(0, 180),
            }
          : null
      const emit = (kind: string, detail?: unknown) => {
        void host
          .__vantagePdfUiObservation?.({ at: new Date().toISOString(), kind, detail })
          .catch(() => {})
      }
      for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'])
        document.addEventListener(
          type,
          (event) => {
            const pointer = event as MouseEvent
            emit('document-' + type, {
              target: target(event.target),
              trusted: event.isTrusted,
              x: pointer.clientX,
              y: pointer.clientY,
              button: pointer.button,
            })
          },
          true,
        )
      document.addEventListener(
        'keydown',
        (event) =>
          emit('document-keydown', {
            target: target(event.target),
            trusted: event.isTrusted,
            key: event.key,
            code: event.code,
            ctrl: event.ctrlKey,
            shift: event.shiftKey,
            alt: event.altKey,
            meta: event.metaKey,
          }),
        true,
      )
      document.addEventListener(
        'focusin',
        (event) => emit('document-focusin', { target: target(event.target) }),
        true,
      )
      document.addEventListener(
        'focusout',
        (event) => emit('document-focusout', { target: target(event.target) }),
        true,
      )
      for (const type of ['focus', 'blur', 'pagehide', 'pageshow', 'beforeunload'])
        window.addEventListener(type, () => emit('window-' + type))
      let modalCount = document.querySelectorAll('[role="dialog"],dialog').length
      new MutationObserver(() => {
        const count = document.querySelectorAll('[role="dialog"],dialog').length
        if (count !== modalCount) {
          emit('modal-count-changed', {
            before: modalCount,
            after: count,
            active: target(document.activeElement),
            selectedFolder: document
              .querySelector('[role="treeitem"][aria-selected="true"]')
              ?.textContent?.slice(0, 180),
            workspaceClass: document.querySelector('.vantage-workspace')?.className,
          })
          modalCount = count
        }
      }).observe(document, { subtree: true, childList: true })
      emit('observation-installed', { url: location.href, modalCount })
    }
    await page.addInitScript(installObservation)
    await page.evaluate(installObservation)
    await app.evaluate(({ app: electronApp, webContents, ipcMain }) => {
      const events: unknown[] = []
      ;(globalThis as unknown as { __vantagePdfMainEvents?: unknown }).__vantagePdfMainEvents =
        events
      const add = (kind: string, detail?: unknown) => {
        events.push({ at: new Date().toISOString(), kind, detail })
        if (events.length > 500) events.shift()
      }
      const watch = (contents: Electron.WebContents) => {
        const id = contents.id
        contents.on('did-start-navigation', (_event, url, inPlace, main) =>
          add('main-start-navigation', { id, url, inPlace, main }),
        )
        contents.on('did-navigate', (_event, url) => add('main-did-navigate', { id, url }))
        contents.on('did-navigate-in-page', (_event, url, main) =>
          add('main-navigation-in-page', { id, url, main }),
        )
        contents.on('render-process-gone', (_event, detail) =>
          add('main-renderer-gone', { id, reason: detail.reason, exitCode: detail.exitCode }),
        )
        contents.on('destroyed', () => add('main-web-contents-destroyed', { id }))
      }
      for (const contents of webContents.getAllWebContents()) watch(contents)
      electronApp.on('web-contents-created', (_event, contents) => {
        add('main-web-contents-created', { id: contents.id })
        watch(contents)
      })
      const handlers = (
        ipcMain as unknown as { _invokeHandlers?: Map<string, (...args: unknown[]) => unknown> }
      )._invokeHandlers
      if (!handlers) {
        add('ipc-observation-unavailable')
        return
      }
      for (const [channel, original] of handlers) {
        if (
          channel !== 'vantage:check-specialist-pdf' &&
          !/folder.*roots|recents|starred/i.test(channel)
        )
          continue
        handlers.set(channel, async function (this: unknown, ...args: unknown[]) {
          add('ipc-start', {
            channel,
            args: channel === 'vantage:check-specialist-pdf' ? args.slice(1) : undefined,
          })
          try {
            const result = await Reflect.apply(original, this, args)
            if (channel === 'vantage:check-specialist-pdf') add('ipc-result', { channel, result })
            else
              add('ipc-result-summary', {
                channel,
                result: Array.isArray(result)
                  ? result
                  : {
                      total: (result as { total?: unknown })?.total,
                      entries: (result as { entries?: unknown[] })?.entries?.length,
                    },
              })
            return result
          } catch (error) {
            add('ipc-error', { channel, error: String(error) })
            throw error
          }
        })
      }
      add('main-observation-installed')
    })
    action('open-tools')
    await page
      .getByRole('button', { name: /Tools and privacy/ })
      .first()
      .click()
    const panel = page.getByRole('dialog', { name: 'Tools and privacy', exact: true })
    await panel.getByRole('button', { name: 'Document engines', exact: true }).click()
    const validate = panel.getByRole('button', { name: 'Validate PDF standard', exact: true })
    await expect(validate).toBeEnabled({ timeout: 120_000 })
    let caseIndex = 0
    for (const item of [
      {
        name: 'pdfa-1b-pass.pdf',
        flavour: '1b',
        outcome: 'passed',
        profile: 'PDF/A-1b validation profile',
      },
      {
        name: 'pdfa-1b-fail.pdf',
        flavour: '1b',
        outcome: 'failed',
        profile: 'PDF/A-1b validation profile',
      },
      {
        name: 'pdfua-1-pass.pdf',
        flavour: 'ua1',
        outcome: 'passed',
        profile: 'PDF/UA-1 validation profile',
      },
      {
        name: 'pdfua-1-fail.pdf',
        flavour: 'ua1',
        outcome: 'failed',
        profile: 'PDF/UA-1 validation profile',
      },
      { name: 'malformed.pdf', flavour: '1b', outcome: 'did not complete', profile: null },
    ]) {
      const path = item.name === 'malformed.pdf' ? malformed : join(corpus!, item.name)
      const before = createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
      const started = Date.now()
      action('case-start', item)
      const capture = async (stage: 'passed' | 'failed', failure?: unknown) => {
        const stem = `${runTag}-${++caseIndex}-${item.name}-${stage}`
        await mkdir(testInfo.outputDir, { recursive: true })
        const bounded = async <T>(action: Promise<T>): Promise<T> => {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            return await Promise.race([
              action,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error('Observation exceeded 10 seconds')),
                  10_000,
                )
              }),
            ])
          } finally {
            if (timer) clearTimeout(timer)
          }
        }
        const observations = await Promise.allSettled([
          bounded(
            page.evaluate(() => {
              const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog'))
              const dialog = dialogs.find(
                (element) =>
                  element.getAttribute('aria-label') === 'Tools and privacy' ||
                  element.querySelector('h1,h2,h3')?.textContent === 'Tools and privacy',
              )
              return {
                url: location.href,
                dialogs: dialogs.map((element) => ({
                  label: element.getAttribute('aria-label'),
                  labelledBy: element.getAttribute('aria-labelledby'),
                  visible: element.getClientRects().length > 0,
                  text: element.textContent?.slice(0, 100_000),
                })),
                paragraphs: dialog
                  ? Array.from(dialog.querySelectorAll('p')).map((p) => p.textContent)
                  : [],
                rawTechnicalReports: dialog
                  ? Array.from(dialog.querySelectorAll('pre')).map((pre) => pre.textContent)
                  : [],
                selectedProfiles: dialog
                  ? Array.from(dialog.querySelectorAll('select')).map((select) => ({
                      id: select.id,
                      value: select.value,
                    }))
                  : [],
                alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(
                  (element) => element.textContent,
                ),
                bodyText: document.body.innerText.slice(0, 100_000),
              }
            }),
          ),
          bounded(
            page.screenshot({
              path: testInfo.outputPath(stem + '.png'),
              fullPage: true,
              timeout: 10_000,
            }),
          ),
          bounded(
            app.evaluate(() => ({
              picker: (globalThis as unknown as { __vantagePdfPickerObservation?: unknown })
                .__vantagePdfPickerObservation,
              events: (globalThis as unknown as { __vantagePdfMainEvents?: unknown })
                .__vantagePdfMainEvents,
            })),
          ),
          bounded(
            readFile(path).then((bytes) => ({
              bytes: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            })),
          ),
        ])
        const result = (index: number) => {
          const value = observations[index]
          return value.status === 'fulfilled'
            ? value.value
            : { observationError: String(value.reason) }
        }
        const observationPath = testInfo.outputPath(stem + '.json')
        await writeFile(
          observationPath,
          JSON.stringify(
            {
              capturedAt: new Date().toISOString(),
              stage,
              expected: item,
              selectedSource: path,
              selectedFlavour: item.flavour,
              sourceSha256Before: before,
              elapsedMs: Date.now() - started,
              manifest,
              corpus,
              userDataDir: launched.userDataDir,
              failure: failure ? String(failure) : null,
              ui: result(0),
              screenshot: observations[1].status === 'fulfilled' ? stem + '.png' : result(1),
              mainObservation: result(2),
              uiEvents: [...uiEvents],
              sourceAfter: result(3),
            },
            null,
            2,
          ) + '\n',
        )
        await testInfo.attach(stem, { path: observationPath, contentType: 'application/json' })
      }
      await app.evaluate(({ dialog }, selected) => {
        const observation = { selected, calls: [] as { at: string; title: unknown }[] }
        ;(
          globalThis as unknown as { __vantagePdfPickerObservation?: unknown }
        ).__vantagePdfPickerObservation = observation
        dialog.showOpenDialog = (async (...args: unknown[]) => {
          observation.calls.push({
            at: new Date().toISOString(),
            title: (args.at(-1) as { title?: unknown })?.title,
          })
          return { canceled: false, filePaths: [selected] }
        }) as typeof dialog.showOpenDialog
      }, path)
      try {
        action('select-profile', item.flavour)
        await panel.getByLabel('PDF standard', { exact: true }).selectOption(item.flavour)
        action('click-validate', { name: item.name, flavour: item.flavour })
        await validate.click()
        action('wait-for-outcome', item.outcome)
        await expect(
          panel.getByText(`Standards check ${item.outcome}`, { exact: true }),
        ).toBeVisible({ timeout: 120_000 })
        await expect(validate).toBeEnabled({ timeout: 120_000 })
        if (item.profile)
          await expect(panel.locator('p').filter({ hasText: item.profile }).first()).toBeVisible()
        await expect(
          panel.getByText('Source file stayed unchanged.', { exact: true }),
        ).toBeVisible()
        await expect(
          panel.getByText(/Human accessibility checks and visual review remain required/),
        ).toBeVisible()
        expect(
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
        ).toBe(before)
        await capture('passed')
      } catch (error) {
        await capture('failed', error).catch((observationError) => {
          console.error('PDF per-case observation failed before app cleanup:', observationError)
        })
        throw error
      }
    }
    const invalidProfile = await page.evaluate(async () => {
      try {
        await window.vantage!.checkSpecialistPdf('verapdf', '--profile=untrusted' as never)
        return 'unexpected success'
      } catch (error) {
        return String(error)
      }
    })
    expect(invalidProfile).toContain('Choose a supported PDF/A or PDF/UA validation profile')
  } finally {
    await writeFile(
      testInfo.outputPath(runTag + '-lifecycle.json'),
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          uiEvents,
          mainObservation: await launched.app
            .evaluate(
              () =>
                (globalThis as unknown as { __vantagePdfMainEvents?: unknown })
                  .__vantagePdfMainEvents,
            )
            .catch(String),
        },
        null,
        2,
      ) + '\n',
    ).catch((error) => console.error('PDF lifecycle observation write failed:', error))
    await closeAndSaveVideo(launched, runTag)
  }
})
