// Synthetic Node RPC child only. This is not the Rust engine or a workbook parser.
const { existsSync } = require('node:fs')
const { createInterface } = require('node:readline')

// EOF on stdin must not manufacture process exit while accepted work remains.
setInterval(() => {}, 1000)
const input = createInterface({ input: process.stdin })
const reply = (requestId, result) =>
  process.stdout.write(`${JSON.stringify({ version: 1, requestId, ok: true, result })}\n`)
input.on('line', (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  if (request.command === 'cancel') {
    // An ACK for the cancel request is deliberately separate from the target's
    // completion. The target still waits for its owned fixture gate.
    reply(request.requestId, { cancellationReceived: true })
    return
  }
  if (request.command !== 'fixture_wait_file' || typeof request.gatePath !== 'string') {
    process.stdout.write(
      `${JSON.stringify({
        version: 1,
        requestId: request.requestId,
        ok: false,
        error: { code: 'fixture_command', message: 'Unknown synthetic lifecycle request' },
      })}\n`,
    )
    return
  }
  process.stdout.write(`${JSON.stringify({ fixtureAccepted: request.fixtureTag })}\n`)
  const poll = setInterval(() => {
    if (!existsSync(request.gatePath)) return
    clearInterval(poll)
    reply(request.requestId, { fixtureTag: request.fixtureTag, acknowledged: true })
  }, 10)
})

process.stdin.on('error', () => {})
process.on('SIGTERM', () => process.exit(0))
