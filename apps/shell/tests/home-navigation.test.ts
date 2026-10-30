// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { defaultAiSettings } from '@vantage/ai-provider'
import { Home } from '../src/renderer/src/Home'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { FolderRoot, RecentEntry } from '../src/shared/home-api'

let root: Root
let container: HTMLDivElement
let folderRoots: FolderRoot[]
let previousVantage: Window['vantage']
const files: RecentEntry[] = [
  {
    path: '/fixtures/brief.docx',
    name: 'brief.docx',
    ext: 'docx',
    mtimeMs: 1,
    sizeBytes: 10,
    starred: true,
  },
  {
    path: '/fixtures/budget.xlsx',
    name: 'budget.xlsx',
    ext: 'xlsx',
    mtimeMs: 2,
    sizeBytes: 20,
    starred: false,
  },
]
const page = (starred: boolean) =>
  vi.fn(async (query: { ext?: string; limit?: number }) => {
    const entries = files.filter(
      (file) => (!starred || file.starred) && (!query.ext || file.ext === query.ext),
    )
    return {
      entries: query.limit === 0 ? [] : entries,
      total: entries.length,
      totalAll: entries.length,
      offset: 0,
    }
  })

beforeEach(async () => {
  folderRoots = []
  previousVantage = window.vantage
  delete window.vantage
  localStorage.removeItem('home.folderTree')
  HTMLElement.prototype.scrollTo = vi.fn()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No network in navigation tests')
    }),
  )
  window.aiOffice = {
    folderRoots: vi.fn(async () => folderRoots),
    listFolder: vi.fn(async (dir: string) => ({ dir, folders: [], files: [] })),
    onFolderChanged: () => () => {},
    recents: page(false),
    starred: page(true),
    starredGroups: async () => [],
    accountStatus: async () => ({ loggedIn: false }),
    onOpenSettings: () => () => {},
    onAccountLogin: () => () => {},
    kbList: async () => [],
    aiGetSettings: async () => defaultAiSettings(),
    aiGskStatus: async () => ({ loggedIn: false }),
    onAiSettingsChanged: () => () => {},
  } as unknown as Window['aiOffice']
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(createElement(LocaleProvider, { initial: 'en', children: createElement(Home) })),
  )
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  if (previousVantage) window.vantage = previousVantage
  else delete window.vantage
  vi.unstubAllGlobals()
})
function nav(label: string): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>('.sidebar-nav button')].find(
    (button) => button.querySelector('.nav-label')?.textContent === label,
  )!
}
async function click(element: HTMLElement) {
  expect(element).toBeTruthy()
  await act(async () => element.click())
}
function selected(): string[] {
  return [...container.querySelectorAll('.sidebar-nav .active .nav-label')].map(
    (label) => label.textContent!,
  )
}

describe('Home sidebar navigation', () => {
  it('preserves open tools and unsaved inputs when a real root refresh leaves the folder view', async () => {
    const engineeringStatus = vi.fn(async () => ({
      version: 'test',
      runtime: { node: 'test', electron: 'test', platform: 'test' },
      networkPolicy: {
        localOnly: true,
        features: {
          ai: false,
          mail: false,
          calendar: false,
          collaboration: false,
          updates: false,
          assets: false,
          telemetry: false,
        },
        origins: {},
      },
      engines: [],
      metrics: { processes: 1, workingSetKiB: 0, cpuPercent: 0 },
    }))
    window.vantage = {
      engineeringStatus,
      recoveryStatus: async () => ({
        policy: { maxVaultBytes: 1, maxEntries: 1, maxRevisionsPerFile: 1, minFreeBytes: 0 },
        entries: 0,
        payloadBytes: 0,
        occupiedBytes: 0,
        orphanBytes: 0,
        availableBytes: null,
        encryptionEnabled: false,
        plaintextEntries: 0,
      }),
      draftList: async () => [],
      calendarWorkspaceStatus: async () => ({ calendars: [], outbox: [] }),
    } as unknown as Window['vantage']
    const rootA: FolderRoot = {
      path: '/fixtures/folder-a',
      name: 'Folder A',
      usable: true,
      readable: true,
      removable: false,
    }
    folderRoots = [rootA]
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    const rootRow = container.querySelector<HTMLElement>(
      '[role="treeitem"][title="/fixtures/folder-a"]',
    )!
    await click(rootRow)
    expect(rootRow.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('.vantage-workspace')?.classList.contains('is-compact')).toBe(
      true,
    )

    const openTools = () =>
      [...container.querySelectorAll<HTMLButtonElement>('.vantage-tool-card')].find(
        (button) => button.querySelector('strong')?.textContent === 'Tools and privacy',
      )!
    const sectionButton = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>('.vantage-engine-tabs button')].find(
        (button) => button.textContent === label,
      )!
    const calendarName = () =>
      [...container.querySelectorAll<HTMLLabelElement>('.vantage-modal label')]
        .find((label) => label.textContent?.trim() === 'New calendar name')!
        .querySelector<HTMLInputElement>('input')!
    const closeTools = () =>
      container.querySelector<HTMLButtonElement>('.vantage-modal [aria-label="Close dialog"]')!
    const namedButton = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>('.vantage-modal button')].find(
        (button) => button.textContent?.trim() === label,
      )!

    await click(openTools())
    const dialog = container.querySelector<HTMLElement>('.vantage-modal[role="dialog"]')!
    expect(dialog).not.toBeNull()
    await click(sectionButton('Document engines'))
    const profile = container.querySelector<HTMLSelectElement>('[aria-label="PDF standard"]')!
    await act(async () => {
      profile.value = 'ua1'
      profile.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(profile.value).toBe('ua1')
    await click(sectionButton('Calendar and contacts'))
    const input = calendarName()
    input.focus()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'Unsubmitted calendar',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(input.value).toBe('Unsubmitted calendar')

    // Exercise Home's actual focus -> refresh -> loadRoot path, without clicking
    // through the modal, calling private setters, or duplicating its JSX tree.
    folderRoots = [{ ...rootA, path: '/fixtures/folder-b', name: 'Folder B' }]
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(container.querySelector('.tree-row.active')).toBeNull()
    expect(container.querySelector('.vantage-workspace')?.classList.contains('is-compact')).toBe(
      false,
    )
    expect(container.querySelector('.vantage-workspace-header h1')).not.toBeNull()
    expect(container.querySelector('.vantage-modal[role="dialog"]')).toBe(dialog)
    expect(dialog.isConnected).toBe(true)
    expect(calendarName()).toBe(input)
    expect(calendarName().value).toBe('Unsubmitted calendar')
    expect(engineeringStatus).toHaveBeenCalledTimes(1)
    await click(sectionButton('Document engines'))
    expect(container.querySelector<HTMLSelectElement>('[aria-label="PDF standard"]')!.value).toBe(
      'ua1',
    )

    await click(closeTools())
    expect(
      container.querySelector('[role="alertdialog"][aria-label="Unsaved calendar changes"]'),
    ).not.toBeNull()
    await click(namedButton('Keep editing calendar'))
    expect(container.querySelector('.vantage-modal[role="dialog"]')).toBe(dialog)
    await click(sectionButton('Calendar and contacts'))
    expect(calendarName().value).toBe('Unsubmitted calendar')
    await click(closeTools())
    await click(namedButton('Discard calendar changes and close'))
    expect(container.querySelector('.vantage-modal[role="dialog"]')).toBeNull()

    await click(openTools())
    expect(container.querySelector('.vantage-modal[role="dialog"]')).not.toBe(dialog)
    await click(sectionButton('Document engines'))
    expect(container.querySelector<HTMLSelectElement>('[aria-label="PDF standard"]')!.value).toBe(
      '',
    )
    await click(sectionButton('Calendar and contacts'))
    expect(calendarName().value).toBe('')
    await click(closeTools())
    expect(container.querySelector('.vantage-modal[role="dialog"]')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['Recent', 'Starred'])('shows only Ask AI as selected after leaving %s', async (from) => {
    await click(nav(from))
    expect(selected()).toEqual([from])
    await click(nav('Ask AI'))
    expect(container.querySelector('.kb-ask')).not.toBeNull()
    expect(selected()).toEqual(['Ask AI'])
    expect(nav('Ask AI').getAttribute('aria-current')).toBe('page')
    expect(nav(from).hasAttribute('aria-current')).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    await click(nav(from))
    expect(selected()).toEqual([from])
    expect(nav(from).getAttribute('aria-current')).toBe('page')
    expect(container.querySelector('.kb-ask')).toBeNull()
    expect(container.querySelector('.content')?.textContent).toContain('brief.docx')
    if (from === 'Starred')
      expect(container.querySelector('.content')?.textContent).not.toContain('budget.xlsx')
  })

  it('keeps the file-type filter when returning from Ask AI', async () => {
    const docs = [...container.querySelectorAll<HTMLButtonElement>('.filter-pill')].find(
      (button) => button.textContent === 'Docs',
    )!
    await click(docs)
    expect(container.querySelector('.content')?.textContent).toContain('brief.docx')
    expect(container.querySelector('.content')?.textContent).not.toContain('budget.xlsx')
    await click(nav('Ask AI'))
    expect(selected()).toEqual(['Ask AI'])
    await click(nav('Recent'))
    expect(container.querySelector('.filter-pill.active')?.textContent).toBe('Docs')
    expect(container.querySelector('.content')?.textContent).toContain('brief.docx')
    expect(container.querySelector('.content')?.textContent).not.toContain('budget.xlsx')
    expect(window.aiOffice.recents).toHaveBeenLastCalledWith(
      expect.objectContaining({ ext: 'docx' }),
    )
  })
})
