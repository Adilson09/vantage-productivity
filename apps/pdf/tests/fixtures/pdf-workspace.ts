import type { PdfWorkspaceStateV1 } from '../../src/shared/pdf-workspace'

export const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='
export function emptyWorkspace(): PdfWorkspaceStateV1 {
  return {
    version: 1,
    edits: {
      markups: [],
      annotDeletes: [],
      noteEdits: [],
      drawings: [],
      textEdits: [],
      textInserts: [],
      imageEdits: [],
      stampCfg: null,
      formEdits: [],
      formFields: [],
      blankPages: [],
      formWidgetEdits: [],
      rotations: [],
      deleted: [],
      order: null,
      metadata: null,
    },
    outline: { pending: null, selected: null },
    text: {
      draft: null,
      caret: null,
      pendingInsert: null,
      insertPointer: null,
      insertEditId: null,
      staticEditor: {
        open: false,
        purpose: 'insert',
        value: '',
        size: 12,
        color: '#000000',
        align: 'left',
        target: null,
      },
    },
    comments: {
      placement: null,
      newBody: '',
      createdMs: null,
      replies: [],
      rewrite: null,
      active: null,
      author: '',
    },
    forms: {
      activeWidgetId: null,
      selectedFieldIds: [],
      freshFieldId: null,
      heldFieldId: null,
      tool: null,
      preview: false,
      signatureTarget: null,
    },
    annotations: {
      selected: null,
      pendingLink: null,
      pendingSign: null,
      imagePick: null,
      pendingStaticFill: null,
      staticFormFills: [],
    },
    redactions: { regions: [], selectedId: null },
    pendingEditors: [],
    view: {
      page: 1,
      scale: 1,
      sidebar: null,
      ribbon: 'home',
      dialogs: { properties: false, stamp: false, bates: false, signature: false },
    },
  }
}
export function completeWorkspace(): PdfWorkspaceStateV1 {
  const state = emptyWorkspace()
  const note = {
    pageIndex: 0,
    objNum: 10,
    type: 'note' as const,
    rect: [10, 10, 30, 30] as [number, number, number, number],
    color: null,
    author: 'Local author',
    contents: 'Original comment',
    timeMs: 1700000000000,
    inReplyTo: null,
  }
  state.edits = {
    markups: [
      {
        id: 'mk',
        type: 'highlight',
        pageIndex: 0,
        color: [1, 1, 0],
        quads: [[10, 30, 40, 30, 10, 20, 40, 20]],
      },
    ],
    annotDeletes: [{ id: 'delete', annot: note }],
    noteEdits: [{ id: 'rewrite', annot: { ...note, objNum: 11 }, contents: 'Committed rewrite' }],
    drawings: [
      {
        id: 'draw',
        input: {
          kind: 'note',
          pageIndex: 0,
          color: [1, 1, 0],
          at: [10, 30],
          contents: 'Pending thread',
          author: 'Local author',
          createdMs: 1700000000001,
        },
      },
    ],
    textEdits: [
      {
        id: 'te',
        input: {
          pageIndex: 0,
          rect: [10, 10, 60, 30],
          oldText: 'Base',
          newText: 'Changed',
          fontSize: 12,
        },
      },
    ],
    textInserts: [
      {
        id: 'ti',
        input: { pageIndex: 0, origin: [10, 50], text: 'Inserted', fontSize: 12, color: [0, 0, 0] },
      },
    ],
    imageEdits: [
      {
        id: 'image',
        input: {
          kind: 'insertImage',
          pageIndex: 0,
          image: PIXEL_PNG,
          rect: [20, 20, 40, 40],
          layer: 'aboveText',
        },
      },
    ],
    stampCfg: {
      wm: { text: 'Private', angle: 35, opacity: 0.2, color: '#123456', sizeRatio: 0.1 },
      hf: null,
    },
    formEdits: [['name', { name: 'Name', kind: 'text', value: 'Ada' }]],
    formFields: [
      {
        id: 'field',
        input: {
          name: 'Held',
          kind: 'text',
          pageIndex: 0,
          rect: [10, 80, 100, 100],
          value: 'Unsubmitted',
        },
      },
    ],
    blankPages: [{ id: 'blank', input: { pageIndex: 1, width: 200, height: 300 } }],
    formWidgetEdits: [['widget', { widgetId: '12R', fieldName: 'Name', required: true }]],
    rotations: [[0, 90]],
    deleted: [1],
    order: [1, 0],
    metadata: { title: 'Draft title' },
  }
  state.outline = {
    pending: {
      tree: [{ title: 'Unsubmitted bookmark', pageIndex: 0 }],
      unresolvable: false,
      edited: true,
      editing: true,
    },
    selected: [0],
  }
  state.text.draft = {
    origIdx: 0,
    rect: [10, 10, 60, 30],
    oldText: 'Base',
    value: 'Typing',
    fontSize: 12,
    charStyles: ['', '', '', '', '', ''],
    foldedIds: ['te'],
    foldBase: 'Changed',
  }
  state.text.caret = [2, 4]
  state.text.pendingInsert = { text: 'Not placed', fontSize: 12, color: [0, 0, 0] }
  state.text.insertPointer = { pageIndex: 0, x: 15, y: 40 }
  state.text.staticEditor = {
    open: true,
    purpose: 'insert',
    value: 'Static text pending',
    size: 12,
    color: '#000000',
    align: 'left',
    target: null,
  }
  state.comments = {
    placement: { origIdx: 0, at: [50, 50] },
    newBody: 'New card still typing',
    createdMs: 1700000000020,
    replies: [['Pdraw', 'Reply still typing']],
    rewrite: { origIdx: 0, rootKey: 'Pdraw', itemKey: 'Pdraw', text: 'Rewrite still typing' },
    active: { origIdx: 0, rootKey: 'Pdraw' },
    author: 'Local author',
  }
  state.forms = {
    ...state.forms,
    selectedFieldIds: ['field'],
    freshFieldId: 'field',
    heldFieldId: 'field',
    tool: 'text',
  }
  state.annotations = {
    ...state.annotations,
    pendingLink: { pageIndex: 0, rect: [0, 0, 20, 20] },
    pendingSign: { kind: 'strokes', paths: [[0, 0, 5, 5]], width: 420, height: 150 },
    imagePick: { kind: 'image', image: PIXEL_PNG, width: 1, height: 1 },
    pendingStaticFill: 'check',
  }
  state.redactions = {
    regions: [{ id: 'redact', pageIndex: 0, rect: [20, 20, 40, 40] }],
    selectedId: 'redact',
  }
  state.pendingEditors = [
    ['link-target', { kind: 'link', value: { url: 'https://example.test/', page: '' } }],
    [
      'bookmark:0',
      { kind: 'bookmark-title', value: { editing: true, draft: 'Still typing bookmark' } },
    ],
    ['form-options:field', { kind: 'form-field', value: 'First\nSecond' }],
    ['form-date:date', { kind: 'date-field', value: '2026-10-' }],
    ['properties-form', { kind: 'properties', value: { title: 'Not applied metadata' } }],
    ['stamp-tab', { kind: 'stamp', value: 'watermark' }],
    ['bates-prefix', { kind: 'bates', value: 'CASE-' }],
    ['signature-font', { kind: 'signature', value: 3 }],
    ['signature-strokes', { kind: 'signature', value: [[0, 0, 10, 20]] }],
  ]
  state.view.dialogs = { properties: true, stamp: true, bates: true, signature: true }
  return state
}
