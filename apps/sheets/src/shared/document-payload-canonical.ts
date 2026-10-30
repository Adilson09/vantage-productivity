/** Must match native recovery canonicalDocumentPayload; operational grants never enter content hashes. */
import { DOCUMENT_OPERATIONAL_FIELDS } from './document-checkpoint'
const operational = new Set<string>(DOCUMENT_OPERATIONAL_FIELDS)

export function canonicalWorkbookDocumentPayload(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('A full workbook payload must be a JSON object.')
  const visiting = new Set<object>()
  const normalize = (value: unknown): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (!value || typeof value !== 'object' || visiting.has(value))
      throw new Error('A full workbook payload must contain finite JSON data.')
    const prototype: unknown = Object.getPrototypeOf(value)
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
      throw new Error('A full workbook payload must contain plain JSON objects.')
    visiting.add(value)
    const result = Array.isArray(value)
      ? value.map(normalize)
      : Object.fromEntries(
          Object.keys(value)
            .sort()
            .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
            .map((key) => [key, normalize((value as Record<string, unknown>)[key])]),
        )
    visiting.delete(value)
    return result
  }
  return normalize(
    Object.fromEntries(Object.entries(input).filter(([key]) => !operational.has(key))),
  ) as Record<string, unknown>
}

export function serializeWorkbookDocumentPayload(input: unknown): string {
  return JSON.stringify(canonicalWorkbookDocumentPayload(input))
}

export async function hashWorkbookDocumentPayload(
  input: unknown,
): Promise<{ json: string; sha256: string }> {
  const json = serializeWorkbookDocumentPayload(input)
  const maximum = 256 * 1024 * 1024
  if (json.length > maximum) throw new Error('The full workbook checkpoint exceeds its byte limit.')
  const encoded = new TextEncoder().encode(json)
  if (encoded.byteLength > maximum)
    throw new Error('The full workbook checkpoint exceeds its byte limit.')
  const result = await globalThis.crypto.subtle.digest('SHA-256', encoded)
  return {
    json,
    sha256: [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  }
}
