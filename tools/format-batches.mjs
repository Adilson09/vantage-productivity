export const MAX_FORMAT_ARGUMENT_UNITS = 30_000

function argumentUnits(value) {
  // Allow for a quoted Windows argument, escaped quotes/backslashes, and its separator.
  let units = value.length + 3
  let backslashes = 0
  for (const character of value) {
    if (character === '\\') backslashes++
    else {
      if (character === '"') units += backslashes + 1
      backslashes = 0
    }
  }
  return units + backslashes
}

export function partitionFileArguments(fixedArguments, files) {
  const fixedUnits = fixedArguments.reduce((total, value) => total + argumentUnits(value), 0)
  const batches = []
  let current = []
  let units = fixedUnits
  for (const file of files) {
    const nextUnits = argumentUnits(file)
    if (fixedUnits + nextUnits > MAX_FORMAT_ARGUMENT_UNITS)
      throw new RangeError(`Formatting path exceeds the command-line limit: ${file}`)
    if (current.length && units + nextUnits > MAX_FORMAT_ARGUMENT_UNITS) {
      batches.push(current)
      current = []
      units = fixedUnits
    }
    current.push(file)
    units += nextUnits
  }
  if (current.length) batches.push(current)
  return batches
}

export function runArgumentBatches(batches, run, onSpawnError) {
  let status = 0
  for (const batch of batches) {
    const result = run(batch)
    if (result.error) {
      onSpawnError(result.error)
      if (status === 0) status = 1
    } else if (result.status !== 0 && status === 0) status = result.status ?? 1
  }
  return status
}
