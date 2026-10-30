import type { PdfWorkspaceStateV1 } from './pdf-workspace'

type ObjectData = Record<string, unknown>
function fail(label: string): never {
  throw new Error(`Unsupported PDF ${label}; the complete recovery entry was refused.`)
}
const obj = (value: unknown): value is ObjectData =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype
const text = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0')
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e9
const index = (value: unknown): value is number =>
  finite(value) && Number.isSafeInteger(value) && value >= 0 && value <= 1e6
const positive = (value: unknown): value is number => finite(value) && value > 0 && value <= 1e6
const vector = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) && value.length === length && value.every(finite)
const rect = (value: unknown) =>
  vector(value, 4) && value[0]! <= value[2]! && value[1]! <= value[3]!
const rgb = (value: unknown, maximum = 1) =>
  vector(value, 3) && value.every((number) => number >= 0 && number <= maximum)
const one = (value: unknown, values: readonly unknown[]) => values.includes(value)
const fields = (
  value: unknown,
  required: string[],
  optional: string[],
  label: string,
): ObjectData => {
  if (
    !obj(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    fail(label)
  return value
}
const optional = (
  value: ObjectData,
  key: string,
  test: (value: unknown) => boolean,
  label: string,
) => {
  if (Object.hasOwn(value, key) && !test(value[key])) fail(label)
}
const booleans = (value: ObjectData, keys: string[]) => {
  for (const key of keys) optional(value, key, (item) => typeof item === 'boolean', key)
}
const texts = (value: ObjectData, keys: string[]) => {
  for (const key of keys) optional(value, key, text, key)
}
const pageRect = (value: ObjectData, label: string) => {
  if (!index(value.pageIndex) || !rect(value.rect)) fail(label)
}
const aligns = ['left', 'center', 'right']
const kinds = ['text', 'checkbox', 'radio', 'choice', 'signature']
function paths(value: unknown, minimum = 2): void {
  if (!Array.isArray(value) || value.length > 4096) fail('signature strokes')
  for (const path of value)
    if (
      !Array.isArray(path) ||
      path.length < minimum ||
      path.length > 32768 ||
      path.length % 2 ||
      !path.every(finite)
    )
      fail('stroke coordinates')
}
function metadata(value: unknown): void {
  const item = fields(value, [], ['title', 'author', 'subject', 'keywords'], 'metadata')
  texts(item, ['title', 'author', 'subject', 'keywords'])
}
function fontPreview(value: unknown): void {
  const item = fields(value, ['css'], ['weight', 'italic'], 'font preview')
  if (!text(item.css)) fail('font preview family')
  optional(
    item,
    'weight',
    (value) => finite(value) && value >= 1 && value <= 1000,
    'font preview weight',
  )
  optional(item, 'italic', (value) => value === true, 'font preview style')
}
function watermark(value: unknown): void {
  const item = fields(value, ['text', 'angle', 'opacity', 'color', 'sizeRatio'], [], 'watermark')
  if (
    !text(item.text) ||
    !text(item.color) ||
    !finite(item.angle) ||
    !finite(item.opacity) ||
    item.opacity < 0 ||
    item.opacity > 1 ||
    !positive(item.sizeRatio)
  )
    fail('watermark values')
}
function headerFooter(value: unknown): void {
  const item = fields(
    value,
    [
      'headerLeft',
      'headerCenter',
      'headerRight',
      'footerLeft',
      'footerCenter',
      'footerRight',
      'pageNumber',
      'startAt',
      'fontSize',
      'color',
    ],
    [],
    'header/footer',
  )
  for (const key of [
    'headerLeft',
    'headerCenter',
    'headerRight',
    'footerLeft',
    'footerCenter',
    'footerRight',
    'color',
  ])
    if (!text(item[key])) fail('header/footer text')
  if (typeof item.pageNumber !== 'boolean' || !index(item.startAt) || !positive(item.fontSize))
    fail('header/footer numbers')
}
export function validatePdfStampConfig(value: unknown): void {
  if (value === null) return
  const item = fields(value, ['wm', 'hf'], [], 'stamp config')
  if (item.wm !== null) watermark(item.wm)
  if (item.hf !== null) headerFooter(item.hf)
}
function signature(value: unknown): void {
  if (!obj(value)) fail('signature')
  const item = fields(
    value,
    ['kind', 'width', 'height', value.kind === 'image' ? 'image' : 'paths'],
    [],
    'signature',
  )
  if (!positive(item.width) || !positive(item.height) || item.width > 16384 || item.height > 16384)
    fail('signature bounds')
  if (item.kind === 'image') {
    if (!text(item.image)) fail('signature image')
  } else if (item.kind === 'strokes') paths(item.paths)
  else fail('signature kind')
}
function annotation(value: unknown): void {
  if (!obj(value)) fail('saved annotation')
  const note = value.type === 'note'
  const item = fields(
    value,
    [
      'pageIndex',
      'objNum',
      'type',
      'rect',
      ...(note ? ['color', 'author', 'contents', 'timeMs', 'inReplyTo'] : ['quads']),
    ],
    [],
    'saved annotation',
  )
  pageRect(item, 'annotation geometry')
  if (!index(item.objNum)) fail('annotation object identity')
  if (note) {
    if (
      (item.color !== null && !rgb(item.color)) ||
      !text(item.author) ||
      !text(item.contents) ||
      (item.timeMs !== null &&
        (typeof item.timeMs !== 'number' || !Number.isFinite(item.timeMs))) ||
      (item.inReplyTo !== null && !index(item.inReplyTo))
    )
      fail('saved comment')
  } else if (
    !one(item.type, ['highlight', 'underline', 'strikeout', 'squiggly']) ||
    !Array.isArray(item.quads) ||
    !item.quads.every((quad) => vector(quad, 8))
  )
    fail('saved markup')
}
function drawing(value: unknown): void {
  if (!obj(value) || !index(value.pageIndex) || !text(value.kind)) fail('drawing')
  const kind = value.kind
  const specific: Record<string, string[]> = {
    ink: ['paths'],
    rect: ['rect'],
    ellipse: ['rect'],
    line: ['from', 'to'],
    arrow: ['from', 'to'],
    polygon: ['vertices'],
    caret: ['point'],
    image: ['image', 'rect'],
    link: ['rect'],
    note: ['at', 'contents'],
  }
  if (!specific[kind]) fail('drawing kind')
  const base = ['pageIndex', 'kind', ...specific[kind]!]
  const common =
    kind === 'image'
      ? ['formFieldName']
      : kind === 'link'
        ? ['url', 'destPage']
        : kind === 'note'
          ? ['color', 'author', 'createdMs', 'localId', 'replyToSaved', 'replyToLocalId']
          : ['color', 'width', 'formFieldName']
  const item = fields(value, base, common, 'drawing fields')
  if (!['image', 'link'].includes(kind) && !rgb(item.color)) fail('drawing color')
  if (
    ['ink', 'rect', 'ellipse', 'line', 'arrow', 'polygon'].includes(kind) &&
    (!finite(item.width) || item.width < 0)
  )
    fail('drawing width')
  if (Object.hasOwn(item, 'rect') && !rect(item.rect)) fail('drawing rectangle')
  if (kind === 'ink') paths(item.paths)
  if (
    kind === 'polygon' &&
    (!Array.isArray(item.vertices) ||
      item.vertices.length < 3 ||
      !item.vertices.every((point) => vector(point, 2)))
  )
    fail('polygon vertices')
  for (const key of ['from', 'to', 'point', 'at'])
    optional(item, key, (value) => vector(value, 2), 'drawing position')
  texts(item, ['image', 'contents', 'author', 'localId', 'replyToLocalId', 'formFieldName', 'url'])
  optional(
    item,
    'createdMs',
    (value) =>
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 8640000000000000,
    'comment creation time',
  )
  if (
    kind === 'link' &&
    ((Object.hasOwn(item, 'url') ? 1 : 0) + (Object.hasOwn(item, 'destPage') ? 1 : 0) !== 1 ||
      (item.destPage !== undefined && (!index(item.destPage) || item.destPage < 1)))
  )
    fail('link target')
  if (item.replyToSaved !== undefined) {
    const reply = fields(item.replyToSaved, ['objNum', 'rect', 'contents'], [], 'comment parent')
    if (!index(reply.objNum) || !rect(reply.rect) || !text(reply.contents)) fail('comment parent')
  }
}
const textOptional = [
  'newFontSize',
  'newColor',
  'colorRuns',
  'styleRuns',
  'newFont',
  'origin',
  'lineLeading',
  'lineXOffsets',
  'align',
  'blockSource',
  'newBold',
  'newItalic',
  'translate',
]
function textInput(value: unknown, insert: boolean, pending = false): void {
  const item = fields(
    value,
    insert
      ? ['text', 'fontSize', 'color', ...(pending ? [] : ['pageIndex', 'origin'])]
      : ['pageIndex', 'rect', 'oldText', 'newText', 'fontSize'],
    insert
      ? ['font', 'bold', 'italic', 'lineLeading', 'lineXOffsets', 'align', 'rotate', 'invisible']
      : textOptional,
    'text input',
  )
  if ((!pending && !index(item.pageIndex)) || !positive(item.fontSize)) fail('text dimensions')
  if (
    insert
      ? !text(item.text) || !rgb(item.color) || (!pending && !vector(item.origin, 2))
      : !text(item.oldText) || !text(item.newText) || !rect(item.rect)
  )
    fail('text content')
  texts(item, ['font', 'newFont', 'blockSource'])
  booleans(item, ['bold', 'italic', 'invisible', 'newBold', 'newItalic'])
  for (const key of ['origin', 'translate'])
    optional(item, key, (value) => vector(value, 2), 'text origin')
  for (const key of ['lineLeading', 'newFontSize']) optional(item, key, positive, 'text size')
  optional(item, 'newColor', (value) => rgb(value, 255), 'text color')
  optional(
    item,
    'lineXOffsets',
    (value) => Array.isArray(value) && value.every(finite),
    'text line positions',
  )
  optional(item, 'align', (value) => one(value, aligns), 'text alignment')
  optional(item, 'rotate', (value) => finite(value) && value % 90 === 0, 'text rotation')
  for (const key of ['colorRuns', 'styleRuns'])
    if (item[key] !== undefined) {
      if (!Array.isArray(item[key])) fail('text styles')
      let end = 0
      for (const candidate of item[key]) {
        const run = fields(
          candidate,
          ['start', 'end', ...(key === 'colorRuns' ? ['color'] : [])],
          key === 'styleRuns' ? ['color', 'font', 'size', 'bold', 'italic'] : [],
          'text style range',
        )
        if (
          !index(run.start) ||
          !index(run.end) ||
          run.start < end ||
          run.end <= run.start ||
          run.end > String(item.newText).length
        )
          fail('text style offsets')
        end = run.end
        optional(run, 'color', (value) => rgb(value, 255), 'text style color')
        optional(run, 'font', text, 'text style font')
        optional(run, 'size', positive, 'text style size')
        booleans(run, ['bold', 'italic'])
      }
    }
}
function fieldInput(value: unknown): void {
  const item = fields(
    value,
    ['name', 'kind', 'pageIndex', 'rect'],
    [
      'required',
      'multiLine',
      'maxLen',
      'fontSize',
      'textAlignment',
      'value',
      'checked',
      'exportValue',
      'options',
      'dateFormat',
    ],
    'form field',
  )
  pageRect(item, 'form field bounds')
  if (!text(item.name) || !one(item.kind, kinds)) fail('form field identity')
  booleans(item, ['required', 'multiLine', 'checked'])
  texts(item, ['value', 'exportValue', 'dateFormat'])
  optional(item, 'maxLen', index, 'form maximum length')
  optional(item, 'fontSize', positive, 'form size')
  optional(item, 'textAlignment', (value) => one(value, aligns), 'form alignment')
  optional(item, 'options', (value) => Array.isArray(value) && value.every(text), 'form options')
}
function imageEdit(value: unknown): void {
  if (!obj(value) || !index(value.pageIndex)) fail('image edit')
  const kind = value.kind
  const required =
    kind === 'insertImage'
      ? ['image', 'rect', 'layer']
      : kind === 'transformImage'
        ? ['oldRect', 'rect']
        : kind === 'replaceImage'
          ? ['oldRect', 'rect', 'image']
          : kind === 'deleteImage'
            ? ['oldRect']
            : null
  if (!required) fail('image edit kind')
  const item = fields(
    value,
    ['kind', 'pageIndex', ...required],
    kind === 'insertImage' ? ['rotate'] : kind === 'deleteImage' ? [] : ['layer', 'quarterTurns'],
    'image edit',
  )
  for (const key of ['rect', 'oldRect']) optional(item, key, rect, 'image rectangle')
  optional(item, 'image', text, 'image bytes')
  optional(item, 'layer', (value) => one(value, ['belowText', 'aboveText']), 'image layer')
  optional(item, 'quarterTurns', (value) => index(value) && value <= 3, 'image rotation')
  optional(item, 'rotate', (value) => finite(value) && value % 90 === 0, 'image orientation')
}
function staticFill(value: unknown): void {
  const item = fields(
    value,
    ['id', 'kind', 'pageIndex', 'rect'],
    ['text', 'fontSize', 'color', 'align'],
    'static form content',
  )
  pageRect(item, 'static form bounds')
  if (!text(item.id) || !one(item.kind, ['text', 'check', 'cross'])) fail('static form kind')
  texts(item, ['text', 'color'])
  optional(item, 'fontSize', positive, 'static form size')
  optional(item, 'align', (value) => one(value, aligns), 'static form alignment')
}
/** Explicit nested schema. Unknown authored models fail as a complete entry. */
export function validatePdfWorkspaceNested(state: PdfWorkspaceStateV1): void {
  const e = state.edits
  for (const candidate of e.markups) {
    const item = fields(candidate, ['id', 'type', 'pageIndex', 'color', 'quads'], [], 'markup')
    if (
      !index(item.pageIndex) ||
      !rgb(item.color) ||
      !one(item.type, ['highlight', 'underline', 'strikeout', 'squiggly']) ||
      !Array.isArray(item.quads) ||
      !item.quads.every((quad) => vector(quad, 8))
    )
      fail('markup content')
  }
  for (const candidate of e.drawings)
    drawing(fields(candidate, ['id', 'input'], [], 'local drawing').input)
  for (const candidate of e.annotDeletes)
    annotation(fields(candidate, ['id', 'annot'], [], 'annotation deletion').annot)
  for (const candidate of e.noteEdits) {
    const item = fields(candidate, ['id', 'annot', 'contents'], [], 'comment edit')
    annotation(item.annot)
    if (!text(item.contents)) fail('comment edit text')
  }
  for (const candidate of e.textEdits) {
    const item = fields(
      candidate,
      ['id', 'input'],
      ['cover', 'baseInk', 'baseFont', 'paper', 'moveBy'],
      'local text edit',
    )
    textInput(item.input, false)
    optional(item, 'cover', rect, 'text ink bounds')
    optional(item, 'moveBy', (value) => vector(value, 2), 'text move')
    texts(item, ['baseInk', 'paper'])
    if (item.baseFont !== undefined) fontPreview(item.baseFont)
  }
  for (const candidate of e.textInserts)
    textInput(fields(candidate, ['id', 'input'], [], 'local text insertion').input, true)
  for (const candidate of e.imageEdits) {
    const item = fields(
      candidate,
      ['id', 'input'],
      ['png', 'origAbove', 'staticFill', 'opacityBase'],
      'local image edit',
    )
    imageEdit(item.input)
    if (item.staticFill !== undefined) staticFill(item.staticFill)
    optional(item, 'origAbove', (value) => typeof value === 'boolean', 'image band')
    optional(item, 'png', (value) => value === null || text(value), 'image preview')
    optional(item, 'opacityBase', text, 'image opacity source')
  }
  for (const candidate of e.formFields)
    fieldInput(fields(candidate, ['id', 'input'], [], 'local form field').input)
  for (const candidate of e.blankPages) {
    const item = fields(
      fields(candidate, ['id', 'input'], [], 'local blank page').input,
      ['pageIndex', 'width', 'height'],
      [],
      'blank page',
    )
    if (!index(item.pageIndex) || !positive(item.width) || !positive(item.height))
      fail('blank page geometry')
  }
  for (const [, candidate] of e.formEdits) {
    const item = fields(candidate, ['name', 'kind'], ['value', 'checked'], 'form value')
    if (
      !text(item.name) ||
      !one(
        item.kind,
        kinds.filter((kind) => kind !== 'signature'),
      )
    )
      fail('form value kind')
    texts(item, ['value'])
    booleans(item, ['checked'])
  }
  for (const [, candidate] of e.formWidgetEdits) {
    const item = fields(
      candidate,
      ['widgetId', 'fieldName'],
      ['rect', 'required', 'remove'],
      'widget edit',
    )
    if (!text(item.widgetId) || !text(item.fieldName)) fail('widget identity')
    optional(item, 'rect', rect, 'widget rectangle')
    booleans(item, ['required', 'remove'])
  }
  if (e.metadata !== null) metadata(e.metadata)
  validatePdfStampConfig(e.stampCfg)
  if (state.text.pendingInsert) textInput(state.text.pendingInsert, true, true)
  if (state.text.draft) {
    const item = fields(
      state.text.draft,
      ['origIdx', 'rect', 'oldText', 'fontSize', 'value'],
      [
        'size',
        'color',
        'charStyles',
        'seedStyleRuns',
        'seedInk',
        'seedFont',
        'paper',
        'font',
        'bold',
        'italic',
        'editId',
        'foldedIds',
        'foldBase',
        'foldStyles',
        'cover',
        'block',
        'moveBy',
      ],
      'floating text draft',
    )
    if (
      !index(item.origIdx) ||
      !rect(item.rect) ||
      !text(item.oldText) ||
      !text(item.value) ||
      !positive(item.fontSize)
    )
      fail('floating text content')
    texts(item, ['color', 'seedInk', 'paper', 'font', 'editId', 'foldBase'])
    optional(item, 'size', positive, 'floating text size')
    optional(item, 'cover', rect, 'floating text bounds')
    optional(item, 'moveBy', (value) => vector(value, 2), 'floating text move')
    booleans(item, ['bold', 'italic'])
    if (item.seedFont !== undefined) fontPreview(item.seedFont)
    for (const key of ['charStyles', 'foldStyles', 'foldedIds'])
      optional(
        item,
        key,
        (value) => Array.isArray(value) && value.every(text),
        'floating text styles',
      )
    if (Array.isArray(item.charStyles) && item.charStyles.length !== item.value.length)
      fail('floating character style count')
    if (item.seedStyleRuns !== undefined) {
      if (!Array.isArray(item.seedStyleRuns)) fail('seed text styles')
      for (const value of item.seedStyleRuns) {
        const range = fields(value, ['start', 'end', 'color'], [], 'seed style range')
        if (
          !index(range.start) ||
          !index(range.end) ||
          range.end < range.start ||
          range.end > item.oldText.length ||
          !text(range.color)
        )
          fail('seed style offsets')
      }
    }
    if (item.block !== undefined) {
      const block = fields(
        item.block,
        ['leftPt', 'firstBaseline', 'widthPt', 'lineHeight', 'align', 'bottomPt'],
        [],
        'paragraph draft',
      )
      for (const key of ['leftPt', 'firstBaseline', 'bottomPt'])
        if (!finite(block[key])) fail('paragraph position')
      if (!positive(block.widthPt) || !positive(block.lineHeight) || !one(block.align, aligns))
        fail('paragraph geometry')
    }
  }
  if (state.text.staticEditor.target !== null) {
    const value = state.text.staticEditor.target
    if (!obj(value)) fail('static text target')
    const item = fields(
      value,
      ['kind', 'record', value.kind === 'saved' ? 'ref' : 'editId'],
      [],
      'static text target',
    )
    staticFill(item.record)
    if (item.kind === 'saved') {
      const ref = fields(
        item.ref,
        ['pageIndex', 'rect', 'aboveText'],
        [],
        'static text image target',
      )
      pageRect(ref, 'static text image target')
      if (typeof ref.aboveText !== 'boolean') fail('static text image band')
    } else if (item.kind !== 'pending' || !text(item.editId)) fail('static text pending target')
  }
  if (
    !one(state.view.sidebar, [null, 'thumbs', 'outline', 'comments', 'compare']) ||
    !one(state.view.ribbon, ['home', 'annotate', 'edit', 'page', 'view', 'fillForm', 'formDesign'])
  )
    fail('view selection')
  if (state.forms.signatureTarget) {
    const item = fields(
      state.forms.signatureTarget,
      [
        'id',
        'fieldName',
        'kind',
        'pageIndex',
        'rect',
        'value',
        'checked',
        'multiLine',
        'dateFormat',
        'readOnly',
        'required',
        'maxLen',
        'comb',
        'textAlignment',
        'buttonValue',
        'options',
        'signed',
      ],
      [],
      'signature form target',
    )
    pageRect(item, 'signature form target')
    if (
      !text(item.id) ||
      !text(item.fieldName) ||
      !one(item.kind, kinds) ||
      !text(item.value) ||
      !text(item.buttonValue) ||
      !one(item.textAlignment, aligns) ||
      (item.dateFormat !== null && !text(item.dateFormat)) ||
      (item.maxLen !== null && !index(item.maxLen)) ||
      !Array.isArray(item.options)
    )
      fail('signature form target data')
    for (const key of ['checked', 'multiLine', 'readOnly', 'required', 'comb', 'signed'])
      if (typeof item[key] !== 'boolean') fail('signature form target flags')
    for (const value of item.options) {
      const option = fields(value, ['exportValue', 'displayValue'], [], 'signature form choice')
      if (!text(option.exportValue) || !text(option.displayValue)) fail('signature form choice')
    }
  }
  if (
    state.annotations.pendingStaticFill !== null &&
    !one(state.annotations.pendingStaticFill, ['text', 'check', 'cross'])
  )
    fail('static form tool')
  if (state.forms.tool !== null && !one(state.forms.tool, [...kinds, 'date']))
    fail('form design tool')
  if (state.annotations.selected) {
    const value = state.annotations.selected
    const item = fields(
      value,
      [
        'kind',
        'x',
        'y',
        ...(value.kind === 'savedMarkup'
          ? ['annot']
          : value.kind === 'pageImage'
            ? ['ref']
            : value.kind === 'stamp'
              ? []
              : ['id']),
      ],
      [],
      'annotation selection',
    )
    if (!finite(item.x) || !finite(item.y)) fail('annotation popup position')
    if (value.kind === 'savedMarkup') annotation(item.annot)
    else if (value.kind === 'pageImage') {
      const ref = fields(item.ref, ['pageIndex', 'rect', 'aboveText'], [], 'selected page image')
      pageRect(ref, 'selected page image')
      if (typeof ref.aboveText !== 'boolean') fail('selected image layer')
    } else if (
      value.kind !== 'stamp' &&
      (!one(value.kind, ['markup', 'drawing', 'textEdit', 'textInsert', 'imageEdit']) ||
        !text(item.id))
    )
      fail('selected annotation identity')
  }
  if (state.annotations.pendingSign) signature(state.annotations.pendingSign)
  if (state.annotations.imagePick) signature(state.annotations.imagePick)
  for (const fill of state.annotations.staticFormFills) staticFill(fill)
  for (const [id, candidate] of state.pendingEditors) {
    const { kind, value } = candidate
    let valid = false
    if (kind === 'link' && id === 'link-target') {
      const item = fields(value, ['url', 'page'], [], 'pending link target')
      valid = text(item.url) && text(item.page)
    }
    if (kind === 'bookmark-title' && id.startsWith('bookmark:')) {
      const item = fields(value, ['editing', 'draft'], [], 'bookmark title')
      valid = typeof item.editing === 'boolean' && text(item.draft)
    }
    if (kind === 'form-field' && (id.startsWith('form-export:') || id.startsWith('form-options:')))
      valid = text(value)
    if (kind === 'date-field' && id.startsWith('form-date:')) valid = value === null || text(value)
    if (kind === 'properties' && id === 'properties-form') {
      metadata(value)
      valid = true
    }
    if (kind === 'stamp') {
      if (id === 'stamp-tab') valid = one(value, ['watermark', 'hf'])
      if (id === 'stamp-watermark') {
        watermark(value)
        valid = true
      }
      if (id === 'stamp-header-footer') {
        headerFooter(value)
        valid = true
      }
    }
    if (kind === 'bates') {
      if (
        [
          'bates-prefix',
          'bates-start',
          'bates-digits',
          'bates-font-size',
          'bates-first',
          'bates-last',
        ].includes(id)
      )
        valid = text(value)
      if (id === 'bates-color') valid = rgb(value)
      if (id === 'bates-position')
        valid = one(value, [
          'top-left',
          'top-center',
          'top-right',
          'bottom-left',
          'bottom-center',
          'bottom-right',
        ])
    }
    if (kind === 'signature') {
      if (id === 'signature-mode') valid = one(value, ['draw', 'type', 'image'])
      if (id === 'signature-typed') valid = text(value)
      if (id === 'signature-font') valid = index(value) && value < 4
      if (['signature-bw', 'signature-reuse'].includes(id)) valid = typeof value === 'boolean'
      if (id === 'signature-strokes') {
        paths(value)
        valid = true
      }
      if (id === 'signature-image') {
        if (value !== null) {
          const item = fields(value, ['image', 'width', 'height'], [], 'signature upload')
          if (
            !text(item.image) ||
            !positive(item.width) ||
            !positive(item.height) ||
            item.width > 1600 ||
            item.height > 1600
          )
            fail('signature upload bounds')
        }
        valid = true
      }
    }
    if (!valid) fail('pending editor identity or value')
  }
}
