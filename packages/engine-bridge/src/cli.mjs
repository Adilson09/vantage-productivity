#!/usr/bin/env node
import { discoverEngines, convertDocument, checkPdf } from './index.mjs'
const argv = process.argv.slice(2)
let manifestPath
if (argv[0] === '--manifest') {
  argv.shift()
  manifestPath = argv.shift()
  if (!manifestPath || manifestPath.startsWith('--')) {
    process.stderr.write(
      JSON.stringify({ error: '--manifest requires a local JSON file path' }) + '\n',
    )
    process.exit(2)
  }
}
const [command, ...args] = argv
const controller = new AbortController()
const cancel = () => controller.abort()
process.once('SIGINT', cancel)
process.once('SIGTERM', cancel)
try {
  let result
  const options = { manifestPath, signal: controller.signal }
  if (command === 'engines' && args.length === 0) result = await discoverEngines(options)
  else if (command === 'convert' && args.length === 2)
    result = await convertDocument(args[0], args[1], options)
  else if (command === 'check-pdf' && args.length >= 1 && args.length <= 3)
    result = await checkPdf(args[0], {
      engine: args[1] ?? 'qpdf',
      flavour: args[2],
      ...options,
    })
  else
    throw new Error(
      'Usage: vantage-engines [--manifest FILE] engines | convert INPUT OUTPUT | check-pdf FILE [qpdf|verapdf] [FLAVOUR]',
    )
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (result?.status === 'fail' || result?.status === 'incomplete') process.exitCode = 2
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.message }) + '\n')
  process.exitCode = controller.signal.aborted ? 130 : 2
} finally {
  process.removeListener('SIGINT', cancel)
  process.removeListener('SIGTERM', cancel)
}
