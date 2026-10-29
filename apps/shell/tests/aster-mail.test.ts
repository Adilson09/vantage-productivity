// Aster Office addition (2026): fixed-path native launch, failure handling and handoff.
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { mailExecutablePath, openAsterMail, type MailLocation } from '../src/main/aster-mail'

const location: MailLocation = {
  isPackaged: true,
  resourcesPath: 'C:/Aster Office/resources',
  appPath: 'C:/Aster Office/resources/app.asar',
  platform: 'win32',
}
const regularFile = () => ({ isFile: () => true, isSymbolicLink: () => false })
function processWith(event: 'spawn' | 'error' | 'exit', code?: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  child.unref = vi.fn(() => child)
  queueMicrotask(() => {
    if (event === 'error') child.emit('error', new Error('Access denied'))
    else if (event === 'exit') child.emit('exit', code, null)
    else child.emit('spawn')
  })
  return child
}

describe('bundled Depesha companion', () => {
  it('uses a fixed bundled path rather than searching PATH or accepting message arguments', () => {
    expect(mailExecutablePath(location)).toBe(
      join(location.resourcesPath, 'mail', 'aster-mail.exe'),
    )
    expect(
      mailExecutablePath({ ...location, isPackaged: false, appPath: 'C:/repo/apps/shell' }),
    ).toBe(join('C:/repo', 'companions', 'depesha-bin', 'aster-mail.exe'))
  })
  it('reports a missing companion instead of opening another installed mail client', async () => {
    const start = vi.fn()
    const result = await openAsterMail(location, {
      checkFile: vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' })),
      start,
    })
    expect(result.opened).toBe(false)
    expect(result.error).toContain('Extract the full updated ZIP')
    expect(start).not.toHaveBeenCalled()
  })
  it('refuses a linked executable and does not start it', async () => {
    const start = vi.fn()
    const result = await openAsterMail(location, {
      checkFile: vi.fn().mockResolvedValue({ isFile: () => true, isSymbolicLink: () => true }),
      start,
    })
    expect(result.opened).toBe(false)
    expect(start).not.toHaveBeenCalled()
  })
  it('returns an actionable launch failure', async () => {
    const result = await openAsterMail(location, {
      checkFile: vi.fn().mockResolvedValue(regularFile()),
      start: () => processWith('error'),
    })
    expect(result.opened).toBe(false)
    expect(result.error).toContain('full Aster Office folder')
  })
  it('recognizes a successful single-instance focus handoff', async () => {
    const result = await openAsterMail(location, {
      checkFile: vi.fn().mockResolvedValue(regularFile()),
      start: () => processWith('exit', 0),
    })
    expect(result).toEqual({ opened: true })
  })
  it('reports an early crash without claiming an inbox is ready', async () => {
    const result = await openAsterMail(location, {
      checkFile: vi.fn().mockResolvedValue(regularFile()),
      start: () => processWith('exit', 1),
    })
    expect(result.opened).toBe(false)
    expect(result.error).toContain('closed before opening')
  })
  it('hands off a running companion and detaches its lifetime from the suite', async () => {
    let child: ChildProcess | undefined
    const start = vi.fn(() => (child = processWith('spawn')))
    const result = await openAsterMail(location, {
      checkFile: vi.fn().mockResolvedValue(regularFile()),
      start,
      startupDelayMs: 1,
    })
    expect(result).toEqual({ opened: true })
    expect(start).toHaveBeenCalledWith(join(location.resourcesPath, 'mail', 'aster-mail.exe'))
    expect(child!.unref).toHaveBeenCalledOnce()
  })
})
