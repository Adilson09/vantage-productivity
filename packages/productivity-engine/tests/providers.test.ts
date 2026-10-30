import { describe, expect, it, vi } from 'vitest'
import {
  ProviderCheckpointExpiredError,
  ProviderHttpError,
  syncGmailMail,
  syncGoogleCalendar,
  syncGraphMail,
  type ProviderFetch,
  type ProviderOptions,
} from '../src/providers'

const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
function mock(responses: Response[]): {
  options: ProviderOptions
  calls: { url: string; init: RequestInit }[]
} {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch: ProviderFetch = async (url, init) => {
    calls.push({ url, init })
    const response = responses.shift()
    if (!response) throw new Error('No mock response left')
    return response
  }
  return {
    options: { enabled: true, accessToken: 'private-test-token', fetch, delay: async () => {} },
    calls,
  }
}

describe('bounded, explicitly enabled read-only provider adapters (mock transport only)', () => {
  it('follows Graph delta pages, preserves updates/deletions and commits only the final checkpoint', async () => {
    const next =
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=next'
    const delta =
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=final'
    const { options, calls } = mock([
      json({ value: [{ id: 'a', subject: 'Old' }, { id: 'gone' }], '@odata.nextLink': next }),
      json({
        value: [
          { id: 'a', subject: 'New' },
          { id: 'gone', '@removed': { reason: 'deleted' } },
        ],
        '@odata.deltaLink': delta,
      }),
    ])
    const result = await syncGraphMail(options)
    expect(result).toMatchObject({
      complete: true,
      items: [{ id: 'a', subject: 'New' }],
      deletedIds: ['gone'],
      checkpoint: { provider: 'graph-mail', url: delta },
    })
    expect(calls[1]?.url).toBe(next)
    for (const call of calls) {
      expect(call.init.method).toBe('GET')
      expect(call.init.redirect).toBe('error')
      expect(call.init.headers).toMatchObject({ Authorization: 'Bearer private-test-token' })
    }
  })

  it('refuses cross-origin and credential-bearing paging URLs before leaking authorization', async () => {
    const { options, calls } = mock([
      json({ value: [], '@odata.nextLink': 'https://graph.microsoft.com.evil.test/v1.0/me/x' }),
    ])
    await expect(syncGraphMail(options)).rejects.toThrow('authorized API origin')
    expect(calls).toHaveLength(1)
    const another = mock([])
    await expect(
      syncGraphMail(another.options, {
        version: 1,
        provider: 'graph-mail',
        url: 'https://username:password@graph.microsoft.com/v1.0/me/x',
      }),
    ).rejects.toThrow('authorized API origin')
    expect(another.calls).toHaveLength(0)
  })

  it('never advances checkpoints for page/item exhaustion or incomplete delta responses', async () => {
    const next = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=n'
    const one = mock([json({ value: [{ id: 'a' }], '@odata.nextLink': next })])
    expect(await syncGraphMail({ ...one.options, maxPages: 1 })).toMatchObject({
      complete: false,
      checkpoint: null,
      reason: 'page-limit',
    })
    const two = mock([json({ value: [{ id: 'a' }, { id: 'b' }], '@odata.deltaLink': next })])
    const result = await syncGraphMail({ ...two.options, maxItems: 1 })
    expect(result).toMatchObject({ complete: false, checkpoint: null, reason: 'item-limit' })
    expect(result.items).toHaveLength(1)
    await expect(syncGraphMail(mock([json({ value: [] })]).options)).rejects.toThrow(
      'completed delta checkpoint',
    )
  })

  it('honors Retry-After for bounded 429/503 retries without retrying auth failures', async () => {
    const delta =
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=f'
    const delay = vi.fn(async () => {})
    const throttled = mock([
      json({}, 429, { 'retry-after': '2' }),
      json({ value: [], '@odata.deltaLink': delta }),
    ])
    expect((await syncGraphMail({ ...throttled.options, delay })).complete).toBe(true)
    expect(delay).toHaveBeenCalledWith(2000, undefined)
    const denied = mock([json({}, 401)])
    await expect(syncGraphMail(denied.options)).rejects.toBeInstanceOf(ProviderHttpError)
    expect(denied.calls).toHaveLength(1)
    const long = mock([json({}, 429, { 'retry-after': '3600' })])
    await expect(syncGraphMail(long.options)).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 3600000,
    })
  })

  it('refuses overlarge bodies and malformed responses, including undeclared expanded body bytes', async () => {
    const declared = mock([
      new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } }),
    ])
    await expect(syncGraphMail(declared.options)).rejects.toThrow('2 MiB')
    const actual = mock([new Response('x'.repeat(2 * 1024 * 1024 + 1))])
    await expect(syncGraphMail(actual.options)).rejects.toThrow('2 MiB')
    await expect(syncGraphMail(mock([new Response('not json')]).options)).rejects.toThrow(
      'malformed JSON',
    )
  })

  it('supports cancellation and gives no raw token-bearing transport diagnostic', async () => {
    const controller = new AbortController()
    controller.abort()
    const { options, calls } = mock([])
    await expect(syncGraphMail({ ...options, signal: controller.signal })).rejects.toThrow(
      'cancelled',
    )
    expect(calls).toHaveLength(0)
    const transportCause = new Error('private-test-token secret query value')
    const failing: ProviderFetch = async () => {
      throw transportCause
    }
    const failed = syncGraphMail({ ...options, fetch: failing })
    await expect(failed).rejects.toThrow('before a complete response')
    await expect(failed).rejects.toHaveProperty('cause', transportCause)
    await expect(failed).rejects.not.toThrow('private-test-token')
    await expect(syncGraphMail({ ...options, enabled: false as true })).rejects.toThrow(
      'explicitly',
    )
  })

  it('retains the transport cause when an active sync is cancelled', async () => {
    const controller = new AbortController()
    const transportCause = new Error('Transport stopped after cancellation')
    const { options } = mock([])
    const cancelled = syncGraphMail({
      ...options,
      signal: controller.signal,
      fetch: async () => {
        controller.abort()
        throw transportCause
      },
    })
    await expect(cancelled).rejects.toMatchObject({
      message: 'Provider sync cancelled.',
      cause: transportCause,
    })
  })

  it('reports expired Graph checkpoints without resetting or mutating local data', async () => {
    await expect(syncGraphMail(mock([json({}, 410)]).options)).rejects.toBeInstanceOf(
      ProviderCheckpointExpiredError,
    )
  })

  it('performs Gmail snapshot metadata hydration with a pre-snapshot history checkpoint', async () => {
    const { options, calls } = mock([
      json({ historyId: '123' }),
      json({ messages: [{ id: 'a' }], nextPageToken: 'p2' }),
      json({ messages: [{ id: 'b' }] }),
      json({ id: 'a', payload: { headers: [{ name: 'Subject', value: 'A' }] } }),
      json({ id: 'b' }),
    ])
    const result = await syncGmailMail(options)
    expect(result).toMatchObject({
      complete: true,
      checkpoint: { provider: 'gmail-mail', historyId: '123' },
    })
    expect(result.items).toHaveLength(2)
    expect(calls[0]?.url).toContain('/profile')
    expect(calls[2]?.url).toContain('pageToken=p2')
    expect(calls[3]?.url).toContain('format=metadata')
    expect(calls.every((c) => c.init.method === 'GET')).toBe(true)
  })

  it('applies Gmail added/deleted/label changes, hydrates final records and handles deletion during hydration', async () => {
    const { options } = mock([
      json({
        history: [
          {
            messagesAdded: [{ message: { id: 'new' } }],
            messagesDeleted: [{ message: { id: 'gone' } }],
            labelsAdded: [{ message: { id: 'label' } }],
          },
        ],
        historyId: '130',
      }),
      json({ id: 'new' }),
      json({}, 404),
    ])
    const result = await syncGmailMail(options, {
      version: 1,
      provider: 'gmail-mail',
      historyId: '123',
    })
    expect(result.items).toEqual([{ id: 'new' }])
    expect(result.deletedIds.sort()).toEqual(['gone', 'label'])
    expect(result.checkpoint).toEqual({ version: 1, provider: 'gmail-mail', historyId: '130' })
  })

  it('reports expired Gmail history and leaves partial Gmail sync without checkpoint', async () => {
    await expect(
      syncGmailMail(mock([json({}, 404)]).options, {
        version: 1,
        provider: 'gmail-mail',
        historyId: '1',
      }),
    ).rejects.toBeInstanceOf(ProviderCheckpointExpiredError)
    const partial = mock([
      json({ historyId: '123' }),
      json({ messages: [{ id: 'a' }], nextPageToken: 'more' }),
    ])
    expect(await syncGmailMail({ ...partial.options, maxPages: 1 })).toMatchObject({
      complete: false,
      checkpoint: null,
    })
  })

  it('synchronizes recurring Google Calendar definitions and cancelled occurrence exceptions over pages', async () => {
    const { options, calls } = mock([
      json({ items: [{ id: 'series', recurrence: ['RRULE:FREQ=DAILY'] }], nextPageToken: 'p2' }),
      json({
        items: [
          {
            id: 'exception',
            recurringEventId: 'series',
            status: 'cancelled',
            originalStartTime: { date: '2026-10-29' },
          },
          { id: 'gone', status: 'cancelled' },
        ],
        nextSyncToken: 'complete',
      }),
    ])
    const result = await syncGoogleCalendar(options)
    expect(result).toMatchObject({
      complete: true,
      deletedIds: ['gone'],
      checkpoint: { provider: 'google-calendar', calendarId: 'primary', token: 'complete' },
    })
    expect(result.items.map((i) => i.id)).toEqual(['series', 'exception'])
    expect(calls[0]?.url).toContain('singleEvents=false')
    expect(calls[1]?.url).toContain('pageToken=p2')
  })

  it('keeps Google Calendar sync parameters on every page and refuses cross-calendar or expired tokens', async () => {
    const checkpoint = {
      version: 1 as const,
      provider: 'google-calendar' as const,
      calendarId: 'primary',
      token: 'old',
    }
    const { options, calls } = mock([
      json({ items: [], nextPageToken: 'p2' }),
      json({ items: [], nextSyncToken: 'new' }),
    ])
    await syncGoogleCalendar(options, 'primary', checkpoint)
    expect(calls.every((c) => c.url.includes('syncToken=old'))).toBe(true)
    await expect(syncGoogleCalendar(mock([]).options, 'other', checkpoint)).rejects.toThrow(
      'different provider or calendar',
    )
    await expect(
      syncGoogleCalendar(mock([json({}, 410)]).options, 'primary', checkpoint),
    ).rejects.toBeInstanceOf(ProviderCheckpointExpiredError)
  })

  it('detects a provider paging loop and refuses incompatible checkpoint formats', async () => {
    const url = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?loop=1'
    const { options } = mock([
      json({ value: [], '@odata.nextLink': url }),
      json({ value: [], '@odata.nextLink': url }),
    ])
    await expect(syncGraphMail(options)).rejects.toThrow('paging loop')
    await expect(
      syncGraphMail(mock([]).options, { version: 1, provider: 'gmail-mail', historyId: '1' }),
    ).rejects.toThrow('different provider')
  })
})
