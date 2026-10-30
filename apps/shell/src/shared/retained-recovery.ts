export interface RetainedRecoverySelection {
  id: string
  updatedAt: string
}

export interface RetainedRecoveryItem extends RetainedRecoverySelection {
  module: string
  fileName: string
  originalPath: string | null
  state: 'needs-review' | 'closed-copy' | 'canceled-close' | 'working' | 'removing'
  detail: string
  canRestore: boolean
  canRemove: boolean
  canRetry: boolean
  pendingOutput?: { id: string; path: string }
}

export interface RetainedRecoveryList {
  items: RetainedRecoveryItem[]
  truncated: boolean
}

export interface RetainedRecoveryCopy {
  path: string
  module: string
}

export interface RetainedRecoveryApi {
  retainedRecoveryList?(): Promise<RetainedRecoveryList>
  recoverRetainedCopy?(selection: RetainedRecoverySelection): Promise<RetainedRecoveryCopy | null>
  removeRetainedCopy?(selection: RetainedRecoverySelection): Promise<void>
  retryRetainedRecovery?(selection: RetainedRecoverySelection): Promise<void>
  keepRetainedOutput?(selection: RetainedRecoverySelection, outputId: string): Promise<void>
}

const states = new Set(['needs-review', 'closed-copy', 'canceled-close', 'working', 'removing'])
const identifier = /^[a-zA-Z0-9:._-]{1,240}$/

/** Display only the bounded, inert main-process projection, never custody proofs. */
export function readRetainedRecoveryList(value: unknown): RetainedRecoveryList {
  const data = value as RetainedRecoveryList | null
  if (
    !data ||
    !Array.isArray(data.items) ||
    data.items.length > 256 ||
    typeof data.truncated !== 'boolean'
  )
    throw new Error('The retained recovery list could not be read. Please refresh.')
  const seen = new Set<string>()
  const items = data.items.map((item) => {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !identifier.test(item.id) ||
      seen.has(item.id) ||
      typeof item.updatedAt !== 'string' ||
      item.updatedAt.length > 64 ||
      !Number.isFinite(Date.parse(item.updatedAt)) ||
      typeof item.module !== 'string' ||
      item.module.length > 20 ||
      typeof item.fileName !== 'string' ||
      item.fileName.length > 4096 ||
      (item.originalPath !== null &&
        (typeof item.originalPath !== 'string' || item.originalPath.length > 4096)) ||
      !states.has(item.state) ||
      typeof item.detail !== 'string' ||
      item.detail.length > 1024 ||
      typeof item.canRestore !== 'boolean' ||
      typeof item.canRemove !== 'boolean' ||
      typeof item.canRetry !== 'boolean' ||
      (item.pendingOutput !== undefined &&
        (!item.pendingOutput ||
          typeof item.pendingOutput !== 'object' ||
          typeof item.pendingOutput.id !== 'string' ||
          !identifier.test(item.pendingOutput.id) ||
          typeof item.pendingOutput.path !== 'string' ||
          item.pendingOutput.path.length > 4096))
    )
      throw new Error('A retained recovery item could not be read. Please refresh.')
    seen.add(item.id)
    return {
      id: item.id,
      updatedAt: item.updatedAt,
      module: item.module,
      fileName: item.fileName,
      originalPath: item.originalPath,
      state: item.state,
      detail: item.detail,
      canRestore: item.canRestore,
      canRemove: item.canRemove,
      canRetry: item.canRetry,
      ...(item.pendingOutput
        ? { pendingOutput: { id: item.pendingOutput.id, path: item.pendingOutput.path } }
        : {}),
    }
  })
  return { items, truncated: data.truncated }
}
