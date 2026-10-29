import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { atomicWriteFile } from '../../../electron-utils/src/atomic-write'
import {
  PROVIDER_REQUIREMENTS,
  syncGmailMail,
  syncGoogleCalendar,
  syncGraphMail,
  type ProviderCheckpoint,
  type ProviderOptions,
} from '../../../productivity-engine/src/providers'
import { flagBool, flagString } from '../args'
import { resolveInput, resolveOutput } from '../fs'
import type { CommandDef } from '../registry'
import { CliError, EXIT } from '../result'

export const providerCommand: CommandDef = {
  name: 'provider',
  summary:
    'Inspect provider requirements or explicitly fetch a bounded read-only mail/calendar sync using an environment token.',
  usage:
    'provider <info|sync graph-mail|gmail-mail|google-calendar> [--enable --out sync.json] [--checkpoint-in state.json --checkpoint-out state.json]',
  options: [
    {
      name: 'enable',
      description:
        'sync: explicitly allow this account read for the current invocation; a consented environment token is also required',
    },
    {
      name: 'out',
      value: 'file',
      description: 'sync: new private output file for records; credentials are never written',
    },
    {
      name: 'checkpoint-in',
      value: 'file',
      description: 'Saved provider checkpoint for incremental sync',
    },
    {
      name: 'checkpoint-out',
      value: 'file',
      description: 'Advance this checkpoint only after a complete successful sync',
    },
    {
      name: 'calendar',
      value: 'id',
      description: 'google-calendar: calendar identifier (default primary)',
    },
    { name: 'limit', value: 'n', description: 'Maximum changed records (default 1,000)' },
    { name: 'pages', value: 'n', description: 'Maximum pages (default 20)' },
    { name: 'timeout', value: 'ms', description: 'Whole-sync deadline (default 30,000 ms)' },
  ],
  async run(args, ctx) {
    if (args.positionals[0] === 'info')
      return {
        summary: 'Remote provider requirements. Sync runs only when explicitly invoked.',
        detail: {
          providers: PROVIDER_REQUIREMENTS,
          scope:
            'Read-only metadata/calendar sync; OAuth registration, consent, token refresh and live-account acceptance remain separate.',
        },
      }
    if (args.positionals[0] !== 'sync')
      throw new CliError(EXIT.usage, 'Use provider info or provider sync.')
    if (!flagBool(args, 'enable'))
      throw new CliError(
        EXIT.usage,
        'Provider sync requires --enable for this invocation after the user authorizes reading that account.',
      )
    const provider = args.positionals[1]
    if (!provider || !(provider in PROVIDER_REQUIREMENTS))
      throw new CliError(EXIT.usage, 'Choose graph-mail, gmail-mail or google-calendar.')
    const requirement = PROVIDER_REQUIREMENTS[provider as keyof typeof PROVIDER_REQUIREMENTS]
    const accessToken = ctx.env[requirement.tokenEnvironment]
    if (!accessToken)
      throw new CliError(
        EXIT.usage,
        `Set ${requirement.tokenEnvironment} in your environment after obtaining consent. Access tokens are never accepted as flags.`,
      )
    const output = resolveOutput(flagString(args, 'out'), ctx, { fresh: true })
    const checkpointOut = flagString(args, 'checkpoint-out')
      ? resolveOutput(flagString(args, 'checkpoint-out'), ctx)
      : undefined
    let checkpoint: ProviderCheckpoint | undefined
    const checkpointIn = flagString(args, 'checkpoint-in')
    if (checkpointIn) {
      const path = resolveInput(checkpointIn, ctx)
      if (statSync(path).size > 65536)
        throw new CliError(EXIT.file, 'Provider checkpoint exceeds 64 KiB.')
      checkpoint = JSON.parse(readFileSync(path, 'utf8')) as ProviderCheckpoint
    }
    const options: ProviderOptions = {
      enabled: true,
      accessToken,
      maxItems: Number(flagString(args, 'limit') ?? 1000),
      maxPages: Number(flagString(args, 'pages') ?? 20),
      deadlineMs: Number(flagString(args, 'timeout') ?? 30000),
    }
    const result =
      provider === 'graph-mail'
        ? await syncGraphMail(options, checkpoint)
        : provider === 'gmail-mail'
          ? await syncGmailMail(options, checkpoint)
          : await syncGoogleCalendar(options, flagString(args, 'calendar') ?? 'primary', checkpoint)
    // Materialize records before committing the checkpoint: if output cannot
    // be published, a later run re-fetches the changes rather than losing them.
    writeFileSync(
      output,
      JSON.stringify(
        {
          provider,
          items: result.items,
          deletedIds: result.deletedIds,
          complete: result.complete,
          ...(result.reason ? { reason: result.reason } : {}),
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    )
    if (result.complete && result.checkpoint && checkpointOut)
      await atomicWriteFile(checkpointOut, Buffer.from(JSON.stringify(result.checkpoint, null, 2)))
    return {
      status: result.complete ? 'ok' : 'partial',
      summary: `${result.items.length} records and ${result.deletedIds.length} deletions fetched; ${result.complete ? 'sync complete' : 'resource limit reached, checkpoint unchanged'}.`,
      outputPath: output,
      detail: {
        provider,
        records: result.items.length,
        deleted: result.deletedIds.length,
        complete: result.complete,
        checkpointSaved: Boolean(result.complete && checkpointOut),
        dataFlow: requirement.reads,
      },
    }
  },
}
