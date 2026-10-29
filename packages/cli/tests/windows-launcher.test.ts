// Aster Office: exercise the actual batch wrappers against a safe fake source bundle.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './helpers'

describe.skipIf(process.platform !== 'win32')('Windows source launcher', () => {
  for (const command of ['aster.cmd', 'genoffice.cmd']) {
    it(`${command} uses Node, preserves arguments/exit code and restores the caller environment`, () => {
      const dir = join(tempDir(), 'checkout with spaces')
      const bin = join(dir, 'packages', 'cli', 'bin')
      const dist = join(dir, 'packages', 'cli', 'dist')
      mkdirSync(bin, { recursive: true })
      mkdirSync(dist, { recursive: true })
      for (const file of ['aster.cmd', 'genoffice.cmd'])
        copyFileSync(resolve(__dirname, '..', 'bin', file), join(bin, file))
      writeFileSync(
        join(dist, 'genoffice.cjs'),
        'console.log(JSON.stringify({args:process.argv.slice(2),appBin:process.env.GENOFFICE_APP_BIN||null,electron:process.env.ELECTRON_RUN_AS_NODE||null,profile:process.env.GENOFFICE_USER_DATA}));process.exit(17)',
      )
      const outer = join(dir, 'invoke.cmd')
      writeFileSync(
        outer,
        `@echo off\r\nset "GENOFFICE_USER_DATA=caller-profile"\r\ncall "${join(bin, command)}" "two words" third\r\nset "RESULT=%errorlevel%"\r\necho CALLER_PROFILE=%GENOFFICE_USER_DATA%\r\nexit /b %RESULT%\r\n`,
      )
      const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${outer}""`], {
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments: true,
        env: {
          ...process.env,
          GENOFFICE_APP_BIN: '',
          ASTER_USER_DATA: join(dir, 'scratch-profile'),
          ELECTRON_RUN_AS_NODE: '1',
        },
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(17)
      const lines = result.stdout.trim().split(/\r?\n/)
      expect(JSON.parse(lines[0]!)).toEqual({
        args: ['two words', 'third'],
        appBin: null,
        electron: null,
        profile: join(dir, 'scratch-profile'),
      })
      expect(lines.at(-1)).toBe('CALLER_PROFILE=caller-profile')
    })
  }

  it('reports an unbuilt checkout without trying an invalid packaged binary', () => {
    const dir = tempDir()
    const bin = join(dir, 'packages', 'cli', 'bin')
    mkdirSync(bin, { recursive: true })
    copyFileSync(resolve(__dirname, '..', 'bin', 'aster.cmd'), join(bin, 'aster.cmd'))
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${join(bin, 'aster.cmd')}""`], {
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: true,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Build the CLI first')
    expect(readFileSync(join(bin, 'aster.cmd'), 'utf8')).not.toContain('GenOffice.exe')
  })
})
