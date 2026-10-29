import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = join(__dirname, '../../../tools/check-skill-version.mjs')

let repo: string
const fixtureRoot =
  process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Temp', 'vantage-skill-version-fixtures')
    : join(tmpdir(), 'vantage-skill-version-fixtures')
afterEach(() => {
  if (!repo) return
  if (!resolve(repo).startsWith(resolve(fixtureRoot) + sep))
    throw new Error('Refusing fixture cleanup outside the test root')
  rmSync(repo, { recursive: true, force: true })
})

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
}

function skill(name: string, version: string, body: string): string {
  return `---\nname: ${name}\ndescription: test\nmetadata:\n  version: ${version}\n---\n\n${body}\n`
}

function writeSkill(dir: string, content: string): void {
  mkdirSync(join(repo, 'skills', dir), { recursive: true })
  writeFileSync(join(repo, 'skills', dir, 'SKILL.md'), content)
}

function check(): { ok: boolean; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, '--base', 'HEAD'], {
    cwd: repo,
    encoding: 'utf-8',
  })
  return { ok: r.status === 0, stderr: r.stderr }
}

describe('check-skill-version', () => {
  beforeEach(() => {
    mkdirSync(fixtureRoot, { recursive: true })
    repo = mkdtempSync(join(fixtureRoot, 'repo-'))
    git('init', '-q')
    git('config', 'user.email', 'ci@example.com')
    git('config', 'user.name', 'ci')
    git('config', 'commit.gpgsign', 'false')
    git('config', 'core.hooksPath', join(repo, '.git', 'disabled-hooks'))
    writeSkill('demo', skill('demo', '1.0.0', 'Run `demo --help`.'))
    git('add', '.')
    git('commit', '-q', '-m', 'base')
  })

  it('passes when nothing changed and when the body change comes with a bump', () => {
    expect(check().ok).toBe(true)
    writeSkill('demo', skill('demo', '1.1.0', 'Run `demo --help` first.'))
    expect(check().ok).toBe(true)
  })

  it('fails a body change that keeps the version', () => {
    writeSkill('demo', skill('demo', '1.0.0', 'Run `demo --help` first.'))
    const r = check()
    expect(r.ok).toBe(false)
    expect(r.stderr).toContain('bump it')
  })

  it('ignores frontmatter-only edits and rejects a version going backwards', () => {
    writeSkill('demo', skill('demo', '1.0.0', 'Run `demo --help`.').replace('test', 'demo tool'))
    expect(check().ok).toBe(true)
    writeSkill('demo', skill('demo', '0.9.0', 'Run `demo --help`.'))
    expect(check().stderr).toContain('went backwards')
  })

  it('gates a nested skill as well as a top-level one', () => {
    writeSkill('group/demo', skill('demo', '1.0.0', 'x'))
    git('add', '.')
    git('commit', '-q', '-m', 'nested base')
    writeSkill('group/demo', skill('demo', '1.0.0', 'x changed'))
    const r = check()
    expect(r.ok).toBe(false)
    expect(r.stderr).toContain('bump it')
  })

  it('requires a version and a name matching the directory on new skills', () => {
    writeSkill('other', '---\nname: other\ndescription: x\n---\n\nbody\n')
    expect(check().stderr).toContain('needs metadata.version')
    writeSkill('other', skill('mismatch', '1.0.0', 'body'))
    expect(check().stderr).toContain('must match its directory')
  })
})
