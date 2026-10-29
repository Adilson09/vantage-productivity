#!/usr/bin/env node
import { discoverEngines, convertDocument, checkPdf } from './index.mjs'
const [command, ...args] = process.argv.slice(2)
const controller = new AbortController()
const cancel = () => controller.abort()
process.once('SIGINT', cancel)
process.once('SIGTERM', cancel)
try {
  let result
  if (command === 'engines') result = await discoverEngines({ signal: controller.signal })
  else if (command === 'convert' && args.length === 2)
    result = await convertDocument(args[0], args[1], { signal: controller.signal })
  else if (command === 'check-pdf' && args.length >= 1 && args.length <= 3)
    result = await checkPdf(args[0], {
      engine: args[1] ?? 'qpdf',
      flavour: args[2],
      signal: controller.signal,
    })
  else
    throw new Error(
      'Usage: vantage-engines engines | convert INPUT OUTPUT | check-pdf FILE [qpdf|verapdf] [FLAVOUR]',
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
