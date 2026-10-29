// Aster Office modification (2026): accessible creation, command, and quality workspace.
import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type {
  AsterApi,
  AsterMailLaunchResult,
  RecoveryEntry,
  WorkspaceAuditCheck,
  WorkspaceAuditResult,
} from '../../shared/aster-api'
import { FileBadge } from './file-badge'
import './AsterWorkspace.css'

export interface AsterCreateItem {
  ext: string
  title: string
  sub: string
  action: () => Promise<void>
}

interface AsterWorkspaceProps {
  items: AsterCreateItem[]
  greeting?: string
  greetingLang?: string
  compact?: boolean
  controllerOnly?: boolean
  location?: string
  onOpen: () => Promise<void>
  onOpenPath?: (path: string) => Promise<void>
  onSettings: () => void
  onSearch: () => void
}

interface Command {
  id: string
  title: string
  detail: string
  keywords: string
  icon: ReactNode
  run: () => void | Promise<void>
}

// Validate IPC payloads before display; browser previews do not invent results.
function desktopBridge(): AsterApi | undefined {
  return window.aster
}

/** A successful launch is a native-window handoff, not proof of an inbox or account. */
export async function launchAsterMail(
  api: Pick<AsterApi, 'openMail'> | undefined,
): Promise<AsterMailLaunchResult> {
  if (typeof api?.openMail !== 'function') {
    throw new Error(
      'Aster Mail is unavailable in this build. Use an Aster Office build that includes the mail companion.',
    )
  }
  const value: unknown = await api.openMail()
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as AsterMailLaunchResult).opened !== 'boolean' ||
    ((value as AsterMailLaunchResult).error !== undefined &&
      typeof (value as AsterMailLaunchResult).error !== 'string')
  ) {
    throw new Error('The Aster Mail launch result could not be read. Please try again.')
  }
  const result = value as AsterMailLaunchResult
  if (!result.opened) {
    throw new Error(result.error?.trim() || 'Aster Mail could not be opened. Please try again.')
  }
  return result
}

export function readAsterQualityReport(value: unknown): WorkspaceAuditResult {
  const report = value as Partial<WorkspaceAuditResult> | null
  if (
    !report ||
    typeof report.fileName !== 'string' ||
    typeof report.filePath !== 'string' ||
    !['docx', 'xlsx', 'pptx', 'pdf', 'md', 'html'].includes(report.kind ?? '') ||
    typeof report.scannedAt !== 'string' ||
    typeof report.bytes !== 'number' ||
    !Number.isFinite(report.bytes) ||
    report.bytes < 0 ||
    typeof report.scope !== 'string' ||
    !report.summary ||
    !['passed', 'warnings', 'failed', 'informational'].every((key) => {
      const count = report.summary?.[key as keyof WorkspaceAuditResult['summary']]
      return typeof count === 'number' && Number.isFinite(count) && count >= 0
    }) ||
    !Array.isArray(report.checks) ||
    !report.checks.every(
      (check) =>
        check &&
        typeof check.id === 'string' &&
        typeof check.title === 'string' &&
        typeof check.detail === 'string' &&
        ['pass', 'warning', 'fail', 'info'].includes(check.status),
    )
  ) {
    throw new Error('The inspection result could not be read. Please check the file again.')
  }
  return report as WorkspaceAuditResult
}
export function readAsterRecoveryEntries(value: unknown): RecoveryEntry[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) =>
        entry &&
        typeof entry.id === 'string' &&
        typeof entry.originalPath === 'string' &&
        typeof entry.fileName === 'string' &&
        typeof entry.createdAt === 'string' &&
        typeof entry.sha256 === 'string' &&
        typeof entry.bytes === 'number' &&
        Number.isFinite(entry.bytes) &&
        entry.bytes >= 0,
    )
  ) {
    throw new Error('The recovery list could not be read. Refresh to try again.')
  }
  return value as RecoveryEntry[]
}

const DESCRIPTIONS: Record<string, string> = {
  docx: 'Find the right words.',
  xlsx: 'Turn numbers into clarity.',
  pptx: 'Give your ideas a stage.',
  pdf: 'Work directly on the page.',
  md: 'Keep your thinking in flow.',
  html: 'Shape something for the web.',
}
const EDITOR_NAMES: Record<string, string> = {
  docx: 'Document',
  xlsx: 'Spreadsheet',
  pptx: 'Presentation',
  pdf: 'PDF',
  md: 'Markdown',
  html: 'HTML',
}
const CREATE_LABELS: Record<string, string> = {
  docx: 'Create document',
  xlsx: 'Create spreadsheet',
  pptx: 'Create presentation',
  pdf: 'Create PDF',
  md: 'Create Markdown',
  html: 'Create HTML',
}
const ORDER = ['docx', 'xlsx', 'pptx', 'pdf', 'md', 'html']

function LineIcon({
  name,
}: {
  name: 'arrow' | 'open' | 'search' | 'check' | 'history' | 'settings' | 'close' | 'mail'
}) {
  const paths: Record<string, ReactNode> = {
    arrow: (
      <>
        <path d="M4 8h8M9 4l4 4-4 4" />
      </>
    ),
    open: (
      <>
        <path d="M2 5V3.5A1.5 1.5 0 0 1 3.5 2h3L8 4h4.5A1.5 1.5 0 0 1 14 5.5V7M2 6h12l-2 7H1z" />
      </>
    ),
    search: (
      <>
        <circle cx="6.8" cy="6.8" r="4.5" />
        <path d="m10.2 10.2 3.6 3.6" />
      </>
    ),
    check: (
      <>
        <path d="m8 1 5.5 2v4.6c0 3-2.1 5.5-5.5 7.4C4.6 13.1 2.5 10.6 2.5 7.6V3z" />
        <path d="m5 8 2 2 4-4" />
      </>
    ),
    history: (
      <>
        <path d="M2 6a6 6 0 1 1 .2 5M2 2v4h4M8 4.5V8l2.5 1.5" />
      </>
    ),
    settings: (
      <>
        <circle cx="8" cy="8" r="2.3" />
        <path d="m6 1-.5 2-1.5.9-2-.6-1 1.8L2.5 7v2L1 10.9l1 1.8 2-.6 1.5.9.5 2h4l.5-2 1.5-.9 2 .6 1-1.8L13.5 9V7L15 5.1l-1-1.8-2 .6-1.5-.9L10 1z" />
      </>
    ),
    close: <path d="m4 4 8 8M12 4l-8 8" />,
    mail: (
      <>
        <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
        <path d="m2 4 6 4.5L14 4" />
      </>
    ),
  }
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}

/** Match every query word against visible command copy and explicit keywords. */
export function matchesAsterCommand(
  command: Pick<Command, 'title' | 'detail' | 'keywords'>,
  query: string,
): boolean {
  const haystack = `${command.title} ${command.detail} ${command.keywords}`.toLowerCase()
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word))
}

function Modal({
  title,
  description,
  onClose,
  children,
  className = '',
}: {
  title: string
  description?: string
  onClose: () => void
  children: ReactNode
  className?: string
}) {
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const first =
      panel.current?.querySelector<HTMLElement>('[data-aster-autofocus]:not([disabled])') ??
      panel.current?.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex="0"]',
      )
    first?.focus()
    return () => {
      if (previous?.isConnected) previous.focus()
      else document.querySelector<HTMLButtonElement>('.aster-command-trigger')?.focus()
    }
  }, [])
  const handleKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(
      panel.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), a[href], [tabindex="0"]',
      ) ?? [],
    )
    if (!focusable.length) {
      event.preventDefault()
      panel.current?.focus()
      return
    }
    const current = document.activeElement
    if (
      event.shiftKey &&
      (current === focusable[0] || current === panel.current || !panel.current?.contains(current))
    ) {
      event.preventDefault()
      focusable[focusable.length - 1]?.focus()
    } else if (
      !event.shiftKey &&
      (current === focusable[focusable.length - 1] || !panel.current?.contains(current))
    ) {
      event.preventDefault()
      focusable[0]?.focus()
    }
  }
  return (
    <div
      className="aster-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panel}
        className={`aster-modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-description` : undefined}
        tabIndex={-1}
        onKeyDown={handleKey}
        lang="en"
      >
        <header className="aster-modal-head">
          <div>
            <p className="aster-eyebrow">ASTER OFFICE</p>
            <h2 id={`${id}-title`}>{title}</h2>
            {description && <p id={`${id}-description`}>{description}</p>}
          </div>
          <button className="aster-icon-button" onClick={onClose} aria-label="Close dialog">
            <LineIcon name="close" />
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}

export function AsterWorkspace({
  items,
  greeting,
  greetingLang,
  compact = false,
  controllerOnly = false,
  location,
  onOpen,
  onOpenPath,
  onSettings,
  onSearch,
}: AsterWorkspaceProps) {
  const [palette, setPalette] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [tool, setTool] = useState<'quality' | 'recovery' | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [mailOpening, setMailOpening] = useState(false)
  const [mailStatus, setMailStatus] = useState('')
  const operationInFlight = useRef(false)
  const paletteId = useId()
  const openPalette = () => {
    setQuery('')
    setActive(0)
    setPalette(true)
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'k' &&
        !event.isComposing
      ) {
        if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
        event.preventDefault()
        openPalette()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const invoke = async (action: () => void | Promise<void>) => {
    if (operationInFlight.current) return
    operationInFlight.current = true
    setNotice('')
    setMailStatus('')
    setBusy(true)
    try {
      await action()
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'The action could not be completed. Please try again.',
      )
    } finally {
      operationInFlight.current = false
      setBusy(false)
    }
  }
  const openMail = async () => {
    setMailOpening(true)
    setMailStatus('Opening Aster Mail…')
    try {
      await launchAsterMail(desktopBridge())
      setMailStatus('Aster Mail launch completed. Look for its separate native window.')
    } catch (error) {
      setMailStatus('')
      throw error
    } finally {
      setMailOpening(false)
    }
  }
  const commands: Command[] = [
    {
      id: 'open',
      title: 'Open a file',
      detail: 'Choose a file from this computer',
      keywords: 'browse local import',
      icon: <LineIcon name="open" />,
      run: onOpen,
    },
    ...items.map((item) => ({
      id: item.ext,
      title: CREATE_LABELS[item.ext] ?? item.title,
      detail: `${EDITOR_NAMES[item.ext] ?? item.ext} · ${item.sub}`,
      keywords: `new create ${item.ext} ${EDITOR_NAMES[item.ext] ?? ''} ${item.title}`,
      icon: <FileBadge ext={item.ext} size={24} />,
      run: item.action,
    })),
    {
      id: 'mail',
      title: 'Open Aster Mail',
      detail: 'Launch the mail companion in a separate native window',
      keywords: 'mail email e-mail depesha inbox messages companion native window',
      icon: <LineIcon name="mail" />,
      run: openMail,
    },
    {
      id: 'quality',
      title: 'Check a document',
      detail: 'Review file structure and quality findings',
      keywords: 'inspect audit quality accessibility compatibility',
      icon: <LineIcon name="check" />,
      run: () => setTool('quality'),
    },
    {
      id: 'recovery',
      title: 'Open recovery vault',
      detail: 'Review local recovery snapshots',
      keywords: 'backup restore version history recover',
      icon: <LineIcon name="history" />,
      run: () => setTool('recovery'),
    },
    {
      id: 'search',
      title: 'Search your files',
      detail: 'Find names and indexed document text',
      keywords: 'find files search recent',
      icon: <LineIcon name="search" />,
      run: onSearch,
    },
    {
      id: 'settings',
      title: 'Settings',
      detail: 'Appearance, AI providers and preferences',
      keywords: 'preferences theme language models',
      icon: <LineIcon name="settings" />,
      run: onSettings,
    },
  ]
  const filtered = commands.filter((command) => matchesAsterCommand(command, query))
  const safeActive = Math.min(active, Math.max(0, filtered.length - 1))
  const activeId = filtered.length ? `${paletteId}-${filtered[safeActive]!.id}` : undefined
  useEffect(() => {
    if (palette && activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [palette, activeId])
  const execute = (command: Command) => {
    if (operationInFlight.current) return
    setPalette(false)
    void invoke(command.run)
  }
  const sorted = [...items].sort((a, b) => ORDER.indexOf(a.ext) - ORDER.indexOf(b.ext))
  return (
    <div
      className={`aster-workspace${compact ? ' is-compact' : ''}${controllerOnly ? ' is-controller' : ''}`}
      lang="en"
    >
      {!controllerOnly && (
        <>
          {!compact && (
            <header className="aster-workspace-header">
              <div>
                <p className="aster-eyebrow">YOUR WORK, IN ONE PLACE</p>
                <h1 lang={greeting ? greetingLang : undefined}>
                  {greeting || 'A little space for big ideas.'}
                </h1>
                <p className="aster-intro">
                  Write, calculate, present. Make something that moves your work forward.
                </p>
              </div>
              <button
                className="aster-command-trigger"
                onClick={openPalette}
                aria-haspopup="dialog"
                aria-label="Find a command"
              >
                <LineIcon name="search" />
                <span>Find a command</span>
                <kbd>Ctrl K</kbd>
              </button>
            </header>
          )}
          <div className="aster-location-row">
            <span className="aster-local-label">
              <span aria-hidden="true" className="aster-local-dot" />
              Local workspace
            </span>
            <span className="aster-location" title={location} dir="auto">
              {location || 'Files stay in the folders you choose'}
            </span>
            <button
              className="aster-text-button"
              onClick={() => void invoke(onOpen)}
              aria-disabled={busy}
            >
              Open file
              <LineIcon name="open" />
            </button>
            {compact && (
              <button className="aster-text-button" onClick={openPalette} aria-haspopup="dialog">
                Commands<kbd>Ctrl K</kbd>
              </button>
            )}
          </div>
          <div className="aster-create-grid" role="group" aria-label="Create a file">
            {sorted.map((item) => (
              <button
                key={item.ext}
                className={`aster-create-card aster-create-${item.ext}`}
                aria-label={CREATE_LABELS[item.ext] ?? item.title}
                onClick={() => void invoke(item.action)}
                aria-disabled={busy}
              >
                <span className="aster-create-icon">
                  <FileBadge ext={item.ext} size={34} />
                </span>
                <span className="aster-create-kind">{EDITOR_NAMES[item.ext] ?? item.ext}</span>
                <strong>{CREATE_LABELS[item.ext] ?? item.title}</strong>
                <span className="aster-create-description">
                  {DESCRIPTIONS[item.ext] ?? item.sub}
                </span>
                <span className="aster-create-footer">
                  <span>{item.sub}</span>
                  <LineIcon name="arrow" />
                </span>
              </button>
            ))}
          </div>
          <div className="aster-tools-row">
            <button className="aster-tool-card" onClick={() => setTool('quality')}>
              <span className="aster-tool-symbol">
                <LineIcon name="check" />
              </span>
              <span>
                <strong>A clearer view before you share</strong>
                <span>Inspect a file for quality and structural findings.</span>
              </span>
              <LineIcon name="arrow" />
            </button>
            <button className="aster-tool-card" onClick={() => setTool('recovery')}>
              <span className="aster-tool-symbol">
                <LineIcon name="history" />
              </span>
              <span>
                <strong>A way back to your work</strong>
                <span>Review local snapshots in the recovery vault.</span>
              </span>
              <LineIcon name="arrow" />
            </button>
          </div>
          <button
            className="aster-tool-card aster-mail-companion"
            aria-label="Open Aster Mail"
            aria-disabled={busy}
            aria-busy={mailOpening}
            onClick={() => void invoke(openMail)}
          >
            <span className="aster-tool-symbol">
              <LineIcon name="mail" />
            </span>
            <span>
              <strong>Aster Mail</strong>
              <span>Email in a separate native window.</span>
            </span>
            <span className="aster-mail-action" aria-hidden="true">
              {mailOpening ? 'Opening…' : 'Open mail'}
              <LineIcon name="arrow" />
            </span>
          </button>
          <p className="aster-mail-status" role="status" aria-live="polite">
            {mailStatus}
          </p>
          <p className="aster-workspace-notice" role="status" aria-live="polite">
            {notice}
          </p>
        </>
      )}
      {palette && (
        <Modal
          title="What would you like to do?"
          onClose={() => setPalette(false)}
          className="aster-command-modal"
        >
          <div className="aster-command-search">
            <LineIcon name="search" />
            <input
              data-aster-autofocus
              role="combobox"
              aria-label="Search commands"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-controls={`${paletteId}-list`}
              aria-activedescendant={activeId}
              placeholder="Search commands, editors, or tools…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(0)
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setActive(filtered.length ? (safeActive + 1) % filtered.length : 0)
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setActive(
                    filtered.length ? (safeActive - 1 + filtered.length) % filtered.length : 0,
                  )
                } else if (event.key === 'Enter' && filtered[safeActive]) {
                  event.preventDefault()
                  execute(filtered[safeActive]!)
                }
              }}
            />
          </div>
          <div
            id={`${paletteId}-list`}
            role="listbox"
            aria-label="Commands"
            className="aster-command-list"
          >
            {filtered.map((command, index) => (
              <button
                key={command.id}
                id={`${paletteId}-${command.id}`}
                role="option"
                tabIndex={-1}
                aria-selected={index === safeActive}
                aria-disabled={busy}
                className={index === safeActive ? 'is-active' : ''}
                onMouseEnter={() => setActive(index)}
                onClick={() => execute(command)}
              >
                {command.icon}
                <span>
                  <strong>{command.title}</strong>
                  <span>{command.detail}</span>
                </span>
                <LineIcon name="arrow" />
              </button>
            ))}
            {!filtered.length && (
              <p className="aster-no-results">
                No matching commands. Try “document”, “open”, or “recovery”.
              </p>
            )}
          </div>
          {controllerOnly && notice && (
            <p className="aster-workspace-notice" role="status">
              {notice}
            </p>
          )}
          <footer className="aster-command-footer">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> navigate
            </span>
            <span>
              <kbd>Enter</kbd> run
            </span>
            <span>
              <kbd>Esc</kbd> close
            </span>
          </footer>
        </Modal>
      )}
      {tool && <AsterToolPanel tool={tool} onClose={() => setTool(null)} onOpenPath={onOpenPath} />}
      {controllerOnly && notice && !palette && (
        <div className="aster-controller-notice" role="alert">
          <span>{notice}</span>
          <button onClick={() => setNotice('')} aria-label="Dismiss error">
            <LineIcon name="close" />
          </button>
        </div>
      )}
      {controllerOnly && mailStatus && !notice && !palette && (
        <div className="aster-controller-notice is-status" role="status" aria-live="polite">
          <span>{mailStatus}</span>
          {!mailOpening && (
            <button onClick={() => setMailStatus('')} aria-label="Dismiss mail status">
              <LineIcon name="close" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function AsterToolPanel({
  tool,
  onClose,
  onOpenPath,
}: {
  tool: 'quality' | 'recovery'
  onClose: () => void
  onOpenPath?: (path: string) => Promise<void>
}) {
  return tool === 'quality' ? (
    <QualityPanel onClose={onClose} />
  ) : (
    <RecoveryPanel onClose={onClose} onOpenPath={onOpenPath} />
  )
}

const CHECK_LABELS: Record<WorkspaceAuditCheck['status'], string> = {
  pass: 'Passed',
  warning: 'Needs attention',
  fail: 'Problem found',
  info: 'Information',
}
function QualityPanel({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<WorkspaceAuditResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [cancelled, setCancelled] = useState(false)
  const available = typeof desktopBridge()?.inspectFile === 'function'
  const inspect = async () => {
    if (busy || !available) return
    setBusy(true)
    setError('')
    setCancelled(false)
    try {
      const result = await desktopBridge()!.inspectFile()
      if (result === null) setCancelled(true)
      else setReport(readAsterQualityReport(result))
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'This file could not be checked. Please try again.',
      )
    } finally {
      setBusy(false)
    }
  }
  const attention =
    report?.checks.filter((check) => check.status === 'warning' || check.status === 'fail')
      .length ?? 0
  const passed = report?.checks.filter((check) => check.status === 'pass').length ?? 0
  return (
    <Modal
      title="A clearer view of your document"
      description="Inspect local file structure and selected quality signals. A check is not a guarantee of complete Office compatibility."
      onClose={onClose}
    >
      <div className="aster-panel-toolbar">
        <button
          className="aster-primary-button"
          data-aster-autofocus
          onClick={() => void inspect()}
          disabled={!available}
          aria-disabled={!available || busy}
        >
          <LineIcon name="check" />
          {busy ? 'Checking file…' : report ? 'Check another file' : 'Choose a file to check'}
        </button>
        <span className="aster-panel-caption">The check does not change your file.</span>
      </div>
      <p className="aster-panel-caption">
        Supports DOCX, XLSX, PPTX, PDF, Markdown and HTML files up to 32 MiB. Large or complex files
        may exceed the inspection limits. PDF checks cover file markers; pages are not analyzed.
      </p>
      {!available && (
        <p className="aster-panel-message">
          Document checks are available in the Aster Office desktop app.
        </p>
      )}
      <p className="aster-panel-status" role="status" aria-live="polite">
        {busy
          ? 'Reading the selected file and running its supported checks…'
          : cancelled
            ? report
              ? 'Inspection cancelled. The previous inspection remains below.'
              : 'Inspection cancelled. No new check was run.'
            : report && !error
              ? `Inspection complete: ${report.fileName}`
              : ''}
      </p>
      {error && (
        <p className="aster-tool-error" role="alert">
          {error}
          {report && ' The previous inspection remains below.'}
        </p>
      )}
      {report ? (
        <section aria-label="Inspection result" aria-busy={busy}>
          <div className="aster-result-file">
            <FileBadge ext={report.kind} size={32} />
            <div>
              <h3>{report.fileName}</h3>
              <p title={report.filePath} dir="auto">
                {report.filePath}
              </p>
              <span className="aster-panel-caption">
                Checked {formatLocalDate(report.scannedAt)} · {formatBytes(report.bytes)}
              </span>
            </div>
          </div>
          <div className="aster-check-summary">
            <span>
              <strong>{report.checks.length}</strong> checks reported
            </span>
            <span>
              <strong>{passed}</strong> passed
            </span>
            <span>
              <strong>{attention}</strong> need attention
            </span>
          </div>
          <p className="aster-panel-caption">{report.scope}</p>
          {report.checks.length ? (
            <ul className="aster-check-list">
              {report.checks.map((check, index) => (
                <li key={`${check.id}-${index}`} className={`aster-check is-${check.status}`}>
                  <span className="aster-check-status">{CHECK_LABELS[check.status]}</span>
                  <h4>{check.title}</h4>
                  <p>{check.detail}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="aster-panel-message">
              No checks were reported for this file. Its quality has not been established.
            </p>
          )}
        </section>
      ) : (
        available &&
        !busy && (
          <div className="aster-tool-empty">
            <LineIcon name="check" />
            <h3>Start with the file you plan to share.</h3>
            <p>
              See the checks that passed and the details that deserve a closer look. Your document
              stays unchanged.
            </p>
          </div>
        )
      )}
    </Modal>
  )
}

function formatLocalDate(value: string | number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Date unavailable'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  const unit = value < 1024 * 1024 ? 'KiB' : 'MiB'
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value / (unit === 'KiB' ? 1024 : 1024 * 1024))} ${unit}`
}
function RecoveryPanel({
  onClose,
  onOpenPath,
}: {
  onClose: () => void
  onOpenPath?: (path: string) => Promise<void>
}) {
  const [entries, setEntries] = useState<RecoveryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [restored, setRestored] = useState<string | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const [query, setQuery] = useState('')
  const [visibleLimit, setVisibleLimit] = useState(50)
  const available =
    typeof desktopBridge()?.recoveryList === 'function' &&
    typeof desktopBridge()?.recoveryRestoreCopy === 'function'
  const refresh = async () => {
    if (loading || restoring || !available) return
    setLoading(true)
    setError('')
    try {
      const snapshots = readAsterRecoveryEntries(await desktopBridge()!.recoveryList())
      setEntries(
        [...snapshots].sort(
          (a, b) => (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0),
        ),
      )
      setVisibleLimit(50)
      setLoaded(true)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Recovery snapshots could not be listed. Please refresh.',
      )
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    if (available) void refresh()
  }, [])
  const restore = async (entry: RecoveryEntry) => {
    if (loading || restoring) return
    setRestoring(entry.id)
    setError('')
    setRestored(null)
    setCancelled(false)
    try {
      const result = await desktopBridge()!.recoveryRestoreCopy(entry.id)
      if (result === null) setCancelled(true)
      else if (typeof result === 'string' && result.trim()) setRestored(result)
      else
        throw new Error(
          'The recovered copy location could not be read. Please check your selected folder.',
        )
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'This snapshot could not be recovered. Please try again.',
      )
    } finally {
      setRestoring(null)
    }
  }
  const needle = query.trim().toLowerCase()
  const filtered = entries.filter(
    (entry) => !needle || `${entry.fileName} ${entry.originalPath}`.toLowerCase().includes(needle),
  )
  return (
    <Modal
      title="A way back to your work"
      description="Review the local snapshots recorded by Aster Office. Recovering creates a separate copy and leaves the current document alone."
      onClose={onClose}
    >
      <div className="aster-panel-toolbar">
        <span className="aster-panel-caption" role="status" aria-live="polite">
          {!available
            ? 'Local recovery snapshots'
            : error && !loaded
              ? 'Recovery list unavailable'
              : loading || !loaded
                ? 'Reading recovery vault…'
                : `${entries.length} recorded snapshot${entries.length === 1 ? '' : 's'}`}
        </span>
        <button
          className="aster-secondary-button"
          data-aster-autofocus
          onClick={() => void refresh()}
          disabled={!available}
          aria-disabled={!available || loading || restoring !== null}
        >
          <LineIcon name="history" />
          Refresh
        </button>
      </div>
      <aside className="aster-recovery-policy" aria-label="Recovery limits">
        <strong>How snapshots are kept</strong>
        <p>
          Aster records the previous saved version when it replaces an existing supported document.
          A new document has no previous version on its first save. Previous versions larger than 32
          MiB are excluded.
        </p>
        <p>
          The vault keeps up to 10 versions per file, 128 snapshots, and 128 MiB of document data,
          plus snapshot metadata. Older snapshots are removed as limits are reached. Snapshots stay
          on this computer without added vault encryption. Unencrypted documents remain unencrypted.
        </p>
      </aside>
      {!available && (
        <p className="aster-panel-message">
          The recovery vault is available in the Aster Office desktop app.
        </p>
      )}
      {error && (
        <p className="aster-tool-error" role="alert">
          {error}
        </p>
      )}
      {cancelled && (
        <p className="aster-panel-message" role="status">
          Recovery cancelled. No copy was created.
        </p>
      )}
      {restored && (
        <div className="aster-restore-result" role="status">
          <strong>Recovered copy created</strong>
          <p dir="auto">{restored}</p>
          {onOpenPath && (
            <button
              className="aster-secondary-button"
              onClick={() => {
                void onOpenPath(restored).catch((reason) =>
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : 'The recovered copy could not be opened.',
                  ),
                )
              }}
            >
              Open recovered copy
              <LineIcon name="arrow" />
            </button>
          )}
        </div>
      )}
      {entries.length > 0 && (
        <label className="aster-recovery-search">
          <span>Find a snapshot</span>
          <input
            type="search"
            placeholder="Search by filename or folder…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setVisibleLimit(50)
            }}
          />
        </label>
      )}
      {!loading && loaded && !entries.length && available && !error && (
        <div className="aster-tool-empty">
          <LineIcon name="history" />
          <h3>No snapshots recorded yet.</h3>
          <p>
            Snapshots of earlier saved versions will appear here after an existing supported
            document is saved again. Files without a recorded snapshot cannot be recovered from this
            list.
          </p>
        </div>
      )}
      {entries.length > 0 && (
        <>
          <p className="aster-panel-caption" role="status">
            {needle ? `${filtered.length} matching snapshots` : 'Newest recorded snapshots first'}
          </p>
          <ul
            className="aster-recovery-list"
            aria-label="Recorded recovery snapshots"
            aria-busy={loading}
          >
            {filtered.slice(0, visibleLimit).map((entry) => (
              <li key={entry.id}>
                <div>
                  <h3>{entry.fileName}</h3>
                  <p dir="auto" title={entry.originalPath}>
                    {entry.originalPath}
                  </p>
                  <span>
                    {formatLocalDate(entry.createdAt)} · {formatBytes(entry.bytes)}
                  </span>
                </div>
                <button
                  className="aster-secondary-button"
                  onClick={() => void restore(entry)}
                  aria-disabled={loading || restoring !== null}
                >
                  {restoring === entry.id ? 'Recovering…' : 'Recover a copy'}
                </button>
              </li>
            ))}
          </ul>
          {!filtered.length && (
            <p className="aster-panel-message">
              No snapshots match this search. Try another filename or folder.
            </p>
          )}
          {filtered.length > visibleLimit && (
            <button
              className="aster-secondary-button"
              onClick={() => setVisibleLimit((limit) => limit + 50)}
            >
              Show {Math.min(50, filtered.length - visibleLimit)} more snapshots
            </button>
          )}
        </>
      )}
    </Modal>
  )
}
