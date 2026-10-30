import { expect, type Page } from '@playwright/test'
import type { MarkdownSaveCompletion, MarkdownSaveTicket } from '../../src/shared/ipc'
export const rebaseSource = '<details>\n<img src="assets/old.png">\n</details>\n'
export const source = 'Title\n=====\n\n* item  \n\n\n'

export async function openSource(
  page: Page,
  enabled: boolean,
  rebase = false,
  text = source,
): Promise<void> {
  page.on('pageerror', (error) => console.log('[browser-error]', error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') console.log('[browser-console]', message.text())
  })
  await page.addInitScript(
    ({ text, enabled, rebase }) => {
      if (enabled) localStorage.setItem('mdapp.experimentalRoundTrip', '1')
      localStorage.setItem('mdapp.showAi', '0')
      const off = () => {}
      let sourceState: Parameters<typeof window.markdownApi.closeSourceState>[0] | null = null
      let copySequence = 0
      const requests = new Map<string, { ticket: MarkdownSaveTicket; source: string | undefined }>()
      window.markdownApi = {
        getLanguage: async () => 'en',
        getTheme: async () => 'light',
        getMarkdownTheme: async () => 'default',
        setMarkdownTheme: async () => 'default',
        onLanguageChanged: () => off,
        onThemeChanged: () => off,
        getAutoSaveDefault: async () => ({ on: false, updatedAt: 0 }),
        onAutoSaveDefaultChanged: () => off,
        getAiPanelPrefs: async () => ({
          fontSize: 'default',
          customFontSize: 14,
          spellcheck: true,
        }),
        onAiPanelPrefsChanged: () => off,
        consumePending: async () => '/fixtures/polish.md',
        readFile: async () => text,
        readPublication: async () => ({ text, publicationId: 'fixture-publication' }),
        publicationLoaded: () => {},
        rememberWikiFragment: async () => {},
        takeWikiFragment: async () => '',
        consumeHeadlessExport: async () => null,
        headlessExportDone: () => {},
        setDirty: () => {},
        save: async (request) => {
          const captured = request.requestId ? requests.get(request.requestId) : undefined
          if (
            !captured ||
            !sourceState ||
            sourceState.path !== captured.ticket.sourcePath ||
            sourceState.stamp.source !== captured.source ||
            request.closeSource?.source !== captured.source
          )
            return { ok: false, error: 'No current browser Main save ticket' }
          const target =
            request.mode === 'saveAs' ? captured.ticket.targetPath : captured.ticket.sourcePath
          if (!target) return { ok: false, error: 'No explicitly selected browser copy target' }
          document.body.dataset.saved = request.text
          return {
            ok: true,
            path: target,
            publicationId: 'fixture-published-' + request.requestId,
            imageRewrites: rebase ? [{ from: 'assets/old.png', to: 'assets/new.png' }] : [],
            writtenText: rebase
              ? request.text.replace('assets/old.png', 'assets/new.png')
              : undefined,
          }
        },
        onSaveRequest: (handler) => {
          const issue = (mode: 'save' | 'saveAs', event: Event) => {
            const detail = (event as CustomEvent<{ requestId?: string }>).detail
            const requestId = detail?.requestId ?? crypto.randomUUID()
            const ticket: MarkdownSaveTicket = {
              requestId,
              sourcePath: sourceState?.path ?? null,
              requireClean: false,
              intent: 'save',
              ...(mode === 'saveAs'
                ? { targetPath: '/fixtures/serializer-copy-' + ++copySequence + '.md' }
                : {}),
            }
            requests.set(requestId, {
              ticket: Object.freeze({ ...ticket }),
              source: sourceState?.stamp.source,
            })
            handler(mode, { ...ticket })
          }
          const save = (event: Event) => issue('save', event)
          const saveAs = (event: Event) => issue('saveAs', event)
          window.addEventListener('test:save', save)
          window.addEventListener('test:save-as', saveAs)
          return () => {
            window.removeEventListener('test:save', save)
            window.removeEventListener('test:save-as', saveAs)
          }
        },
        onReadTextRequest: (handler) => {
          window.addEventListener('test:read-source', handler)
          return () => window.removeEventListener('test:read-source', handler)
        },
        sendReadTextResult: (result) =>
          window.dispatchEvent(new CustomEvent('test:read-source-result', { detail: result })),
        sendSaveRequestAck: (result) => {
          requests.delete(result.requestId)
          window.dispatchEvent(new CustomEvent('test:save-ack', { detail: result }))
        },
        closeSourceState: (state) => {
          sourceState = { ...state, stamp: { ...state.stamp } }
        },
        claimCloseLease: async () => false,
        cancelCloseLease: async () => {},
        onCloseLeaseRelease: (handler) => {
          const listener = (event: Event) =>
            handler((event as CustomEvent<Parameters<typeof handler>[0]>).detail)
          window.addEventListener('test:close-lease-release', listener)
          return () => window.removeEventListener('test:close-lease-release', listener)
        },
        writeDraft: async () => ({
          ok: false,
          error: 'Native recovery is unavailable in browser-only renderer coverage',
        }),
        onCloseSaveRequest: () => off,
        sendCloseSaveResult: () => {},
        onFileRenamed: () => off,
        onFileChangedOnDisk: () => off,
        ackFileChangedOnDisk: () => {},
        pickImage: async () => null,
        saveImage: async () => null,
        readImage: async () => null,
        onExportRequest: (handler) => {
          const exportFile = (event: Event) => handler((event as CustomEvent).detail)
          window.addEventListener('test:export', exportFile)
          return () => window.removeEventListener('test:export', exportFile)
        },
        prepareImageExport: async () => ({ ok: true, canceled: true }),
        writeExportImage: async () => ({ ok: false, error: 'not used in renderer coverage' }),
        finishImageExport: async () => ({ ok: false, error: 'not used in renderer coverage' }),
        onPrintRequest: () => off,
        exportDocx: async () => ({ ok: false, error: 'not used in renderer coverage' }),
        exportPdf: async () => ({ ok: false, error: 'not used in renderer coverage' }),
        onChromePressed: () => off,
        onViewImage: () => off,
        getAiSettings: async () => ({ providers: [] }),
        aiGskStatus: async () => ({ loggedIn: false }),
        aiStream: async () => {},
        aiStreamCancel: async () => {},
        onAiStream: () => off,
        webSearch: async () => ({
          results: [],
          method: 'error',
          error: 'not used in renderer coverage',
        }),
        imageSearch: async () => ({
          images: [],
          method: 'error',
          error: 'not used in renderer coverage',
        }),
        fetchImage: async () => null,
        aiGenerateImage: async () => ({ error: 'not used in renderer coverage' }),
      }
    },
    { text: rebase ? rebaseSource : text, enabled, rebase },
  )
  await page.goto(`http://localhost:${Number(process.env.MARKDOWN_DEV_PORT) || 5177}`)
  await expect(page.locator('.doc-editor')).toBeVisible()
}

export async function requestSave(
  page: Page,
  mode: 'save' | 'saveAs' = 'save',
): Promise<MarkdownSaveCompletion> {
  return page.evaluate(
    (mode) =>
      new Promise<MarkdownSaveCompletion>((resolve, reject) => {
        const requestId = crypto.randomUUID()
        const complete = (event: Event) => {
          const result = (event as CustomEvent<MarkdownSaveCompletion>).detail
          if (result.requestId !== requestId) return
          window.removeEventListener('test:save-ack', complete)
          if (result.error) reject(new Error(result.error))
          else resolve(result)
        }
        window.addEventListener('test:save-ack', complete)
        window.dispatchEvent(
          new CustomEvent(mode === 'saveAs' ? 'test:save-as' : 'test:save', {
            detail: { requestId },
          }),
        )
      }),
    mode,
  )
}
