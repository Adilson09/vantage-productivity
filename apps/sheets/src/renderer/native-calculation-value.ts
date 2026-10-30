/** Preserve engine types; formatted text is only a legacy-display fallback. */
export function nativeCalculationValue(cell: {
  readonly value?: number | string | boolean | null | { readonly error: string } | undefined
  readonly number?: number | undefined
  readonly formatted: string
}): number | string | boolean | null {
  if (cell.value !== undefined) {
    return typeof cell.value === 'object' && cell.value !== null ? cell.value.error : cell.value
  }
  return cell.number ?? cell.formatted
}
