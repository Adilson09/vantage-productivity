import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  getCloseCleanupStatus,
  registerCloseCleanupRuntime,
  type CloseCleanupQuitApp,
} from './close-cleanup-runtime'
import type { CloseCleanupStatus } from './close-cleanup'

export type RecoveryStartupMode = 'gui' | 'headless-export'
export interface RecoveryRuntimePublicState {
  phase: 'unconfigured' | 'disabled' | 'ready' | 'unavailable'
  available: boolean
  message: string
  warningCount: number
}
export interface RecoveryBootstrapApp extends CloseCleanupQuitApp {
  getPath(name: 'userData'): string
}
export interface RecoveryBootstrapOptions {
  app: RecoveryBootstrapApp
  userDataRoot: string
  mode: RecoveryStartupMode
  lockAcquired: boolean
}
export class RecoveryRuntimeUnavailable extends Error {
  readonly code = 'RECOVERY_RUNTIME_UNAVAILABLE'
  constructor(message: string) {
    super(message)
    this.name = 'RecoveryRuntimeUnavailable'
  }
}
const canonical = (value: string) =>
  process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
const unavailable =
  'Automatic recovery storage is unavailable. Documents can still open, but recovery-dependent actions are refused. Open Recovery for details; restart after repairing storage.'
const disabled = 'Automatic recovery is disabled for this export process.'
const profileChanged =
  'The recovery profile changed after startup. Recovery-dependent actions are refused; restart this app with the intended profile.'
const validRoot = (value: unknown): value is string =>
  typeof value === 'string' && isAbsolute(value) && value.length <= 4096 && !value.includes('\0')
const warningText = (value: string) => value.replace(/\0/g, '').slice(0, 2048)

/** Injectable policy and bounded warnings; no Electron dependency. A failed
 * registration is sticky because its partial listeners must not be installed twice. */
export function createRecoveryBootstrap(dependencies: {
  register(options: {
    app: CloseCleanupQuitApp
    userDataRoot: string
    warning(status: CloseCleanupStatus): void
  }): void
  preinitialized?(): boolean
}) {
  let phase: RecoveryRuntimePublicState['phase'] = 'unconfigured'
  let profile: string | null = null,
    mode: RecoveryStartupMode | null = null
  let app: RecoveryBootstrapApp | null = null,
    attempted = false
  const warnings = new Map<string, string>(),
    listeners = new Set<() => void>()
  const changed = () => {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        /* observers cannot change admission */
      }
    }
  }
  const warn = (id: string, message: string) => {
    const key = id.replace(/[^a-zA-Z0-9:._-]/g, '').slice(0, 128) || 'recovery'
    warnings.delete(key)
    warnings.set(key, warningText(message))
    while (warnings.size > 32) warnings.delete(warnings.keys().next().value!)
    changed()
  }
  const checkProfile = () => {
    if (phase === 'ready' && app && profile && canonical(app.getPath('userData')) !== profile) {
      phase = 'unavailable'
      warn('recovery-profile-changed', profileChanged)
    }
  }
  const state = (): RecoveryRuntimePublicState => {
    checkProfile()
    return {
      phase,
      available: phase === 'ready',
      message:
        phase === 'unavailable'
          ? unavailable
          : phase === 'disabled'
            ? disabled
            : phase === 'unconfigured'
              ? 'Automatic recovery has not been initialized.'
              : '',
      warningCount: warnings.size,
    }
  }
  const initialize = (options: RecoveryBootstrapOptions): RecoveryRuntimePublicState => {
    if (!validRoot(options.userDataRoot) || !['gui', 'headless-export'].includes(options.mode))
      throw new Error('Invalid main recovery profile configuration.')
    const next = canonical(options.userDataRoot)
    if (profile !== null && (profile !== next || mode !== options.mode)) {
      phase = 'unavailable'
      warn('recovery-profile-changed', profileChanged)
      return state()
    }
    if (options.mode === 'headless-export') {
      if (attempted || dependencies.preinitialized?.()) {
        phase = 'unavailable'
        warn('recovery-profile-changed', profileChanged)
        return state()
      }
      profile = next
      mode = options.mode
      app = options.app
      phase = 'disabled'
      changed()
      return state()
    }
    // The losing GUI process never touches custody storage or installs quit hooks.
    if (!options.lockAcquired)
      return {
        phase: 'disabled',
        available: false,
        message: 'Another process owns this app profile.',
        warningCount: 0,
      }
    if (canonical(options.app.getPath('userData')) !== next)
      throw new Error('Recovery must use the already configured app profile.')
    if (attempted) return state()
    attempted = true
    profile = next
    mode = options.mode
    app = options.app
    try {
      if (dependencies.preinitialized?.())
        throw new Error('Recovery was initialized outside the app-owned bootstrap.')
      dependencies.register({
        app: options.app,
        userDataRoot: options.userDataRoot,
        warning: (status) => {
          const module = /^[a-z]{2,20}$/.test(status.module) ? status.module : 'document'
          warn(
            `cleanup:${module}`,
            `Some ${module} recovery files need review. Open Recovery to inspect retained files. Earlier originals and backups are unchanged.`,
          )
        },
      })
      phase = 'ready'
      changed()
    } catch {
      phase = 'unavailable'
      warn('recovery-unavailable', unavailable)
    }
    return state()
  }
  return {
    initialize,
    state,
    warn,
    require(operation = 'This recovery action'): void {
      const current = state()
      if (!current.available)
        throw new RecoveryRuntimeUnavailable(
          `${warningText(operation).slice(0, 120)} was refused. ${current.message}`,
        )
    },
    subscribe(listener: () => void): () => void {
      if (listeners.size >= 32) throw new Error('Too many recovery status observers.')
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    flushWarnings(deliver: (message: string) => boolean): void {
      for (const [id, message] of [...warnings]) {
        let delivered = false
        try {
          delivered = deliver(message) === true
        } catch {
          /* keep queued for a live host */
        }
        if (!delivered) break
        if (warnings.get(id) === message) warnings.delete(id)
      }
    },
  }
}
type Bootstrap = ReturnType<typeof createRecoveryBootstrap>
const globals = globalThis as typeof globalThis & { __vantageRecoveryBootstrap?: Bootstrap }
function bootstrap(): Bootstrap {
  return (globals.__vantageRecoveryBootstrap ??= createRecoveryBootstrap({
    register: registerCloseCleanupRuntime,
    preinitialized: () => {
      try {
        getCloseCleanupStatus('bootstrap-probe')
        return true
      } catch {
        return false
      }
    },
  }))
}
export const initializeRecoveryRuntime = (
  options: RecoveryBootstrapOptions,
): RecoveryRuntimePublicState => bootstrap().initialize(options)
export const recoveryRuntimeState = (): RecoveryRuntimePublicState => bootstrap().state()
export const requireRecoveryRuntime = (operation?: string): void => bootstrap().require(operation)
export const queueRecoveryWarning = (id: string, message: string): void =>
  bootstrap().warn(id, message)
export const flushRecoveryWarnings = (deliver: (message: string) => boolean): void =>
  bootstrap().flushWarnings(deliver)
export const onRecoveryRuntimeState = (listener: () => void): (() => void) =>
  bootstrap().subscribe(listener)

/** Standalone entrypoints select their established profile and acquire their
 * instance lock first. Warnings belong to the app, never a disposable renderer. */
export function initializeStandaloneRecovery(
  options: RecoveryBootstrapOptions & {
    warning(message: string): void
    terminal(cleanup: () => void): void
  },
): RecoveryRuntimePublicState {
  const state = initializeRecoveryRuntime(options)
  let stopped = false,
    scheduled = false
  const replay = () => {
    if (stopped || scheduled) return
    scheduled = true
    void options.app.whenReady().then(
      () => {
        scheduled = false
        if (stopped) return
        flushRecoveryWarnings((message) => {
          options.warning(message)
          return true
        })
      },
      () => {
        scheduled = false
      },
    )
  }
  const unsubscribe = onRecoveryRuntimeState(replay)
  options.terminal(() => {
    stopped = true
    unsubscribe()
  })
  replay()
  return state
}

/** Call before registering ANY editor services. Headless always uses fresh
 * scratch, ignoring inherited GUI overrides and exporting no user credentials.
 * The caller owns this temporary profile; no unsafe recursive deletion is done. */
export function configureRecoveryProfile(options: {
  app: { getPath(name: 'userData'): string; setPath(name: 'userData', value: string): void }
  mode: RecoveryStartupMode
  guiProfile: string
  environment?: Record<string, string | undefined>
  io?: { temporary(): string; ensure(path: string): void }
}): Readonly<{ userDataRoot: string; mode: RecoveryStartupMode }> {
  const env = options.environment ?? process.env
  const io = options.io ?? {
    temporary: () => mkdtempSync(join(tmpdir(), 'vantage-export-profile-')),
    ensure: (path) => {
      mkdirSync(path, { recursive: true, mode: 0o700 })
    },
  }
  const profile = options.mode === 'headless-export' ? io.temporary() : options.guiProfile
  if (!validRoot(profile))
    throw new Error('Select an absolute app profile before recovery startup.')
  io.ensure(profile)
  options.app.setPath('userData', profile)
  env.VANTAGE_USER_DATA = profile
  env.VANTAGE_RECOVERY_ROOT = join(profile, 'recovery')
  env.VANTAGE_RECOVERY_EXCLUDE_ROOT = profile
  env.VANTAGE_RECOVERY_MODE = options.mode === 'gui' ? 'gui' : 'disabled-headless'
  return Object.freeze({ userDataRoot: profile, mode: options.mode })
}
