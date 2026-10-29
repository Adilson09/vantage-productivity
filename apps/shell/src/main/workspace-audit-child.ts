import { auditFile } from './workspace-audit'

let request = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  request += chunk
  if (Buffer.byteLength(request) > 16_384) process.exit(2)
})
process.stdin.on('end', () => {
  void (async () => {
    try {
      const input: unknown = JSON.parse(request)
      if (
        !input ||
        typeof input !== 'object' ||
        typeof (input as { path?: unknown }).path !== 'string'
      )
        throw new Error('Invalid document inspection request.')
      const result = await auditFile((input as { path: string }).path)
      const output = JSON.stringify({ ok: true, result })
      if (Buffer.byteLength(output) > 2 * 1024 * 1024)
        throw new Error('Inspection output exceeded 2 MiB. The check is incomplete.')
      process.stdout.write(output, () => process.exit(0))
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : 'Document inspection failed.',
        }),
        () => process.exit(1),
      )
    }
  })()
})
