import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { atomicWriteFile } from '../../../electron-utils/src/atomic-write'
import { flagString } from '../args'
import { resolveInput, resolveOutput } from '../fs'
import type { CommandDef } from '../registry'
import { CliError, EXIT } from '../result'
import type { DocumentLease } from '../../../productivity-engine/src/collaboration'

export const checkoutCommand: CommandDef = {
  name: 'checkout',
  summary:
    'Coordinate document checkouts and safe publication through a shared local SQLite lease registry.',
  usage:
    'checkout <reserve|list|verify|renew|release|publish> [document] --registry locks.sqlite [--lease lease.json] [--source prepared-file]',
  options: [
    {
      name: 'registry',
      value: 'file',
      description: 'Shared checkout registry used by all cooperating writers',
    },
    {
      name: 'lease',
      value: 'file',
      description:
        'Private lease file; reserve creates it, other actions read it (bearer token is never printed)',
    },
    {
      name: 'owner',
      value: 'name',
      description: 'reserve: displayed editor name (default current user)',
    },
    {
      name: 'ttl',
      value: 'ms',
      description: 'reserve/renew: duration, 1 second to 24 hours (default 15 minutes)',
    },
    {
      name: 'source',
      value: 'file',
      description: 'publish: complete new document bytes; conflict creates a separate copy',
    },
  ],
  async run(args, ctx) {
    const registrySpec = flagString(args, 'registry')
    if (!registrySpec) throw new CliError(EXIT.usage, 'Missing --registry path.')
    const registryPath = resolveOutput(registrySpec, ctx)
    const { DocumentCheckoutRegistry } =
      await import('../../../productivity-engine/src/collaboration')
    const registry = new DocumentCheckoutRegistry(registryPath)
    const publicLease = ({
      token: _token,
      ...lease
    }: DocumentLease): Omit<DocumentLease, 'token'> => lease
    try {
      const action = args.positionals[0]
      if (action === 'list')
        return {
          summary: `${registry.list().length} active checkouts.`,
          detail: { checkouts: registry.list() },
        }
      const leaseSpec = flagString(args, 'lease')
      if (!leaseSpec) throw new CliError(EXIT.usage, 'Missing --lease private lease file.')
      if (action === 'reserve') {
        const path = resolveInput(args.positionals[1], ctx)
        const leasePath = resolveOutput(leaseSpec, ctx, { fresh: true })
        const lease = registry.checkout(
          path,
          flagString(args, 'owner') ?? ctx.env.USERNAME ?? 'Vantage CLI',
          { ttlMs: Number(flagString(args, 'ttl') ?? 900000) },
        )
        try {
          writeFileSync(leasePath, JSON.stringify(lease, null, 2), { flag: 'wx', mode: 0o600 })
        } catch (error) {
          registry.release(lease)
          throw error
        }
        return {
          summary:
            'Document checked out. Keep the private lease file for reconnect and publication.',
          detail: {
            leasePath,
            lease: publicLease(lease),
            scope:
              'Cooperative local/shared-registry locking; document editors must use the checkout publication path to enforce it.',
          },
        }
      }
      const leasePath = resolveInput(leaseSpec, ctx)
      if (statSync(leasePath).size > 65536)
        throw new CliError(EXIT.file, 'Lease file exceeds 64 KiB.')
      const lease = JSON.parse(readFileSync(leasePath, 'utf8')) as DocumentLease
      if (ctx.env.VANTAGE_CHECKOUT_TOKEN) lease.token = ctx.env.VANTAGE_CHECKOUT_TOKEN
      resolveInput(lease.path, ctx)
      if (action === 'verify')
        return {
          summary: 'Checkout verified.',
          detail: { ...registry.verify(lease), lease: publicLease(lease) },
        }
      if (action === 'renew') {
        const renewed = registry.renew(lease, Number(flagString(args, 'ttl') ?? 900000))
        const output = resolveOutput(leasePath, ctx)
        await atomicWriteFile(output, Buffer.from(JSON.stringify(renewed, null, 2)))
        return { summary: 'Checkout renewed.', detail: { lease: publicLease(renewed) } }
      }
      if (action === 'release') {
        registry.release(lease)
        return { summary: 'Checkout released.', detail: { path: lease.path } }
      }
      if (action === 'publish') {
        resolveOutput(lease.path, ctx)
        const source = resolveInput(flagString(args, 'source'), ctx)
        if (statSync(source).size > 32 * 1024 * 1024)
          throw new CliError(EXIT.file, 'Prepared document exceeds 32 MiB.')
        const result = registry.publish(lease, readFileSync(source))
        if (result.status === 'published') {
          await atomicWriteFile(
            resolveOutput(leasePath, ctx),
            Buffer.from(JSON.stringify(result.lease, null, 2)),
          )
          return {
            summary: 'Published the checked-out document.',
            outputPath: lease.path,
            detail: { status: result.status, lease: publicLease(result.lease) },
          }
        }
        return {
          status: 'partial',
          summary:
            'The saved source changed; preserved it and wrote your edit to a separate conflict copy.',
          outputPath: result.conflictPath,
          detail: { ...result },
        }
      }
      throw new CliError(
        EXIT.usage,
        'Use checkout reserve, list, verify, renew, release or publish.',
      )
    } finally {
      registry.close()
    }
  },
}
