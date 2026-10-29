import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanFiles } from '../src/main/file-index/scan'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vantage-scan-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('scanFiles budget', () => {
  it('stops descending past the depth limit', () => {
    let deep = dir
    for (let level = 0; level < 6; level += 1) {
      deep = join(deep, `d${level}`)
      mkdirSync(deep)
      writeFileSync(join(deep, `f${level}.md`), 'x')
    }
    expect(scanFiles(dir)).toMatchObject({ truncated: false })
    expect(scanFiles(dir).files).toHaveLength(6)
    const shallow = scanFiles(dir, { maxDepth: 3 })
    expect(shallow.truncated).toBe(true)
    expect(shallow.files).toHaveLength(3)
    expect(shallow.files.some((f) => f.path.endsWith('f3.md'))).toBe(false)
  })

  it('stops collecting at the file budget', () => {
    for (let i = 0; i < 10; i += 1) writeFileSync(join(dir, `n${i}.md`), 'x')
    const capped = scanFiles(dir, { maxFiles: 4 })
    expect(capped.files).toHaveLength(4)
    expect(capped.truncated).toBe(true)
    expect(scanFiles(dir, { maxFiles: 10 }).truncated).toBe(false)
  })

  it('does not follow symlinked directories', (context) => {
    if (process.platform === 'win32') {
      if (!dir.startsWith(join(tmpdir(), 'vantage-scan-')))
        throw new Error('Unexpected scan fixture directory')
      rmSync(dir, { recursive: true, force: true })
      dir = mkdtempSync(join(homedir(), 'AppData', 'Local', 'Temp', 'vantage-scan-'))
    }
    mkdirSync(join(dir, 'real'))
    writeFileSync(join(dir, 'real', 'a.md'), 'x')
    try {
      symlinkSync(
        join(dir, 'real'),
        join(dir, 'real', 'loop'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )
      symlinkSync(
        join(dir, 'real'),
        join(dir, 'alias'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (
        ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL', 'EISDIR'].includes(
          code ?? '',
        )
      )
        context.skip(`Filesystem or account does not support directory links (${code})`)
      throw error
    }
    expect(scanFiles(dir).files.map((f) => f.path)).toEqual([join(dir, 'real', 'a.md')])
  })
})
