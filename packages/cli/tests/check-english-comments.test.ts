import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = join(__dirname, '../../../tools/check-english-comments.mjs')
const HAN = String.fromCharCode(0x4e2d, 0x6587)

let repo: string
const fixtureRoot =
  process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Temp', 'vantage-comment-check-fixtures')
    : join(tmpdir(), 'vantage-comment-check-fixtures')
afterEach(() => {
  if (!repo) return
  if (!resolve(repo).startsWith(resolve(fixtureRoot) + sep))
    throw new Error('Refusing fixture cleanup outside the test root')
  rmSync(repo, { recursive: true, force: true })
})

function commit(files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body)
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })
}

function check(): { ok: boolean; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: 'utf-8' })
  return { ok: r.status === 0, stderr: r.stderr }
}

describe('check-english-comments', () => {
  beforeEach(() => {
    mkdirSync(fixtureRoot, { recursive: true })
    repo = mkdtempSync(join(fixtureRoot, 'repo-'))
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' })
  })

  it.each([
    ['lib.rs', `fn main() {} // ${HAN}\n`],
    ['build.py', `x = 1  # ${HAN}\n`],
    ['run.sh', `#!/bin/sh\necho hi # ${HAN}\n`],
  ])('flags a CJK comment in %s', (name, body) => {
    commit({ [name]: body })
    const r = check()
    expect(r.ok).toBe(false)
    expect(r.stderr).toContain(`${name}:`)
  })

  it('ignores CJK string literals and shebangs in the new languages', () => {
    commit({
      'lib.rs': `let s = "${HAN}"; // ok\n`,
      'build.py': `#!/usr/bin/env python3\ns = "${HAN}"  # fine\nt = '#${HAN}'\n`,
      'run.sh': `echo "${HAN}" # fine\n`,
    })
    expect(check().ok).toBe(true)
  })
})
