/** Printing is an interactive operation, outside the headless export lifetime. */
export interface SheetsPrintMode {
  recoveryDisabled: boolean
  headlessOwner: boolean
}

/** Gate the complete handler so refusal precedes even session/request effects. */
export function runInteractiveSheetsPrint<T>(mode: SheetsPrintMode, print: () => T): T {
  if (mode.recoveryDisabled || mode.headlessOwner) {
    throw new Error('Printing is unavailable during headless spreadsheet export.')
  }
  return print()
}
