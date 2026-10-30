import type { DocsCloseReceipt } from '../../docs/src/main/doc-native-close'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The shell window's unsaved-changes guard
 * (src/main/window-close-guard.ts): the clean fast path, the per-app prompt
 * walk, the in-flight debounce and its release. The handler under test is the
 * real one — it takes the window and the tab manager as arguments, so it runs
 * without Electron; only the six app-mains that own the prompts are faked.
 */

const docReceipt:DocsCloseReceipt={kind:'lease' as const,intent:'save' as const,published:false,clean:true,source:'A',closeLease:{ticket:{id:'test-close',sequence:1,source:'main-A'},stamp:{source:'renderer-A',revision:'1'}}}
const prepareDocsNativeClose = vi.fn<(...args:unknown[])=>Promise<DocsCloseReceipt|null>>(async()=>docReceipt)
const completeDocsClose = vi.fn((_contents:unknown,_receipt:unknown,remove:()=>boolean)=>remove())
const cancelDocsClose = vi.fn(async()=>{})
const requestSheetsClose = vi.fn(() => Promise.resolve(true))
const resetSheetsShuttingDown = vi.fn()
const requestSlidesClose = vi.fn(() => Promise.resolve(true))
const requestPdfClose = vi.fn(() => Promise.resolve(true))
const requestMarkdownClose = vi.fn(() => Promise.resolve(true))
const requestHtmlClose = vi.fn(() => Promise.resolve(true))

vi.mock('../../docs/src/main/docs-main', () => ({
  prepareDocsNativeClose: (...args:unknown[])=>prepareDocsNativeClose(...args),
  completeDocsClose: (...args:Parameters<typeof completeDocsClose>)=>completeDocsClose(...args),
  cancelDocsClose: ()=>cancelDocsClose(),
}))

vi.mock('../../sheets/src/main/sheets-main', () => ({
  requestSheetsClose: (...args: unknown[]) => requestSheetsClose(...(args as [])),
  resetSheetsShuttingDown: (...args: unknown[]) => resetSheetsShuttingDown(...(args as [])),
}))

vi.mock('../../slides/src/main/slides-main', () => ({
  requestSlidesClose: (...args: unknown[]) => requestSlidesClose(...(args as [])),
}))

vi.mock('../../pdf/src/main/pdf-main', () => ({
  requestPdfClose: (...args: unknown[]) => requestPdfClose(...(args as [])),
}))

vi.mock('../../markdown/src/main/markdown-main', () => ({
  requestMarkdownClose: (...args: unknown[]) => requestMarkdownClose(...(args as [])),
}))

vi.mock('../../html/src/main/html-main', () => ({
  requestHtmlClose: (...args: unknown[]) => requestHtmlClose(...(args as [])),
}))

interface TabStub {
  id: string
  webContents: { id: number }
}

/**
 * The three members the guard uses off a BrowserWindow, with Electron's close
 * contract intact: a close request is cancelled only by preventDefault, and
 * the programmatic win.close() re-enters the same handler.
 */
class FakeWindow {
  destroyed = false
  closeCalls = 0
  handlers = new Map<string, (...args: never[]) => void>()

  on = (event: string, fn: (...args: never[]) => void): void => {
    this.handlers.set(event, fn)
  }

  isDestroyed = (): boolean => this.destroyed

  close = (): void => {
    this.closeCalls += 1
    this.requestClose()
  }

  destroy = (): void => {
    this.destroyed = true
  }

  /** one close request (⌘Q, the red button, a program): true when cancelled */
  requestClose = (): boolean => {
    let prevented = false
    const event = {
      preventDefault: (): void => {
        prevented = true
      },
    }
    this.handlers.get('close')?.(event as never)
    if (!prevented) this.destroy()
    return prevented
  }
}

type DirtyKinds = 'sheets' | 'pdf' | 'markdown' | 'html' | 'slides' | 'docs'

function fakeManager(dirty: Partial<Record<DirtyKinds, TabStub[]>> = {}) {
  return {
    activateTab: vi.fn(),
    dirtySheetsTabs: () => dirty.sheets ?? [],
    dirtyPdfTabs: () => dirty.pdf ?? [],
    dirtyMarkdownTabs: () => dirty.markdown ?? [],
    dirtyHtmlTabs: () => dirty.html ?? [],
    dirtySlidesTabs: () => dirty.slides ?? [],
    docsTabs: () => dirty.docs ?? [],
  }
}

/** the real tracker's contract without Electron: holds keep the flag alive, reset clears it */
function fakeQuit(quitting = false) {
  let holds = 0
  const tracker = {
    quitting: vi.fn(() => quitting),
    hold: vi.fn(() => {
      holds += 1
    }),
    release: vi.fn(() => {
      holds -= 1
      if (holds === 0) quitting = false
    }),
    reset: vi.fn(() => {
      quitting = false
    }),
    quit: vi.fn(),
    /** before-quit fired: Electron's close pass follows synchronously */
    beginQuit: () => {
      quitting = true
    },
    holds: () => holds,
  }
  return tracker
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

let install: typeof import('../src/main/window-close-guard').installShellCloseGuard
let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  vi.clearAllMocks()
  prepareDocsNativeClose.mockImplementation(async()=>docReceipt)
  completeDocsClose.mockImplementation((_contents,_receipt,remove)=>remove())
  for (const ask of [
    requestSheetsClose,
    requestSlidesClose,
    requestPdfClose,
    requestMarkdownClose,
    requestHtmlClose,
  ]) {
    ask.mockImplementation(() => Promise.resolve(true))
  }
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  install = (await import('../src/main/window-close-guard')).installShellCloseGuard
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('clean fast path', () => {
  it('lets an all-clean close through without cancelling it', () => {
    const win = new FakeWindow()
    install(win as never, fakeManager() as never, fakeQuit())
    // nothing dirty: the close event must not be cancelled — ⌘Q is still in
    // flight, and cancelling it would leave the app running with no window
    expect(win.requestClose()).toBe(false)
    expect(win.destroyed).toBe(true)
    // it closed through the original event, not through a re-issued win.close()
    expect(win.closeCalls).toBe(0)
  })

  it('a live docs tab forces the prompt path (dirtiness is renderer-side)', async () => {
    const win = new FakeWindow()
    const docsTab = { id: 'docs-1', webContents: { id: 1 } }
    install(win as never, fakeManager({ docs: [docsTab] }) as never, fakeQuit())
    expect(win.requestClose()).toBe(true)
    await flush()
    expect(prepareDocsNativeClose).toHaveBeenCalledWith(docsTab.webContents,win,{allowForce:false})
    expect(completeDocsClose).toHaveBeenCalledTimes(1)
    expect(cancelDocsClose).toHaveBeenCalledTimes(1)
    expect(win.destroyed).toBe(true)
  })
})

describe('dirty close', () => {
  it('cancels the close and asks the owning family, keeping the window on cancel', async () => {
    requestSheetsClose.mockResolvedValueOnce(false)
    const win = new FakeWindow()
    const tab = { id: 'sheets-1', webContents: { id: 7 } }
    const manager = fakeManager({ sheets: [tab] })
    install(win as never, manager as never, fakeQuit())
    expect(win.requestClose()).toBe(true)
    await flush()
    expect(requestSheetsClose).toHaveBeenCalledWith(tab.webContents, win)
    // a denied close vetoes the quit that was in flight, so the sheets guard
    // has to prompt again on the next close
    expect(resetSheetsShuttingDown).toHaveBeenCalled()
    expect(win.destroyed).toBe(false)
  })

  it('closes the window once every dirty family has confirmed', async () => {
    const win = new FakeWindow()
    const manager = fakeManager({
      pdf: [{ id: 'p', webContents: { id: 1 } }],
      markdown: [{ id: 'm', webContents: { id: 2 } }],
      html: [{ id: 'h', webContents: { id: 3 } }],
      slides: [{ id: 's', webContents: { id: 4 } }],
    })
    install(win as never, manager as never, fakeQuit())
    expect(win.requestClose()).toBe(true)
    await flush()
    for (const ask of [
      requestPdfClose,
      requestMarkdownClose,
      requestHtmlClose,
      requestSlidesClose,
    ]) {
      expect(ask).toHaveBeenCalledWith(expect.anything(), win)
    }
    expect(win.destroyed).toBe(true)
    expect(win.closeCalls).toBe(1)
  })
})

describe('close that began as ⌘Q', () => {
  it('resumes the quit after a clean docs tab was queried instead of just closing the window', async () => {
    const win = new FakeWindow()
    const quit = fakeQuit(true)
    install(
      win as never,
      fakeManager({ docs: [{ id: 'd', webContents: { id: 1 } }] }) as never,
      quit,
    )
    expect(win.requestClose()).toBe(true)
    // the guard keeps the quit alive while the renderer is being asked
    expect(quit.holds()).toBe(1)
    await flush()
    // finishing with win.close() would leave the app running with no window
    expect(quit.quit).toHaveBeenCalledTimes(1)
    expect(win.closeCalls).toBe(0)
    expect(quit.holds()).toBe(0)
  })

  it('a ⌘Q that arrives while a red-button prompt is open turns the close into a quit', async () => {
    let answer: (value: boolean) => void = () => {}
    requestSheetsClose.mockReturnValue(
      new Promise<boolean>((resolve) => {
        answer = resolve
      }),
    )
    const win = new FakeWindow()
    const quit = fakeQuit(false)
    const tab = { id: 'sheets-1', webContents: { id: 7 } }
    install(win as never, fakeManager({ sheets: [tab] }) as never, quit)
    expect(win.requestClose()).toBe(true)
    quit.beginQuit()
    expect(win.requestClose()).toBe(true)
    answer(true)
    await flush()
    expect(quit.quit).toHaveBeenCalledTimes(1)
    expect(win.closeCalls).toBe(0)
  })

  it('a quit vetoed elsewhere while the prompt is open ends with a plain window close', async () => {
    let answer: (value: boolean) => void = () => {}
    requestSheetsClose.mockReturnValue(
      new Promise<boolean>((resolve) => {
        answer = resolve
      }),
    )
    const win = new FakeWindow()
    const quit = fakeQuit(true)
    install(
      win as never,
      fakeManager({ sheets: [{ id: 's', webContents: { id: 7 } }] }) as never,
      quit,
    )
    expect(win.requestClose()).toBe(true)
    // a detached window denied its own prompt and reset the shared tracker
    quit.reset()
    answer(true)
    await flush()
    expect(quit.quit).not.toHaveBeenCalled()
    expect(win.closeCalls).toBe(1)
    expect(win.destroyed).toBe(true)
  })

  it('a denied prompt leaves the quit cancelled', async () => {
    prepareDocsNativeClose.mockResolvedValueOnce(null)
    const win = new FakeWindow()
    const quit = fakeQuit(true)
    install(
      win as never,
      fakeManager({ docs: [{ id: 'd', webContents: { id: 1 } }] }) as never,
      quit,
    )
    expect(win.requestClose()).toBe(true)
    await flush()
    expect(quit.quit).not.toHaveBeenCalled()
    expect(quit.reset).toHaveBeenCalled()
    expect(win.destroyed).toBe(false)
  })

  it('a Docs window close removes synchronously inside the held receipt', async () => {
    const win = new FakeWindow()
    const quit = fakeQuit(false)
    install(
      win as never,
      fakeManager({ docs: [{ id: 'd', webContents: { id: 1 } }] }) as never,
      quit,
    )
    expect(win.requestClose()).toBe(true)
    await flush()
    expect(quit.quit).not.toHaveBeenCalled()
    expect(win.closeCalls).toBe(0)
    expect(win.destroyed).toBe(true)
  })
})

describe('in-flight debounce', () => {
  it('a second close while the prompt is open is cancelled and never re-prompts', async () => {
    let answer: (value: boolean) => void = () => {}
    requestSheetsClose.mockReturnValue(
      new Promise<boolean>((resolve) => {
        answer = resolve
      }),
    )
    const win = new FakeWindow()
    const tab = { id: 'sheets-1', webContents: { id: 7 } }
    install(win as never, fakeManager({ sheets: [tab] }) as never, fakeQuit())
    expect(win.requestClose()).toBe(true)
    // the prompt dialog is still open: the retry must not stack on top of it
    expect(win.requestClose()).toBe(true)
    await flush()
    expect(requestSheetsClose).toHaveBeenCalledTimes(1)
    expect(win.destroyed).toBe(false)
    answer(false)
    await flush()
  })
})

describe('failure in the prompt chain', () => {
  it('releases the in-flight flag so the window stays closable', async () => {
    requestSheetsClose.mockRejectedValueOnce(new Error('renderer went away'))
    const win = new FakeWindow()
    const manager = fakeManager({ sheets: [{ id: 'sheets-1', webContents: { id: 7 } }] })
    install(win as never, manager as never, fakeQuit())
    expect(win.requestClose()).toBe(true)
    await flush()
    expect(consoleError).toHaveBeenCalled()
    expect(win.destroyed).toBe(false)
    expect(resetSheetsShuttingDown).toHaveBeenCalled()
    // the flag was released, so a later close prompts again instead of being
    // swallowed by the debounce
    expect(win.requestClose()).toBe(true)
    await flush()
    expect(requestSheetsClose).toHaveBeenCalledTimes(2)
  })
})

describe('Docs held actual-removal boundary',()=>{
  it('keeps the window when a ready receipt expires before commit and releases every receipt',async()=>{
    completeDocsClose.mockReturnValueOnce(false)
    const win=new FakeWindow(),quit=fakeQuit(true)
    install(win as never,fakeManager({docs:[{id:'d',webContents:{id:1}}]}) as never,quit)
    win.requestClose();await flush()
    expect(win.destroyed).toBe(false);expect(quit.reset).toHaveBeenCalled();expect(cancelDocsClose).toHaveBeenCalledTimes(1)
  })
  it('refuses whole-window force dispositions instead of carrying destructive approval across later prompts',async()=>{
    prepareDocsNativeClose.mockResolvedValueOnce({kind:'force',id:'force',source:'A',published:false,clean:false})
    const win=new FakeWindow()
    install(win as never,fakeManager({docs:[{id:'d',webContents:{id:1}}]}) as never,fakeQuit())
    win.requestClose();await flush()
    expect(win.destroyed).toBe(false);expect(completeDocsClose).not.toHaveBeenCalled()
  })
})
