import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args'
import { convertCommand } from '../src/commands/convert'
import { EXIT } from '../src/result'

const run = async (argv: string[], cwd: string) => {
  const ctx = { cwd, env: { ...process.env, VANTAGE_ALLOWED_ROOTS: '' }, log: () => {} }
  try {
    await convertCommand.run(parseArgs(argv, new Set(['force'])), ctx as never)
  } catch (e) {
    return e as { code?: number; reason?: string; message: string }
  }
  return null
}
const fixtureRoot =
  process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Temp', 'vantage-convert-link-fixtures')
    : join(tmpdir(), 'vantage-convert-link-fixtures')
const owned: string[] = []
afterEach(() => {
  for (const dir of owned.splice(0)) {
    if (!resolve(dir).startsWith(resolve(fixtureRoot) + sep))
      throw new Error('Unsafe fixture cleanup')
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('convert refuses to write over its own input', () => {
  it('rejects --out equal to the input even with --force, also through a symlink', async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    const dir = realpathSync(mkdtempSync(join(fixtureRoot, 'vantage-convert-')))
    owned.push(dir)
    writeFileSync(join(dir, 'notes.md'), '# hi')
    symlinkSync(join(dir, 'notes.md'), join(dir, 'alias.md'))
    const direct = await run(['notes.md', '--to', 'html', '--out', 'notes.md', '--force'], dir)
    expect(direct).toMatchObject({ code: EXIT.usage, reason: 'invalid_argument' })
    const viaLink = await run(['notes.md', '--to', 'html', '--out', 'alias.md', '--force'], dir)
    expect(viaLink).toMatchObject({ code: EXIT.usage, reason: 'invalid_argument' })
  })
})
