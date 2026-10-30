export interface SlidesHistoryBatchTicket {
  readonly nonce: string
}
export function isSlidesHistoryBatchTicket(value: unknown): value is SlidesHistoryBatchTicket {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const fields = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(fields)
  return (
    keys.length === 1 &&
    keys[0] === 'nonce' &&
    !!fields.nonce &&
    'value' in fields.nonce &&
    typeof fields.nonce.value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(fields.nonce.value)
  )
}
