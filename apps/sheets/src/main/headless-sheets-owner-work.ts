/** Actual headless export JS custody; contains no document or recovery metadata. */
export class HeadlessSheetsOwnerWork {
  private closing = false
  private readonly accepted = new Set<Promise<unknown>>()

  closeAdmission(): void {
    this.closing = true
  }

  run<T>(producer: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('The headless spreadsheet owner is closing.'))
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (error: unknown) => void
    const actual = new Promise<T>((done, fail) => {
      resolve = done
      reject = fail
    })
    // Register before producer invocation, including its synchronous work.
    this.accepted.add(actual)
    void actual.catch(() => {})
    try {
      void producer().then(resolve, reject)
    } catch (error) {
      reject(error)
    }
    return actual
  }

  async joinOwner(ownerCleanup: Promise<void>): Promise<void> {
    this.closeAdmission()
    // Admission is closed before destruction. A rejected owner/export must not
    // skip another accepted export's file/print/staging finalizers.
    const results = await Promise.allSettled([ownerCleanup, ...this.accepted])
    this.accepted.clear()
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
}
