import type { EntrySource, MutationPlan, SheetStructuralOps } from './xlsx-gateway'
import { isShiftingOp } from './xlsx-structure'
import { parseSheetElements, type SheetEditPlan } from './xlsx-sheets'
import { resolveRelTarget } from './xlsx-drawing-add'

export class MacroPreservationError extends Error {
  readonly code = 'VANTAGE_MACRO_PRESERVATION_REQUIRED'
  constructor(message: string) {
    super(message)
    this.name = 'MacroPreservationError'
  }
}
export interface MacroPreservationInfo {
  readonly vbaProject: boolean
  readonly macroSheets: boolean
  readonly packageSigned: boolean
  readonly preservedParts: readonly string[]
  readonly execution: 'never'
}

/** Inventory only: never parses or executes VBA, XLM, ActiveX or embedded OLE. */
export async function inspectMacroPreservation(
  source: EntrySource,
): Promise<MacroPreservationInfo> {
  const paths = await source.paths()
  const rootRelationships = paths.includes('_rels/.rels')
    ? await source.readText('_rels/.rels')
    : ''
  const controlVml = new Set<string>()
  for (const path of paths.filter((item) => /^xl\/drawings\/.*\.vml$/i.test(item))) {
    if (
      (source.canPatch && !(await source.canPatch(path))) ||
      !isPureNoteVml(await source.readText(path))
    ) {
      controlVml.add(path)
      const slash = path.lastIndexOf('/')
      controlVml.add(`${path.slice(0, slash)}/_rels/${path.slice(slash + 1)}.rels`)
    }
  }
  return {
    vbaProject: paths.some((path) => /(?:^|\/)vbaproject\.bin$/i.test(path)),
    macroSheets: paths.some((path) => /^xl\/macrosheets\//i.test(path)),
    packageSigned:
      paths.some((path) => /^_xmlsignatures\//i.test(path)) ||
      rootRelationships.includes('digital-signature/origin'),
    preservedParts: paths
      .filter(
        (path) =>
          /(?:^|\/)vbaproject[^/]*\.bin(?:\.rels)?$/i.test(path) ||
          /^xl\/(?:activeX|ctrlProps|controls|macrosheets|embeddings)\//i.test(path) ||
          controlVml.has(path) ||
          /^customUI\//i.test(path),
      )
      .sort(),
    execution: 'never',
  }
}

export async function assertMacroStructurePreserved(
  source: EntrySource,
  options: {
    sheetPlan?: SheetEditPlan | undefined
    structuralOps?: readonly SheetStructuralOps[]
    legacySheetRenames?: boolean
  },
  info?: MacroPreservationInfo,
): Promise<void> {
  const inventory = info ?? (await inspectMacroPreservation(source))
  if (!inventory.vbaProject && !inventory.macroSheets && inventory.preservedParts.length === 0)
    return
  const plan = options.sheetPlan
  let sheetMutation =
    options.legacySheetRenames === true ||
    Boolean(
      plan &&
      (plan.renames.length || plan.removals.length || plan.additions.length || plan.orderChanged),
    )
  if (plan && !sheetMutation) {
    const original = parseSheetElements(await source.readText('xl/workbook.xml')).map(
      (sheet) => sheet.name,
    )
    sheetMutation =
      original.length !== plan.order.length ||
      original.some((name, index) => name !== plan.order[index])
  }
  if (sheetMutation || options.structuralOps?.some((sheet) => sheet.ops.some(isShiftingOp))) {
    throw new MacroPreservationError(
      'This workbook contains preserved macros or controls. Sheet management and row/column or merge changes cannot safely rewrite their bindings. Keep the original and use the application that created it for this operation. Ordinary cell edits remain available; macros are never executed.',
    )
  }
}

export function assertPackageSignaturePreserved(
  info: MacroPreservationInfo,
  mutation: boolean,
): void {
  if (info.packageSigned && mutation)
    throw new MacroPreservationError(
      'This workbook has document package signatures. Editing signed parts would invalidate those signatures, so this save was refused and the original remains unchanged. Use the signing application to edit and sign a separate copy.',
    )
}

/** Assemblers may receive plans from callers other than the normal editor planner. */
export async function assertMacroMutationPlanSafe(
  source: EntrySource,
  plan: MutationPlan,
): Promise<void> {
  const info = await inspectMacroPreservation(source)
  assertPackageSignaturePreserved(
    info,
    plan.replaced.size > 0 ||
      plan.added.size > 0 ||
      plan.addedBinary.size > 0 ||
      plan.removedEntries.length > 0,
  )
  const protectedParts = new Set(info.preservedParts)
  const threatened = [
    ...plan.replaced.keys(),
    ...plan.added.keys(),
    ...plan.addedBinary.keys(),
    ...plan.removedEntries,
  ].find((path) => protectedParts.has(path))
  if (threatened)
    throw new MacroPreservationError(
      `The save would alter preserved macro/control content (${threatened}). The original was left unchanged.`,
    )
  if (!protectedParts.size) return
  for (const [path, xml] of plan.replaced) {
    if (!path.endsWith('.rels') || !(await source.has(path))) continue
    const before = protectedRelationships(await source.readText(path), path, protectedParts)
    const after = new Set(protectedRelationships(xml, path, protectedParts))
    if (before.some((relationship) => !after.has(relationship)))
      throw new MacroPreservationError(
        `The save would change a preserved macro/control relationship (${path}). Keep the original workbook.`,
      )
  }
  const types = plan.replaced.get('[Content_Types].xml')
  if (types && (await source.has('[Content_Types].xml'))) {
    const protectVml = info.preservedParts.some((path) => /\.vml$/i.test(path))
    const before = protectedContentTypes(await source.readText('[Content_Types].xml'), protectVml)
    const after = new Set(protectedContentTypes(types, protectVml))
    if (before.some((type) => !after.has(type)))
      throw new MacroPreservationError(
        'The save would change macro-enabled content types. Keep the original workbook.',
      )
  }
}

function attributes(text: string): Record<string, string> {
  return Object.fromEntries(
    [...text.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g)].map((m) => [m[1]!, m[3]!]),
  )
}
function protectedRelationships(
  xml: string,
  relationshipPath: string,
  protectedParts: ReadonlySet<string>,
): string[] {
  return [
    ...xml.matchAll(/<(?:[\w.-]+:)?Relationship\b((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g),
  ].flatMap((match) => {
    const a = attributes(match[1]!)
    const macroBinding =
      /(?:vbaProject[^/]*|control|ctrlProp|activeXControl|oleObject|xlMacrosheet|ui\/extensibility)$/i.test(
        a.Type ?? '',
      )
    let controlVml = false
    if (/\/vmlDrawing$/i.test(a.Type ?? '')) {
      const marker = relationshipPath.lastIndexOf('/_rels/')
      const owner =
        relationshipPath === '_rels/.rels'
          ? ''
          : `${relationshipPath.slice(0, marker)}/${relationshipPath.slice(marker + 7, -5)}`
      try {
        controlVml = protectedParts.has(
          resolveRelTarget(owner, (a.Target ?? '').replaceAll('&amp;', '&')),
        )
      } catch {
        controlVml = true
      }
    }
    return macroBinding || controlVml
      ? [JSON.stringify([a.Id, a.Type, a.Target, a.TargetMode ?? 'Internal'])]
      : []
  })
}
function protectedContentTypes(xml: string, protectVml: boolean): string[] {
  return [
    ...xml.matchAll(/<(?:[\w.-]+:)?(?:Default|Override)\b((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g),
  ].flatMap((match) => {
    const a = attributes(match[1]!)
    return /macroEnabled|vbaProject|activeX|oleObject|controlproperties/i.test(
      a.ContentType ?? '',
    ) ||
      (protectVml && /vmlDrawing/i.test(a.ContentType ?? ''))
      ? [JSON.stringify([a.PartName ?? a.Extension, a.ContentType])]
      : []
  })
}

/** VML is also the normal Excel note format. Only proven note-only drawings
 * may be rewritten by the note editor; mixed controls and unknown shapes stay protected. */
export function isPureNoteVml(xml: string): boolean {
  const shapes = [...xml.matchAll(/<(?:[\w.-]+:)?shape\b/g)]
  const clients = [...xml.matchAll(/<(?:[\w.-]+:)?ClientData\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)]
  return (
    shapes.length > 0 &&
    shapes.length === clients.length &&
    clients.every((match) => attributes(match[1]!).ObjectType === 'Note') &&
    !/\b(?:FmlaMacro|onAction|onClick)\b/i.test(xml)
  )
}
