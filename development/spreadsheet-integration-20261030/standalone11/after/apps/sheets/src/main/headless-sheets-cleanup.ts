/** A grace deadline requests verified termination; it never settles work. */
export const HEADLESS_SHEETS_CLEANUP_GRACE_MS = 30_000

export async function settleHeadlessSheetsCleanup(options: {
  /** Real destroyed-owner finalizer. Missing registration is a failure. */
  ownerCleanup: Promise<void> | undefined
  /** True only when owner registration was never entered or work admitted. */
  setupOnly?: boolean
  onMissingOwner?(): void
  joinNative(): Promise<void>
  /** Must await actual process exit/close. Called again to catch late clients. */
  stopNative(): Promise<void>
  graceMs?: number
}): Promise<void> {
  const grace = options.graceMs ?? HEADLESS_SHEETS_CLEANUP_GRACE_MS
  if (!Number.isSafeInteger(grace) || grace < 1 || grace > 120_000)
    throw new Error('Invalid headless spreadsheet cleanup grace.')
  let failed = false
  let failure: unknown
  const remember = (error: unknown) => { if (!failed) { failed = true; failure = error } }
  const stops: Promise<void>[] = []
  const stop = (): Promise<void> => {
    let actual: Promise<void>
    try { actual = options.stopNative() }
    catch (error) { actual = Promise.reject(error) }
    stops.push(actual)
    // Retain every real stop promise until finalization. A timer only starts
    // this operation; it cannot turn a hung owner or child into a settled one.
    void actual.catch(remember)
    return actual
  }
  const timer = setTimeout(() => { void stop() }, grace)
  try {
    if (!options.ownerCleanup) {
      if (!options.setupOnly) {
        try { options.onMissingOwner?.() } catch { /* Keep waiting without a fabricated acknowledgment. */ }
        // Native exit cannot prove an unregistered JS owner finalizer. Stop
        // native work, but never return permission for app.exit/profile removal.
        await Promise.allSettled([stop()])
        try { await options.joinNative() } catch { /* No owner proof: keep teardown pending either way. */ }
        clearTimeout(timer)
        await new Promise<never>(() => {})
      }
    } else {
      try { await options.ownerCleanup }
      catch (error) { remember(error); void stop() }
    }
    try { await options.joinNative() }
    catch (error) { remember(error) }
  } finally {
    clearTimeout(timer)
    // Teardown can create the document client after a forced stop began.
    // Re-evaluate both clients now instead of relying on the earlier snapshot.
    void stop()
    const results = await Promise.allSettled(stops)
    for (const result of results) if (result.status === 'rejected') remember(result.reason)
    try { await options.joinNative() }
    catch (error) { remember(error) }
  }
  if (failed) throw failure
}
