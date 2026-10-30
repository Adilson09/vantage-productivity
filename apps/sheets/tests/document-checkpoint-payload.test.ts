import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { workbookSaveRequestSchema } from '../src/shared/desktop-api'
import {
  documentPayloadFromSave,
  emptyDocumentPayload,
  validateDocumentPayload,
} from '../src/shared/document-checkpoint'

describe('complete document checkpoint payload', () => {
  it('records a clean imported base without needing a pretend user edit', () => {
    const empty = emptyDocumentPayload()
    expect(validateDocumentPayload(empty)).toEqual(empty)
    const internal = workbookSaveRequestSchema.parse({
      ...empty,
      sessionId: randomUUID(),
      mode: 'save-as',
    })
    expect(documentPayloadFromSave(internal)).toEqual(empty)
  })

  it('keeps exact scalar types and excludes every destination and transport field', () => {
    const values = [12, '12', true, 'TRUE', null, '', '=literal']
    const payload = {
      ...emptyDocumentPayload(),
      edits: values.map((value, column) => ({
        sheetId: 'sheet-1',
        row: 0,
        column,
        writeValue: true,
        value,
      })),
    }
    expect(validateDocumentPayload(payload).edits.map((cell) => cell.value)).toEqual(values)
    for (const key of [
      'sessionId',
      'mode',
      'targetPath',
      'overwrite',
      'restoreWriteBack',
      'quiet',
      'defaultName',
      'csvContent',
      'editsTransferId',
    ]) {
      expect(() => validateDocumentPayload({ ...payload, [key]: 'not-document-state' })).toThrow(
        'destinations or transport handles',
      )
    }
  })
})
