/** Explicit local JSON-lines host. Run with the workspace's tsx loader. */
import { format } from 'node:util'
import { createInterface } from 'node:readline'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { atomicCopyFile, atomicWriteFile } from '@vantage/electron-utils/atomic-write'
import { decryptOoxml, encryptOoxml } from '../../../packages/electron-utils/src/ooxml-encryption'
import { withNativeSaveRecovery } from '../src/main/save-recovery'
import { XlsxSidecarClient } from '../src/main/xlsx-sidecar-client'
import {
  SpreadsheetBackendError,
  SpreadsheetDocumentBackend,
} from '../src/main/spreadsheet-document-backend'

// Library diagnostics stay on stderr; stdout contains protocol responses only.
for (const method of ['log', 'info', 'debug', 'warn', 'error'] as const) {
  console[method] = (...values: unknown[]) => {
    process.stderr.write(`${format(...values)}\n`)
  }
}

const rangeSchema = z
  .object({
    startRow: z.number().int().min(0).max(1_048_575),
    endRow: z.number().int().min(0).max(1_048_575),
    startColumn: z.number().int().min(0).max(16_383),
    endColumn: z.number().int().min(0).max(16_383),
  })
  .refine(
    (range) =>
      range.endRow >= range.startRow &&
      range.endColumn >= range.startColumn &&
      (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1) <= 20_000,
    { message: 'A read must be a valid viewport of at most 20,000 cells.' },
  )

function response(value: unknown): void {
  try {
    process.stdout.write(`${JSON.stringify(value)}\n`)
  } catch {
    process.stdout.write(
      '{"ok":false,"error":{"code":"response_encoding","message":"The response could not be encoded."}}\n',
    )
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) {
    response({
      ok: true,
      usage:
        'node --import tsx scripts/spreadsheet-backend-host.ts --binary <absolute-sidecar> --data <private-directory> --temp <private-temp-directory>',
      protocol: 'One JSON object per input/output line with requestId and command.',
      commands: [
        'open',
        'checkpoint',
        'snapshot',
        'read',
        'recalculate',
        'save',
        'close',
        'candidates',
        'recover',
        'capabilities',
      ],
    })
    return
  }
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (
      !key ||
      !['--binary', '--data', '--temp'].includes(key) ||
      !value ||
      !isAbsolute(value) ||
      flags.has(key)
    ) {
      throw new SpreadsheetBackendError(
        'invalid_configuration',
        'Provide --binary, --data and --temp once each, using absolute paths.',
      )
    }
    flags.set(key, value)
  }
  const binary = flags.get('--binary')
  const data = flags.get('--data')
  const temp = flags.get('--temp')
  if (!binary || !data || !temp)
    throw new SpreadsheetBackendError(
      'invalid_configuration',
      'The local host requires --binary, --data and --temp.',
    )
  process.env.VANTAGE_RECOVERY_ROOT = join(data, 'saved-versions')
  process.env.VANTAGE_RECOVERY_EXCLUDE_ROOT = data
  const client = new XlsxSidecarClient(binary)
  const backend = new SpreadsheetDocumentBackend({
    client,
    privateRoot: data,
    tempRoot: temp,
    encryptOoxml,
    decryptOoxml,
    atomicWriteFile,
    atomicCopyFile,
    withNativeSaveRecovery,
    onWarning: (message, error) => console.warn(message, error ?? ''),
  })
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const stop = () => {
    lines.close()
    process.stdin.destroy()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    for await (const line of lines) {
      let requestId: unknown = null
      try {
        const request = z
          .object({ requestId: z.union([z.string(), z.number()]).optional(), command: z.string() })
          .passthrough()
          .parse(JSON.parse(line))
        requestId = request.requestId ?? null
        let result: unknown
        switch (request.command) {
          case 'capabilities':
            result = backend.capabilities()
            break
          case 'open': {
            const args = z
              .object({ path: z.string(), password: z.string().optional() })
              .parse(request)
            result = await backend.open(
              args.path,
              args.password === undefined ? {} : { password: args.password },
            )
            break
          }
          case 'checkpoint': {
            const args = z
              .object({
                handle: z.string(),
                payload: z.unknown(),
                expectedRevision: z.number().int().nonnegative().optional(),
                commandId: z.string().optional(),
              })
              .parse(request)
            result = await backend.checkpoint(args.handle, args.payload, {
              ...(args.expectedRevision === undefined
                ? {}
                : { expectedRevision: args.expectedRevision }),
              ...(args.commandId === undefined ? {} : { commandId: args.commandId }),
            })
            break
          }
          case 'snapshot': {
            const args = z
              .object({ handle: z.string(), revision: z.number().int().nonnegative().optional() })
              .parse(request)
            result = await backend.snapshot(args.handle, args.revision)
            break
          }
          case 'read': {
            const args = z
              .object({ handle: z.string(), sheetId: z.string(), range: rangeSchema })
              .parse(request)
            result = await backend.readRange(args.handle, {
              sheetId: args.sheetId,
              range: args.range,
            })
            break
          }
          case 'recalculate': {
            const args = z
              .object({
                handle: z.string(),
                reads: z.array(z.object({ sheet: z.string(), range: rangeSchema })).max(1_000),
                revision: z.number().int().nonnegative().optional(),
              })
              .parse(request)
            result = await backend.recalculate(args.handle, args.reads, args.revision)
            break
          }
          case 'save': {
            const args = z
              .object({
                handle: z.string(),
                targetPath: z.string(),
                overwrite: z.boolean().optional(),
              })
              .parse(request)
            result = await backend.save(
              args.handle,
              args.targetPath,
              args.overwrite === undefined ? {} : { overwrite: args.overwrite },
            )
            break
          }
          case 'close': {
            const args = z
              .object({ handle: z.string(), discard: z.boolean().optional() })
              .parse(request)
            await backend.close(
              args.handle,
              args.discard === undefined ? {} : { discard: args.discard },
            )
            result = { closed: true }
            break
          }
          case 'candidates': {
            const args = z.object({ originalPath: z.string().optional() }).parse(request)
            result = await backend.candidates(args.originalPath)
            break
          }
          case 'recover': {
            const args = z
              .object({ candidateId: z.string().uuid(), originalPath: z.string() })
              .parse(request)
            result = await backend.recover(args.candidateId, args.originalPath)
            break
          }
          default:
            throw new SpreadsheetBackendError(
              'unsupported_command',
              'Unknown spreadsheet backend command.',
            )
        }
        response({ requestId, ok: true, result })
      } catch (error) {
        const details = error instanceof SpreadsheetBackendError ? error.details : undefined
        response({
          requestId,
          ok: false,
          error: {
            code:
              error instanceof Error && 'code' in error && typeof error.code === 'string'
                ? error.code
                : 'operation_failed',
            message: error instanceof Error ? error.message : String(error),
            ...(details === undefined ? {} : { details }),
          },
        })
      }
    }
  } finally {
    await backend.shutdown()
    client.stop()
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

void main().catch((error: unknown) => {
  response({
    ok: false,
    error: {
      code: 'host_startup_failed',
      message: error instanceof Error ? error.message : String(error),
    },
  })
  process.exitCode = 1
})
