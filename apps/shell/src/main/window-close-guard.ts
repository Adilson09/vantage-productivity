import { app, type BrowserWindow } from 'electron'
import type { TabManager } from './tab-manager'
import { rootQuitIntent } from './root-quit-intent'
import { closeRootDocumentGroup } from './root-close-preparation'
import { prepareRootClose } from './root-close-adapters'
export interface QuitTracker {
  quitting(): boolean
  hold(): void
  release(): void
  reset(): void
  quit(): void
}
function electronQuitTracker(): QuitTracker {
  let quitting = false,
    holds = 0,
    pass = 0
  app.on('before-quit', () => {
    quitting = true
    const captured = ++pass
    setImmediate(() => {
      if (pass === captured && holds === 0) quitting = false
    })
  })
  return {
    quitting: () => quitting,
    hold: () => {
      ++holds
    },
    release: () => {
      holds = Math.max(0, holds - 1)
      if (holds === 0) quitting = false
    },
    reset: () => {
      ++pass
      quitting = false
    },
    quit: () => app.quit(),
  }
}
let shared: QuitTracker | undefined
export function shellQuitTracker(): QuitTracker {
  return (shared ??= electronQuitTracker())
}
/** Every live editor participates, including clean main mirrors and unposted UI state. */
export function installShellCloseGuard(
  win: BrowserWindow,
  manager: TabManager,
  quitTracker: QuitTracker = shellQuitTracker(),
): void {
  let closeConfirmed = false,
    promptInFlight = false,
    holdingQuit = false
  win.on('close', (event) => {
    if (closeConfirmed) return
    const tabs = manager.closeGuardTabs()
    if (tabs.length === 0) return
    event.preventDefault()
    if (quitTracker.quitting() && !holdingQuit) {
      holdingQuit = true
      quitTracker.hold()
    }
    if (promptInFlight) return
    promptInFlight = true
    const epoch = rootQuitIntent.capture()
    const sameViews = () => {
      if (win.isDestroyed() || !rootQuitIntent.current(epoch)) return false
      const current = manager.closeGuardTabs()
      return (
        current.length === tabs.length &&
        tabs.every(
          (tab, index) =>
            current[index].id === tab.id &&
            current[index].kind === tab.kind &&
            current[index].webContents === tab.webContents &&
            !tab.webContents.isDestroyed(),
        )
      )
    }
    rootQuitIntent.beginApproval()
    void closeRootDocumentGroup({
      participants: tabs.map((tab) => ({
        key: `${tab.kind}:${tab.id}`,
        prepare: (options) => {
          if (!sameViews()) return Promise.resolve(null)
          manager.activateTab(tab.id)
          return prepareRootClose(tab.kind, tab.webContents, win, options)
        },
      })),
      isCurrent: sameViews,
      subscribeCancel: (listener) => rootQuitIntent.subscribe(listener),
      removeSync: () => {
        if (!sameViews()) return false
        closeConfirmed = true
        try {
          win.destroy()
          return win.isDestroyed()
        } finally {
          if (!win.isDestroyed()) closeConfirmed = false
        }
      },
      blocked: (reason) => rootQuitIntent.cancel(reason),
      report: (error) => console.error('[shell] window close preparation failed:', error),
    })
      .then((removed) => {
        // A later window may have vetoed the same outer Quit during collection.
        if (removed && rootQuitIntent.current(epoch) && quitTracker.quitting()) quitTracker.quit()
      })
      .finally(() => {
        promptInFlight = false
        if (holdingQuit) {
          holdingQuit = false
          quitTracker.release()
        }
      })
  })
}
