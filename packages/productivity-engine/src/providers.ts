export type ProviderFetch = (url: string, init: RequestInit) => Promise<Response>
export interface ProviderOptions {
  enabled: true
  accessToken: string
  fetch?: ProviderFetch
  signal?: AbortSignal
  maxPages?: number
  maxItems?: number
  deadlineMs?: number
  retryLimit?: number
  /** Injectable only for deterministic tests. */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>
}
export type ProviderCheckpoint =
  | { version: 1; provider: 'graph-mail'; url: string }
  | { version: 1; provider: 'gmail-mail'; historyId: string }
  | { version: 1; provider: 'google-calendar'; calendarId: string; token: string }
export interface ProviderSyncResult {
  items: Record<string, unknown>[]
  deletedIds: string[]
  complete: boolean
  checkpoint: ProviderCheckpoint | null
  reason?: 'page-limit' | 'item-limit'
}
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`Provider request failed with HTTP ${status}.`)
    this.name = 'ProviderHttpError'
  }
}
export class ProviderCheckpointExpiredError extends Error {
  constructor() {
    super(
      'The provider checkpoint expired. Start a new full sync; existing local data was not changed.',
    )
    this.name = 'ProviderCheckpointExpiredError'
  }
}

const MAX_RESPONSE = 2 * 1024 * 1024
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Provider returned an invalid object.')
  return value as Record<string, unknown>
}
const list = (value: unknown): Record<string, unknown>[] =>
  value === undefined
    ? []
    : Array.isArray(value)
      ? value.map(record)
      : (() => {
          throw new Error('Provider returned an invalid list.')
        })()
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 2048)
    throw new Error('Provider returned an invalid identifier.')
  return value
}

function trustedUrl(url: string, host: string, prefix: string): string {
  if (url.length > 16384) throw new Error('Provider link exceeds 16 KiB.')
  const parsed = new URL(url)
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== host ||
    (parsed.port && parsed.port !== '443') ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    !parsed.pathname.startsWith(prefix)
  )
    throw new Error('Provider link leaves the authorized API origin or account path.')
  return parsed.href
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('Provider sync cancelled.')
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      reject(new Error('Provider sync cancelled.'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

class Reader {
  readonly maxPages: number
  readonly maxItems: number
  private readonly started = Date.now()
  private requests = 0
  constructor(
    private readonly host: string,
    private readonly prefix: string,
    private readonly options: ProviderOptions,
  ) {
    if (options.enabled !== true)
      throw new Error('Enable this remote provider explicitly before using it.')
    if (
      !options.accessToken ||
      /[\r\n]/.test(options.accessToken) ||
      options.accessToken.length > 16384
    )
      throw new Error('A valid provider access token is required.')
    this.maxPages = options.maxPages ?? 20
    this.maxItems = options.maxItems ?? 1000
    if (
      !Number.isSafeInteger(this.maxPages) ||
      this.maxPages < 1 ||
      this.maxPages > 100 ||
      !Number.isSafeInteger(this.maxItems) ||
      this.maxItems < 1 ||
      this.maxItems > 5000
    )
      throw new Error('Provider page/item limits are invalid.')
    if (
      options.deadlineMs !== undefined &&
      (!Number.isSafeInteger(options.deadlineMs) ||
        options.deadlineMs < 100 ||
        options.deadlineMs > 120000)
    )
      throw new Error('Provider deadline must be 100 to 120,000 ms.')
    if (
      options.retryLimit !== undefined &&
      (!Number.isSafeInteger(options.retryLimit) ||
        options.retryLimit < 0 ||
        options.retryLimit > 3)
    )
      throw new Error('Provider retry limit must be 0 to 3.')
  }
  validate(url: string): string {
    return trustedUrl(url, this.host, this.prefix)
  }
  async get(url: string): Promise<Record<string, unknown>> {
    const safe = this.validate(url)
    const attempts = this.options.retryLimit ?? 2
    for (let attempt = 0; ; attempt++) {
      if (this.options.signal?.aborted) throw new Error('Provider sync cancelled.')
      const remaining = (this.options.deadlineMs ?? 30000) - (Date.now() - this.started)
      if (remaining <= 0 || ++this.requests > 1200)
        throw new Error('Provider sync exceeded its time/request budget.')
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      this.options.signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(abort, Math.min(remaining, 15000))
      let response: Response
      try {
        response = await (this.options.fetch ?? fetch)(safe, {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.options.accessToken}`,
            Accept: 'application/json',
          },
        })
        if (!response.ok) {
          await response.body?.cancel()
          const rawRetry = response.headers.get('retry-after')
          const retryAfterMs = rawRetry
            ? /^\d+$/.test(rawRetry)
              ? Number(rawRetry) * 1000
              : Math.max(0, Date.parse(rawRetry) - Date.now())
            : 200 * 2 ** attempt
          if (
            (response.status === 429 || response.status === 503) &&
            attempt < attempts &&
            Number.isFinite(retryAfterMs) &&
            retryAfterMs <= 10000 &&
            retryAfterMs < remaining
          ) {
            clearTimeout(timer)
            this.options.signal?.removeEventListener('abort', abort)
            await (this.options.delay ?? wait)(retryAfterMs, this.options.signal)
            continue
          }
          throw new ProviderHttpError(
            response.status,
            Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
          )
        }
        const declared = Number(response.headers.get('content-length') ?? 0)
        if (declared > MAX_RESPONSE) {
          await response.body?.cancel()
          throw new Error('Provider response exceeds 2 MiB.')
        }
        const reader = response.body?.getReader()
        if (!reader) throw new Error('Provider returned no response body.')
        const decoder = new TextDecoder(),
          parts: string[] = []
        let bytes = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            bytes += value.byteLength
            if (bytes > MAX_RESPONSE) {
              await reader.cancel()
              throw new Error('Provider response exceeds 2 MiB.')
            }
            parts.push(decoder.decode(value, { stream: true }))
          }
        } finally {
          reader.releaseLock()
        }
        parts.push(decoder.decode())
        let parsed: unknown
        try {
          parsed = JSON.parse(parts.join(''))
        } catch {
          throw new Error('Provider returned malformed JSON.')
        }
        return record(parsed)
      } catch (error) {
        if (controller.signal.aborted)
          throw new Error(
            this.options.signal?.aborted
              ? 'Provider sync cancelled.'
              : 'Provider request timed out.',
            { cause: error },
          )
        if (
          error instanceof ProviderHttpError ||
          (error instanceof Error && /^(Provider |The provider)/.test(error.message))
        )
          throw error
        // Keep the public message free of URL query tokens; retain the cause for diagnostics.
        throw new Error('Provider request failed before a complete response was received.', {
          cause: error,
        })
      } finally {
        clearTimeout(timer)
        this.options.signal?.removeEventListener('abort', abort)
      }
    }
  }
}

function partial(
  items: Map<string, Record<string, unknown>>,
  deleted: Set<string>,
  reason: 'page-limit' | 'item-limit',
): ProviderSyncResult {
  return {
    items: [...items.values()],
    deletedIds: [...deleted],
    complete: false,
    checkpoint: null,
    reason,
  }
}

/** Read-only inbox delta. This does not change the native Mail companion's account configuration. */
export async function syncGraphMail(
  options: ProviderOptions,
  checkpoint?: ProviderCheckpoint,
): Promise<ProviderSyncResult> {
  const reader = new Reader('graph.microsoft.com', '/v1.0/me/', options)
  if (checkpoint && checkpoint.version !== 1) throw new Error('Unsupported checkpoint version.')
  if (checkpoint && checkpoint.provider !== 'graph-mail')
    throw new Error('Checkpoint belongs to a different provider.')
  let url =
    checkpoint?.provider === 'graph-mail'
      ? reader.validate(checkpoint.url)
      : 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$select=id,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview&$top=50'
  const items = new Map<string, Record<string, unknown>>(),
    deleted = new Set<string>(),
    links = new Set<string>()
  for (let page = 0; page < reader.maxPages; page++) {
    if (links.has(url)) throw new Error('Provider returned a paging loop.')
    links.add(url)
    let data: Record<string, unknown>
    try {
      data = await reader.get(url)
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 410)
        throw new ProviderCheckpointExpiredError()
      throw error
    }
    for (const item of list(data.value)) {
      const id = identifier(item.id)
      if (item['@removed']) {
        items.delete(id)
        deleted.add(id)
      } else {
        deleted.delete(id)
        items.set(id, item)
      }
      if (items.size + deleted.size > reader.maxItems) {
        items.delete(id)
        deleted.delete(id)
        return partial(items, deleted, 'item-limit')
      }
    }
    if (typeof data['@odata.nextLink'] === 'string') {
      url = reader.validate(data['@odata.nextLink'])
      continue
    }
    if (typeof data['@odata.deltaLink'] !== 'string')
      throw new Error('Provider did not return a completed delta checkpoint.')
    const delta = reader.validate(data['@odata.deltaLink'])
    return {
      items: [...items.values()],
      deletedIds: [...deleted],
      complete: true,
      checkpoint: { version: 1, provider: 'graph-mail', url: delta },
    }
  }
  return partial(items, deleted, 'page-limit')
}

/** Snapshot + history changes, metadata only. No message is sent, read-marked or deleted. */
export async function syncGmailMail(
  options: ProviderOptions,
  checkpoint?: ProviderCheckpoint,
): Promise<ProviderSyncResult> {
  const reader = new Reader('gmail.googleapis.com', '/gmail/v1/users/me/', options)
  if (checkpoint && checkpoint.version !== 1) throw new Error('Unsupported checkpoint version.')
  if (checkpoint && checkpoint.provider !== 'gmail-mail')
    throw new Error('Checkpoint belongs to a different provider.')
  const root = 'https://gmail.googleapis.com/gmail/v1/users/me/'
  const items = new Map<string, Record<string, unknown>>(),
    deleted = new Set<string>(),
    ids = new Set<string>(),
    pages = new Set<string>()
  let historyId: string
  let token = ''
  if (checkpoint?.provider === 'gmail-mail') {
    historyId = checkpoint.historyId
    if (!/^\d+$/.test(historyId)) throw new Error('Invalid Gmail history checkpoint.')
  } else {
    historyId = identifier((await reader.get(root + 'profile')).historyId)
  }
  let finished = false
  for (let page = 0; page < reader.maxPages; page++) {
    const query = new URLSearchParams({ maxResults: '100', ...(token ? { pageToken: token } : {}) })
    const incremental = checkpoint?.provider === 'gmail-mail'
    if (incremental) query.set('startHistoryId', checkpoint.historyId)
    const url = root + (incremental ? 'history?' : 'messages?') + query.toString()
    if (pages.has(url)) throw new Error('Provider returned a paging loop.')
    pages.add(url)
    let data: Record<string, unknown>
    try {
      data = await reader.get(url)
    } catch (error) {
      if (incremental && error instanceof ProviderHttpError && error.status === 404)
        throw new ProviderCheckpointExpiredError()
      throw error
    }
    if (incremental) {
      for (const change of list(data.history)) {
        for (const entry of list(change.messagesDeleted)) {
          const id = identifier(record(entry.message).id)
          deleted.add(id)
          ids.delete(id)
        }
        for (const field of ['messagesAdded', 'labelsAdded', 'labelsRemoved'])
          for (const entry of list(change[field])) {
            const id = identifier(record(entry.message).id)
            ids.add(id)
            deleted.delete(id)
          }
      }
      if (typeof data.historyId === 'string') historyId = data.historyId
    } else for (const message of list(data.messages)) ids.add(identifier(message.id))
    if (ids.size + deleted.size > reader.maxItems)
      return {
        ...partial(items, deleted, 'item-limit'),
        deletedIds: [...deleted].slice(0, reader.maxItems),
      }
    if (typeof data.nextPageToken === 'string' && data.nextPageToken) {
      token = data.nextPageToken
      continue
    }
    finished = true
    break
  }
  if (!finished) return partial(items, deleted, 'page-limit')
  for (const id of ids) {
    const query = new URLSearchParams({ format: 'metadata' })
    for (const header of ['Subject', 'From', 'To', 'Date']) query.append('metadataHeaders', header)
    try {
      const item = await reader.get(root + `messages/${encodeURIComponent(id)}?` + query.toString())
      items.set(id, item)
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 404) {
        deleted.add(id)
        continue
      }
      throw error
    }
  }
  if (!/^\d+$/.test(historyId))
    throw new Error('Provider returned an invalid Gmail history checkpoint.')
  return {
    items: [...items.values()],
    deletedIds: [...deleted],
    complete: true,
    checkpoint: { version: 1, provider: 'gmail-mail', historyId },
  }
}

/** Recurring event definitions and exceptions remain intact; clients expand them separately. */
export async function syncGoogleCalendar(
  options: ProviderOptions,
  calendarId = 'primary',
  checkpoint?: ProviderCheckpoint,
): Promise<ProviderSyncResult> {
  const reader = new Reader('www.googleapis.com', '/calendar/v3/calendars/', options)
  if (checkpoint && checkpoint.version !== 1) throw new Error('Unsupported checkpoint version.')
  if (!calendarId || calendarId.length > 2048) throw new Error('Invalid calendar identifier.')
  if (
    checkpoint &&
    (checkpoint.provider !== 'google-calendar' || checkpoint.calendarId !== calendarId)
  )
    throw new Error('Checkpoint belongs to a different provider or calendar.')
  const root = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
  const items = new Map<string, Record<string, unknown>>(),
    deleted = new Set<string>(),
    tokens = new Set<string>()
  let pageToken = ''
  for (let page = 0; page < reader.maxPages; page++) {
    const query = new URLSearchParams({
      maxResults: '100',
      singleEvents: 'false',
      showDeleted: 'true',
    })
    if (checkpoint?.provider === 'google-calendar') query.set('syncToken', checkpoint.token)
    if (pageToken) query.set('pageToken', pageToken)
    let data: Record<string, unknown>
    try {
      data = await reader.get(root + '?' + query.toString())
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 410)
        throw new ProviderCheckpointExpiredError()
      throw error
    }
    for (const item of list(data.items)) {
      const id = identifier(item.id)
      // Cancelled recurrence exceptions carry originalStartTime and must be
      // retained, so occurrence expansion can suppress only that instance.
      if (item.status === 'cancelled' && !item.recurringEventId) {
        items.delete(id)
        deleted.add(id)
      } else {
        deleted.delete(id)
        items.set(id, item)
      }
      if (items.size + deleted.size > reader.maxItems) {
        items.delete(id)
        deleted.delete(id)
        return partial(items, deleted, 'item-limit')
      }
    }
    if (typeof data.nextPageToken === 'string' && data.nextPageToken) {
      if (tokens.has(data.nextPageToken)) throw new Error('Provider returned a paging loop.')
      tokens.add(data.nextPageToken)
      pageToken = data.nextPageToken
      continue
    }
    if (typeof data.nextSyncToken !== 'string' || !data.nextSyncToken)
      throw new Error('Provider did not return a completed calendar checkpoint.')
    return {
      items: [...items.values()],
      deletedIds: [...deleted],
      complete: true,
      checkpoint: {
        version: 1,
        provider: 'google-calendar',
        calendarId,
        token: data.nextSyncToken,
      },
    }
  }
  return partial(items, deleted, 'page-limit')
}

export const PROVIDER_REQUIREMENTS = {
  'graph-mail': {
    tokenEnvironment: 'VANTAGE_GRAPH_TOKEN',
    scopes: ['Mail.Read'],
    origin: 'https://graph.microsoft.com',
    reads: 'Inbox message metadata, preview and delta changes',
  },
  'gmail-mail': {
    tokenEnvironment: 'VANTAGE_GMAIL_TOKEN',
    scopes: ['https://www.googleapis.com/auth/gmail.metadata'],
    origin: 'https://gmail.googleapis.com',
    reads: 'Message headers, labels, metadata and history changes',
  },
  'google-calendar': {
    tokenEnvironment: 'VANTAGE_GOOGLE_CALENDAR_TOKEN',
    scopes: ['https://www.googleapis.com/auth/calendar.events.readonly'],
    origin: 'https://www.googleapis.com',
    reads: 'Calendar event definitions and changes',
  },
} as const
