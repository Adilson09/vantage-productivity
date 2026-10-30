export const VERAPDF_PROFILES = Object.freeze([
  '1a',
  '1b',
  '2a',
  '2b',
  '2u',
  '3a',
  '3b',
  '3u',
  '4',
  '4e',
  '4f',
  'ua1',
  'ua2',
])

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = (value) => Number.isSafeInteger(value) && value >= 0
function strictReportJson(text) {
  const stack = []
  let tokens = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      const start = i++
      for (; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++
      if (i >= text.length) throw new Error('Unterminated report string')
      const container = stack.at(-1)
      if (container?.keys && container.expectsKey) {
        const key = JSON.parse(text.slice(start, i + 1))
        if (key.length > 256 || container.keys.has(key))
          throw new Error('Duplicate or oversized report key')
        container.keys.add(key)
        container.expectsKey = false
      }
      tokens++
    } else if (char === '{' || char === '[') {
      stack.push(char === '{' ? { keys: new Set(), expectsKey: true } : {})
      if (stack.length > 32) throw new Error('Report nesting limit exceeded')
      tokens++
    } else if (char === '}' || char === ']') stack.pop()
    else if (char === ',') {
      if (stack.at(-1)?.keys) stack.at(-1).expectsKey = true
      tokens++
    }
    if (tokens > 100000) throw new Error('Report token limit exceeded')
  }
  return JSON.parse(text)
}
function profileId(name) {
  if (typeof name !== 'string' || name.length > 200) return null
  const a = /^PDF\/A-(\d[abuef]?) validation profile$/.exec(name)
  const ua = /^PDF\/UA-([12])(?: \+ Tagged PDF)? validation profile$/.exec(name)
  const id = a?.[1] ?? (ua ? 'ua' + ua[1] : null)
  return VERAPDF_PROFILES.includes(id) ? id : null
}

/** Decode the veraPDF 1.30 JSON contract, independently of its prose statements. */
export function parseVeraPdfReport(processResult, { flavour, expectedPath, expectedBytes } = {}) {
  const incomplete = (reason, report) => ({
    status: 'incomplete',
    conformance: { complete: false, requestedFlavour: flavour ?? 'auto', profiles: [], reason },
    ...(report ? { report } : {}),
  })
  if (processResult.stopped)
    return incomplete('The validator stopped: ' + processResult.stopped + '.')
  if (![0, 1].includes(processResult.code)) {
    const reasons = {
      3: 'The validator ran out of Java memory.',
      7: 'The validator could not parse this PDF.',
      8: 'The validator could not check an encrypted PDF.',
    }
    return incomplete(
      reasons[processResult.code] ??
        'The validator did not complete a standards check (exit ' + processResult.code + ').',
    )
  }
  let report
  try {
    if (
      typeof processResult.stdout !== 'string' ||
      Buffer.byteLength(processResult.stdout) > 4 * 1024 * 1024
    )
      return incomplete('The validator report exceeds its output budget.')
    report = strictReportJson(processResult.stdout)
  } catch {
    return incomplete('The validator did not return a complete JSON report.')
  }
  const body = report?.report
  const jobs = body?.jobs
  const summary = body?.batchSummary
  if (
    !object(body) ||
    !Array.isArray(jobs) ||
    jobs.length !== 1 ||
    !object(jobs[0]) ||
    !object(summary) ||
    summary.totalJobs !== 1 ||
    summary.multiJob !== false
  )
    return incomplete('The validator report does not describe exactly one input PDF.', report)
  const job = jobs[0]
  if (
    Object.hasOwn(job, 'taskException') ||
    !object(job.itemDetails) ||
    typeof job.itemDetails.name !== 'string' ||
    !count(job.itemDetails.size) ||
    job.itemDetails.size < 1 ||
    (expectedPath !== undefined && job.itemDetails.name !== expectedPath) ||
    (expectedBytes !== undefined && job.itemDetails.size !== expectedBytes)
  )
    return incomplete(
      'The validator report does not match the checked input or contains a task failure.',
      report,
    )
  for (const field of ['failedParsingJobs', 'failedEncryptedJobs', 'outOfMemory', 'veraExceptions'])
    if (summary[field] !== 0)
      return incomplete('The validator reported an incomplete parsing or processing task.', report)
  const results = job.validationResult
  if (
    !Array.isArray(results) ||
    results.length < 1 ||
    results.length > VERAPDF_PROFILES.length ||
    (flavour && results.length !== 1)
  )
    return incomplete('The validator did not return the expected profile results.', report)
  const profiles = []
  const seen = new Set()
  for (const result of results) {
    const id = object(result) ? profileId(result.profileName) : null
    const details = result?.details
    if (
      !id ||
      seen.has(id) ||
      (flavour && id !== flavour) ||
      result.jobEndStatus !== 'normal' ||
      typeof result.compliant !== 'boolean' ||
      !object(details) ||
      !['passedRules', 'failedRules', 'passedChecks', 'failedChecks'].every((key) =>
        count(details[key]),
      ) ||
      details.passedRules + details.failedRules < 1 ||
      details.passedChecks + details.failedChecks < 1 ||
      (result.compliant
        ? details.failedRules !== 0 || details.failedChecks !== 0
        : details.failedRules < 1 || details.failedChecks < 1)
    )
      return incomplete(
        'A profile result is missing, interrupted, contradictory or outside the requested standard.',
        report,
      )
    seen.add(id)
    profiles.push({
      id,
      name: result.profileName,
      compliant: result.compliant,
      passedRules: details.passedRules,
      failedRules: details.failedRules,
      passedChecks: details.passedChecks,
      failedChecks: details.failedChecks,
    })
  }
  const allCompliant = profiles.every((profile) => profile.compliant)
  const validation = summary.validationSummary
  // veraPDF counts complete input jobs here, even when one job checks several profiles.
  if (
    !object(validation) ||
    validation.totalJobCount !== 1 ||
    validation.successfulJobCount !== 1 ||
    validation.failedJobCount !== 0 ||
    validation.compliantPdfaCount !== (allCompliant ? 1 : 0) ||
    validation.nonCompliantPdfaCount !== (allCompliant ? 0 : 1) ||
    processResult.code !== (allCompliant ? 0 : 1)
  )
    return incomplete('The validator exit status and report totals disagree.', report)
  for (const field of ['featuresSummary', 'repairSummary']) {
    const task = summary[field]
    if (
      !object(task) ||
      task.totalJobCount !== 0 ||
      task.failedJobCount !== 0 ||
      task.successfulJobCount !== 0
    )
      return incomplete('The validator performed an unexpected nonvalidation task.', report)
  }
  return {
    status: allCompliant ? 'pass' : 'fail',
    report,
    conformance: {
      complete: true,
      requestedFlavour: flavour ?? 'auto',
      profiles,
      reason: allCompliant
        ? 'Passed the machine checks for the listed profiles.'
        : 'Did not meet the machine checks for one or more listed profiles.',
    },
  }
}
