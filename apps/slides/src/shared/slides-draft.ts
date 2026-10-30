import type { EditParagraph } from './ipc'

export type SlidesPendingText =
  | {
      kind: 'text'
      slideIndex: number
      partPath?: string
      sourceId: string
      groupId?: string
      paragraphs: EditParagraph[]
    }
  | {
      kind: 'table'
      slideIndex: number
      partPath?: string
      sourceId: string
      row: number
      col: number
      paragraphs: EditParagraph[]
    }
  | { kind: 'master'; partPath: string; sourceId: string; paragraphs: EditParagraph[] }
export type SlidesPendingTarget =
  | Omit<Extract<SlidesPendingText, { kind: 'text' }>, 'paragraphs'>
  | Omit<Extract<SlidesPendingText, { kind: 'table' }>, 'paragraphs'>
  | Omit<Extract<SlidesPendingText, { kind: 'master' }>, 'paragraphs'>

export interface SlidesPendingDraft {
  text?: SlidesPendingText
  notes?: { slideIndex: number; partPath?: string; text: string; baseline: string }
}

export interface SlidesDraftActivation {
  ok: boolean
  token?: string
  error?: string
}
export interface SlidesDraftWriteRequest {
  token: string
  sequence: number
  expectedRevision: string
  documentPath: string | null
  pending: SlidesPendingDraft
}
export interface SlidesDraftSaveAcknowledgment {
  token: string
  throughSequence: number
  documentPath: string
  clean: boolean
}
export interface SlidesDraftResult {
  ok: boolean
  skipped?: boolean
  error?: string
}
export interface SlidesDraftState {
  revision: string
  dirty: boolean
}
export interface SlidesDraftDiscarded {
  token: string
  revision: string
}
