import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultCandidateDirs,
  homebrewBinDirs,
  inspectCliLink,
  installCliLink,
  isOurLauncher,
  pathHint,
} from '../src/install'

// File symlinks need NTFS on Windows; the suite TEMP may intentionally be exFAT.
const fixtureBase =
  process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? homedir(), 'Temp', 'vantage-cli-link-fixtures')
    : tmpdir()
const fixtureRoots: string[] = []
function tempDir(): string {
  mkdirSync(fixtureBase, { recursive: true })
  const root = mkdtempSync(join(fixtureBase, 'vantage-install-'))
  fixtureRoots.push(root)
  return root
}
afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    if (dirname(root) !== fixtureBase) throw new Error('Unexpected install fixture root')
    rmSync(root, { recursive: true, force: true })
  }
})
// chmod and native POSIX path handling cannot be emulated by Windows fs/path.
const posixOnly = process.platform === 'win32' ? it.skip : it

describe('installCliLink', () => {
  it('links into the first writable directory and is idempotent', () => {
    const dir = tempDir()
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const launcher = join(dir, 'app', 'vantage')
    mkdirSync(join(dir, 'app'))
    writeFileSync(launcher, '#!/bin/sh\n')
    expect(inspectCliLink({ launcher, platform: 'linux', candidateDirs: [bin] }).status).toBe(
      'missing',
    )
    const first = installCliLink({ launcher, platform: 'linux', candidateDirs: [bin] })
    expect(first).toEqual({ status: 'linked', location: join(bin, 'vantage') })
    expect(readlinkSync(join(bin, 'vantage'))).toBe(launcher)
    const again = installCliLink({ launcher, platform: 'linux', candidateDirs: [bin] })
    expect(again.status).toBe('present')
    expect(inspectCliLink({ launcher, platform: 'linux', candidateDirs: [bin] })).toEqual({
      status: 'present',
      location: join(bin, 'vantage'),
    })
  })

  it('replaces our stale symlink but never a real file or a foreign symlink', () => {
    const dir = tempDir()
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const launcher = join(dir, 'new-app', 'cli', 'vantage')
    mkdirSync(join(dir, 'new-app', 'cli'), { recursive: true })
    writeFileSync(launcher, '')
    symlinkSync(join(dir, 'old-app', 'cli', 'vantage'), join(bin, 'vantage'))
    expect(inspectCliLink({ launcher, platform: 'linux', candidateDirs: [bin] }).status).toBe(
      'missing',
    )
    expect(installCliLink({ launcher, platform: 'linux', candidateDirs: [bin] }).status).toBe(
      'linked',
    )
    expect(readlinkSync(join(bin, 'vantage'))).toBe(launcher)

    const npm = join(dir, 'npm-bin')
    mkdirSync(npm)
    const npmTarget = join(dir, 'lib', 'node_modules', 'vantage', 'bin', 'vantage.js')
    mkdirSync(join(npmTarget, '..'), { recursive: true })
    writeFileSync(npmTarget, '')
    symlinkSync(npmTarget, join(npm, 'vantage'))
    expect(installCliLink({ launcher, platform: 'linux', candidateDirs: [npm] }).status).toBe(
      'occupied',
    )
    expect(readlinkSync(join(npm, 'vantage'))).toBe(npmTarget)
    expect(inspectCliLink({ launcher, platform: 'linux', candidateDirs: [npm] }).status).toBe(
      'occupied',
    )
    const spare = join(dir, 'spare-bin')
    mkdirSync(spare)
    expect(inspectCliLink({ launcher, platform: 'linux', candidateDirs: [npm, spare] })).toEqual({
      status: 'missing',
      location: join(spare, 'vantage'),
      manual: expect.any(String),
    })
    expect(installCliLink({ launcher, platform: 'linux', candidateDirs: [npm, spare] })).toEqual({
      status: 'linked',
      location: join(spare, 'vantage'),
    })

    const taken = join(dir, 'taken')
    mkdirSync(taken)
    writeFileSync(join(taken, 'vantage'), 'someone else')
    const occupied = installCliLink({ launcher, platform: 'linux', candidateDirs: [taken] })
    expect(occupied.status).toBe('occupied')
    expect(occupied.manual).toContain('sudo')
    expect(occupied.manual).toContain('ln -sf')
    expect(lstatSync(join(taken, 'vantage')).isSymbolicLink()).toBe(false)
    expect(inspectCliLink({ launcher, platform: 'linux', candidateDirs: [taken] }).status).toBe(
      'occupied',
    )
  })

  posixOnly('POSIX mode bits: reports an unwritable directory with a manual command', () => {
    const dir = tempDir()
    const launcher = join(dir, 'vantage')
    writeFileSync(launcher, '')
    const locked = join(dir, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o555)
    const r = installCliLink({ launcher, platform: 'linux', candidateDirs: [locked] })
    const seen = inspectCliLink({ launcher, platform: 'linux', candidateDirs: [locked] })
    chmodSync(locked, 0o755)
    if (process.getuid?.() !== 0) {
      expect(r.status).toBe('unwritable')
      expect(r.manual).toContain(launcher)
      expect(seen.status).toBe('unwritable')
    }
  })

  it('owns only launchers shipped with the app, not any path ending in /cli/vantage (vantage#895)', () => {
    const dir = tempDir()
    const launcher = join(dir, 'Vantage.app', 'Contents', 'Resources', 'cli', 'vantage')
    mkdirSync(join(launcher, '..'), { recursive: true })
    writeFileSync(launcher, '#!/bin/sh\n')
    writeFileSync(join(launcher, '..', 'vantage.cjs'), '')

    const vendor = join(dir, 'opt', 'vendor', 'cli', 'vantage')
    mkdirSync(join(vendor, '..'), { recursive: true })
    writeFileSync(vendor, '#!/bin/sh\necho vendor\n')
    expect(isOurLauncher(vendor, launcher)).toBe(false)
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    symlinkSync(vendor, join(bin, 'vantage'))
    expect(installCliLink({ launcher, platform: 'linux', candidateDirs: [bin] })).toEqual({
      status: 'occupied',
      location: join(bin, 'vantage'),
      manual: expect.any(String),
    })
    expect(readlinkSync(join(bin, 'vantage'))).toBe(vendor)
    expect(inspectCliLink({ launcher, platform: 'linux', candidateDirs: [bin] }).status).toBe(
      'occupied',
    )

    const dead = join(dir, 'dead-bin')
    mkdirSync(dead)
    symlinkSync(join(dir, 'gone', 'cli', 'vantage'), join(dead, 'vantage'))
    expect(installCliLink({ launcher, platform: 'linux', candidateDirs: [dead] }).status).toBe(
      'linked',
    )
    expect(readlinkSync(join(dead, 'vantage'))).toBe(launcher)

    const older = join(dir, 'opt', 'Vantage', 'resources', 'cli', 'vantage')
    mkdirSync(join(older, '..'), { recursive: true })
    writeFileSync(older, '#!/bin/sh\n')
    writeFileSync(join(older, '..', 'vantage.cjs'), '')
    expect(isOurLauncher(older, launcher)).toBe(true)
    const upgraded = join(dir, 'upgraded-bin')
    mkdirSync(upgraded)
    symlinkSync(older, join(upgraded, 'vantage'))
    expect(installCliLink({ launcher, platform: 'linux', candidateDirs: [upgraded] }).status).toBe(
      'linked',
    )
    expect(readlinkSync(join(upgraded, 'vantage'))).toBe(launcher)

    const alias = join(dir, 'Applications')
    symlinkSync(join(dir, 'Vantage.app'), alias, process.platform === 'win32' ? 'junction' : 'dir')
    const viaAlias = join(alias, 'Contents', 'Resources', 'cli', 'vantage')
    expect(isOurLauncher(viaAlias, launcher)).toBe(true)
    const relative = join(dir, 'relative-bin')
    mkdirSync(relative)
    symlinkSync(join('..', 'opt', 'vendor', 'cli', 'vantage'), join(relative, 'vantage'))
    expect(installCliLink({ launcher, platform: 'linux', candidateDirs: [relative] }).status).toBe(
      'occupied',
    )
  })

  it('reports a missing /usr/local/bin as unwritable instead of skipping it', () => {
    const dir = tempDir()
    const launcher = join(dir, 'vantage')
    writeFileSync(launcher, '')
    const absent = join(dir, 'no-such-bin')
    const r = installCliLink({ launcher, platform: 'linux', candidateDirs: [absent] })
    expect(r.status).toBe('unwritable')
    expect(r.location).toBe(join(absent, 'vantage'))
    expect(r.manual).toContain('mkdir -p /usr/local/bin')
    expect(defaultCandidateDirs('darwin')[0]).toBe('/usr/local/bin')

    // inspect agrees with install: a later writable candidate counts
    const brew = join(dir, 'brew-bin')
    mkdirSync(brew)
    expect(inspectCliLink({ launcher, platform: 'darwin', candidateDirs: [absent, brew] })).toEqual(
      {
        status: 'missing',
        location: join(brew, 'vantage'),
        manual: expect.stringContaining('ln -sf'),
      },
    )
    expect(inspectCliLink({ launcher, platform: 'darwin', candidateDirs: [absent] }).status).toBe(
      'unwritable',
    )
  })

  posixOnly(
    'POSIX mode bits/PATH: falls back to $XDG_BIN_HOME, then ~/.local/bin, when the system dirs refuse (vantage#1019)',
    () => {
      const home = tempDir()
      expect(defaultCandidateDirs('linux', { HOME: home })).toEqual([
        '/usr/local/bin',
        join(home, '.local', 'bin'),
      ])
      expect(
        defaultCandidateDirs('darwin', { HOME: home, XDG_BIN_HOME: join(home, 'bin') }),
      ).toEqual(['/usr/local/bin', join(home, 'bin'), join(home, '.local', 'bin')])
      expect(defaultCandidateDirs('linux', { HOME: home, XDG_BIN_HOME: 'relative/bin' })).toEqual([
        '/usr/local/bin',
        join(home, '.local', 'bin'),
      ])

      const launcher = join(home, 'app', 'vantage')
      mkdirSync(join(home, 'app'))
      writeFileSync(launcher, '#!/bin/sh\n')
      const locked = join(home, 'locked')
      mkdirSync(locked)
      chmodSync(locked, 0o555)
      const userBin = join(home, '.local', 'bin')
      const env = { HOME: home, PATH: '/usr/bin:/bin' }
      const dirs = [locked, userBin]
      try {
        if (process.getuid?.() === 0) return
        expect(inspectCliLink({ launcher, platform: 'linux', candidateDirs: dirs, env })).toEqual({
          status: 'missing',
          location: join(userBin, 'vantage'),
          manual: expect.stringContaining('sudo'),
          pathHint: 'export PATH="$HOME/.local/bin:$PATH"',
        })
        expect(existsSync(userBin)).toBe(false)
        expect(installCliLink({ launcher, platform: 'linux', candidateDirs: dirs, env })).toEqual({
          status: 'linked',
          location: join(userBin, 'vantage'),
          pathHint: 'export PATH="$HOME/.local/bin:$PATH"',
        })
        expect(readlinkSync(join(userBin, 'vantage'))).toBe(launcher)
        const onPath = { ...env, PATH: `${userBin}/:${env.PATH}` }
        expect(
          installCliLink({ launcher, platform: 'linux', candidateDirs: dirs, env: onPath }),
        ).toEqual({ status: 'present', location: join(userBin, 'vantage') })
        // an explicit non-user dir never gets created or a PATH hint
        const absent = join(home, 'no-such-bin')
        expect(
          installCliLink({ launcher, platform: 'linux', candidateDirs: [absent], env }),
        ).toEqual({
          status: 'unwritable',
          location: join(absent, 'vantage'),
          manual: expect.any(String),
        })
        expect(existsSync(absent)).toBe(false)
      } finally {
        chmodSync(locked, 0o755)
      }
    },
  )

  it('writes the PATH hint only for directories the shell does not already search', () => {
    expect(pathHint('/home/u/.local/bin', { HOME: '/home/u', PATH: '/usr/bin' })).toBe(
      'export PATH="$HOME/.local/bin:$PATH"',
    )
    expect(pathHint('/opt/bin', { HOME: '/home/u', PATH: '/usr/bin:/opt/bin' })).toBeUndefined()
    expect(pathHint('/opt/bin', { HOME: '/home/u', PATH: '/opt/bin/' })).toBeUndefined()
    expect(pathHint('/opt/bin', { HOME: '/home/u', PATH: '' })).toBe('export PATH="/opt/bin:$PATH"')
  })

  it('edits the user PATH on Windows without expanding existing entries', () => {
    const scripts: string[] = []
    const run = (script: string) => {
      scripts.push(script)
      return { ok: true, stdout: scripts.length === 1 ? 'linked\n' : 'present\n' }
    }
    const launcher =
      "C:\\Users\\O'Brien\\AppData\\Local\\Programs\\Vantage\\resources\\vantage\\vantage.cmd"
    const dir = "C:\\Users\\O'Brien\\AppData\\Local\\Programs\\Vantage\\resources\\vantage"
    const first = installCliLink({ launcher, platform: 'win32', runPowerShell: run })
    expect(first).toEqual({ status: 'linked', location: dir })
    expect(scripts[0]).toContain("$dir = 'C:\\Users\\O''Brien\\AppData")
    expect(scripts[0]).toContain("'DoNotExpandEnvironmentNames'")
    expect(scripts[0]).toContain('RegistryValueKind]::ExpandString')
    expect(scripts[0]).toContain('SendMessageTimeout')
    expect(scripts[0]).not.toContain('SetEnvironmentVariable')
    expect(installCliLink({ launcher, platform: 'win32', runPowerShell: run }).status).toBe(
      'present',
    )
    const failed = installCliLink({
      launcher,
      platform: 'win32',
      runPowerShell: () => ({ ok: false, stdout: '' }),
    })
    expect(failed.status).toBe('unwritable')
    expect(failed.manual).toContain('SetEnvironmentVariable')
  })

  it('inspects the Windows PATH read-only', () => {
    const scripts: string[] = []
    const launcher = 'C:\\Vantage\\resources\\vantage\\vantage.cmd'
    const present = inspectCliLink({
      launcher,
      platform: 'win32',
      runPowerShell: (s) => (scripts.push(s), { ok: true, stdout: 'present\n' }),
    })
    expect(present.status).toBe('present')
    expect(present.location).toBe('C:\\Vantage\\resources\\vantage')
    expect(scripts[0]).not.toContain('SetValue')
    const missing = inspectCliLink({
      launcher,
      platform: 'win32',
      runPowerShell: () => ({ ok: true, stdout: 'missing\n' }),
    })
    expect(missing.status).toBe('missing')
    expect(missing.manual).toContain('SetEnvironmentVariable')
  })
})

describe('the Homebrew prefix is never written uninvited (vantage#1914)', () => {
  const none = () => false

  it('never offers /opt/homebrew/bin, and keeps the user directory', () => {
    const home = tempDir()
    const xdg = join(home, 'bin')
    for (const platform of ['darwin', 'linux'] as const) {
      const dirs = defaultCandidateDirs(platform, { HOME: home, XDG_BIN_HOME: xdg }, none)
      expect(
        dirs.some((d) => /homebrew/i.test(d)),
        `${platform}: ${dirs.join()}`,
      ).toBe(false)
      expect(dirs).toContain(xdg)
    }
  })

  posixOnly(
    'POSIX path handling: drops /usr/local/bin when it is a classic Intel Homebrew prefix, by env or by bin/brew',
    () => {
      const home = tempDir()
      const env = { HOME: home }
      expect(defaultCandidateDirs('darwin', env, none)[0]).toBe('/usr/local/bin')
      expect(
        defaultCandidateDirs('darwin', { ...env, HOMEBREW_PREFIX: '/usr/local/' }, none),
      ).toEqual([join(home, '.local', 'bin')])
      const intelBrew = (p: string) => p === '/usr/local/bin/brew'
      expect(defaultCandidateDirs('darwin', env, intelBrew)).toEqual([join(home, '.local', 'bin')])
      // Apple Silicon brew lives in /opt/homebrew: /usr/local/bin is still fine
      const armBrew = (p: string) => p === '/opt/homebrew/bin/brew'
      expect(defaultCandidateDirs('darwin', env, armBrew)[0]).toBe('/usr/local/bin')
      expect(homebrewBinDirs('darwin', env, armBrew)).toEqual(['/opt/homebrew/bin'])
      expect(defaultCandidateDirs('linux', { ...env, HOMEBREW_PREFIX: 'relative' }, none)[0]).toBe(
        '/usr/local/bin',
      )
    },
  )

  posixOnly(
    'POSIX path handling: does not break the unwritable report when the only system dir was the brew prefix',
    () => {
      const home = tempDir()
      const launcher = join(home, 'app', 'vantage')
      mkdirSync(join(home, 'app'))
      writeFileSync(launcher, '#!/bin/sh\n')
      const r = installCliLink({
        launcher,
        platform: 'darwin',
        env: { HOME: home, HOMEBREW_PREFIX: '/usr/local' },
        candidateDirs: defaultCandidateDirs(
          'darwin',
          { HOME: home, HOMEBREW_PREFIX: '/usr/local' },
          none,
        ),
      })
      expect(r.status).toBe('linked')
      expect(r.location).toBe(join(home, '.local', 'bin', 'vantage'))
    },
  )
  posixOnly(
    'POSIX mode bits: leaves a Homebrew-prefix directory alone even when it is the one writable',
    () => {
      // the shape that produced the report: every system dir is unwritable, and
      // the first directory the old walk found writable was the brew prefix
      const home = tempDir()
      const locked = join(home, 'locked')
      mkdirSync(locked)
      chmodSync(locked, 0o555)
      const launcher = join(home, 'app', 'vantage')
      mkdirSync(join(home, 'app'))
      writeFileSync(launcher, '#!/bin/sh\n')
      const userBin = join(home, '.local', 'bin')
      try {
        const r = installCliLink({
          launcher,
          platform: 'linux',
          env: { HOME: home },
          // stand in for the brew prefix: writable, and not one of ours
          candidateDirs: [locked, userBin],
        })
        expect(r.status).toBe('linked')
        expect(r.location).toBe(join(userBin, 'vantage'))
        // nothing landed anywhere but the directory we were told to consider
        expect(existsSync(join(userBin, 'vantage'))).toBe(true)
      } finally {
        chmodSync(locked, 0o755)
      }
    },
  )
})
