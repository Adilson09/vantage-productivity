import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const SNAPSHOT_NAME = new RegExp(`^${UUID}\\.xlsx$`, 'i')
const PROCESS_DIRECTORY_NAME = new RegExp(`^([1-9][0-9]{0,9})-${UUID}$`, 'i')
const SNAPSHOT_ROOT_NAME = 'vantage-sheets-sessions'
const MAX_SWEEP_ENTRIES = 10_000
const MAX_SWEEP_DEPTH = 8

export interface SessionSnapshotDirectoryOptions {
  readonly processId?: number
  readonly isProcessAlive?: (pid: number) => boolean | Promise<boolean>
}

function isOwned(info: Pick<Stats, 'uid'>): boolean {
  return typeof process.getuid !== 'function' || info.uid === process.getuid()
}

function processIdFromName(name: string): number | undefined {
  const match = PROCESS_DIRECTORY_NAME.exec(name)
  if (!match) return undefined
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid <= 0x7fff_ffff ? pid : undefined
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Permission failures and unknown errors cannot prove a process stopped.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function ownedDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isDirectory() && !info.isSymbolicLink() && isOwned(info)
  } catch {
    return false
  }
}

async function validatedRoot(tempRoot: string, create: boolean): Promise<string | undefined> {
  try {
    const temporary = await realpath(tempRoot)
    const root = join(temporary, SNAPSHOT_ROOT_NAME)
    if (create) {
      try {
        await mkdir(root, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    if (!(await ownedDirectory(root))) return undefined
    const canonical = await realpath(root)
    return dirname(canonical) === temporary ? canonical : undefined
  } catch (error) {
    if (create) throw error
    return undefined
  }
}

/**
 * Inspect the complete dead-owner tree before removing anything. Symlinks,
 * foreign ownership, special files, and unexpectedly large trees are retained.
 * Cleanup uses individual unlink/rmdir calls and never follows linked children.
 */
async function sweepDeadDirectory(
  root: string,
  name: string,
  currentPid: number,
  alive: (pid: number) => boolean | Promise<boolean>,
): Promise<void> {
  const pid = processIdFromName(name)
  if (pid === undefined || pid === currentPid || (await alive(pid))) return
  const directory = join(root, name)
  if (!(await ownedDirectory(directory))) return
  if (dirname(await realpath(directory)) !== root) return
  const files: string[] = []
  const directories: string[] = []
  let visited = 0
  const inspect = async (path: string, depth: number): Promise<boolean> => {
    if (depth > MAX_SWEEP_DEPTH || ++visited > MAX_SWEEP_ENTRIES) return false
    const info = await lstat(path)
    if (info.isSymbolicLink() || !isOwned(info)) return false
    if (info.isFile()) {
      files.push(path)
      return true
    }
    if (!info.isDirectory()) return false
    for (const child of await readdir(path)) {
      if (!(await inspect(join(path, child), depth + 1))) return false
    }
    directories.push(path)
    return true
  }
  if (!(await inspect(directory, 0)) || (await alive(pid))) return
  for (const path of files) {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || !isOwned(info)) return
    await unlink(path)
  }
  for (const path of directories) {
    if (!(await ownedDirectory(path))) return
    await rmdir(path)
  }
}

/** Allocate a private directory without retiring any current or live owner. */
export async function allocateSessionSnapshotDirectory(
  tempRoot: string,
  options: SessionSnapshotDirectoryOptions = {},
): Promise<string> {
  const pid = options.processId ?? process.pid
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fff_ffff) {
    throw new Error('Invalid snapshot directory process identity.')
  }
  const root = await validatedRoot(tempRoot, true)
  if (!root) throw new Error('The snapshot directory is not an owned regular directory.')
  const directory = join(root, `${pid}-${randomUUID()}`)
  await mkdir(directory, { mode: 0o700 })
  const alive = options.isProcessAlive ?? isProcessAlive
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    await sweepDeadDirectory(root, entry.name, pid, alive).catch(() => undefined)
  }
  return directory
}

/** Remove one current-process snapshot; keep the cached process directory. */
export async function cleanupSessionSnapshot(
  tempRoot: string,
  snapshotPath: string,
): Promise<void> {
  try {
    const suppliedPath = resolve(snapshotPath)
    if (!SNAPSHOT_NAME.test(basename(suppliedPath))) return
    const root = await validatedRoot(tempRoot, false)
    if (!root) return
    const suppliedParent = dirname(suppliedPath)
    if (!(await ownedDirectory(suppliedParent))) return
    const parent = await realpath(suppliedParent)
    // Legacy snapshots were direct children of the app snapshot root.
    if (parent !== root) {
      if (dirname(parent) !== root || processIdFromName(basename(parent)) !== process.pid) return
    }
    const path = join(parent, basename(suppliedPath))
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || !isOwned(info)) return
    await unlink(path)
  } catch {
    // Cleanup is best effort; missing, replaced, or locked files stay untouched.
  }
}
