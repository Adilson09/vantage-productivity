import { statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import {
  atomicWriteFile,
  AtomicSaveConflictError,
  readAtomicFileVersion,
  type AtomicFileVersion,
} from './atomic-write'
import { withFilePublication } from './file-publication-exclusion'

export interface SelectedUserOutput {
  path: string
  /** Only a main-owned selection receipt supplies this; undefined pins now. */
  expectedVersion?: Readonly<AtomicFileVersion> | null
  /** Lazy bytes: selected versions are pinned before any renderer/materializer. */
  prepare(): Promise<Uint8Array>
}
const sameVersion = (
  a: Readonly<AtomicFileVersion> | null,
  b: Readonly<AtomicFileVersion> | null,
) =>
  a === null
    ? b === null
    : !!b &&
      a.size === b.size &&
      a.mtimeMs === b.mtimeMs &&
      a.ctimeMs === b.ctimeMs &&
      a.ino === b.ino &&
      a.dev === b.dev &&
      (a.sha256 === undefined || a.sha256 === b.sha256)
const pathKey = (path: string) =>
  process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)

/** Bounded one-use main grants across picker -> renderer -> main export. */
export class UserOutputSelections<Owner extends object> {
  private readonly entries = new Map<
    string,
    {
      owner: Owner
      paths: readonly string[]
      versions: readonly (Readonly<AtomicFileVersion> | null)[]
      proof: UserOutputSourceProof
      expires: number
    }
  >()
  constructor(private readonly now: () => number = Date.now) {}
  async capture(
    owner: Owner,
    paths: readonly string[],
    proof: UserOutputSourceProof = {},
  ): Promise<string> {
    if (!paths.length || paths.length > 4096) throw new Error('Invalid selected output count.')
    const exact = paths.map((path) => resolve(path)),
      captured = exact.map(pathKey),
      heldProof = { ...proof, sourcePaths: proof.sourcePaths ? [...proof.sourcePaths] : undefined }
    heldProof.assertCurrent?.()
    const versions = await withFilePublication(
      {
        targetPath: exact[0]!,
        additionalTargetPaths: exact.slice(1),
        sourcePaths: heldProof.sourcePaths,
      },
      async () => {
        const values = await Promise.all(exact.map((path) => readAtomicFileVersion(path)))
        heldProof.assertCurrent?.()
        return Object.freeze(
          values.map((value) => (value === null ? null : Object.freeze({ ...value }))),
        )
      },
    )
    heldProof.assertCurrent?.()
    for (const [id, entry] of this.entries) if (entry.expires <= this.now()) this.entries.delete(id)
    while (this.entries.size >= 64) this.entries.delete(this.entries.keys().next().value!)
    const id = randomUUID()
    this.entries.set(id, {
      owner,
      paths: Object.freeze(captured),
      versions,
      proof: heldProof,
      expires: this.now() + 300_000,
    })
    return id
  }
  claim(
    owner: Owner,
    id: unknown,
    paths: readonly string[],
  ): { versions: readonly (Readonly<AtomicFileVersion> | null)[]; proof: UserOutputSourceProof } {
    if (typeof id !== 'string')
      throw new Error('The selected export target receipt is unavailable.')
    const entry = this.entries.get(id)
    if (!entry || entry.owner !== owner)
      throw new Error('The selected export target receipt is unavailable.')
    this.entries.delete(id)
    if (
      entry.expires <= this.now() ||
      entry.paths.length !== paths.length ||
      paths.some((path, index) => pathKey(path) !== entry.paths[index])
    )
      throw new Error('The selected export target changed or expired. Select it again.')
    entry.proof.assertCurrent?.()
    return { versions: entry.versions, proof: entry.proof }
  }
  forget(owner: Owner): void {
    for (const [id, entry] of this.entries) if (entry.owner === owner) this.entries.delete(id)
  }
}
export interface UserOutputSourceProof {
  sourcePaths?: readonly string[]
  assertCurrent?(): void
  /** Main path/model adoption remains part of this actual operation. */
  afterPublished?(): void | Promise<void>
}

/** Main-only explicit selected outputs. This grants no loaded-document authority. */
export function publishSelectedUserOutputs(
  outputs: readonly SelectedUserOutput[],
  proof: UserOutputSourceProof = {},
): Promise<void> {
  if (!outputs.length) return Promise.resolve()
  if (outputs.length > 4096)
    return Promise.reject(
      new Error('Too many selected export destinations. Export a smaller batch.'),
    )
  const captured = outputs.map((output) => ({
    path: output.path,
    prepare: output.prepare,
    expectedVersion:
      output.expectedVersion === undefined
        ? undefined
        : output.expectedVersion === null
          ? null
          : Object.freeze({ ...output.expectedVersion }),
  }))
  proof.assertCurrent?.()
  return withFilePublication(
    {
      targetPath: captured[0]!.path,
      additionalTargetPaths: captured.slice(1).map((output) => output.path),
      sourcePaths: proof.sourcePaths,
    },
    async () => {
      // Ownership starts synchronously before this first metadata await. A Root
      // move cannot turn a formerly selected existing file into a fresh target.
      const versions = await Promise.all(
        captured.map(async (output) => {
          const version = await readAtomicFileVersion(output.path)
          if (output.expectedVersion !== undefined && !sameVersion(output.expectedVersion, version))
            throw new AtomicSaveConflictError()
          return output.expectedVersion !== undefined
            ? output.expectedVersion
            : version === null
              ? null
              : Object.freeze({ ...version })
        }),
      )
      for (let index = 0; index < captured.length; index++) {
        const output = captured[index]!
        proof.assertCurrent?.()
        const bytes = await output.prepare()
        proof.assertCurrent?.()
        await atomicWriteFile(output.path, Buffer.from(bytes), {
          expectedVersion: versions[index]!,
        })
      }
      await proof.afterPublished?.()
    },
  )
}
export function publishSelectedUserOutput(
  path: string,
  prepare: () => Promise<Uint8Array>,
  proof: UserOutputSourceProof = {},
  expectedVersion?: Readonly<AtomicFileVersion> | null,
): Promise<void> {
  return publishSelectedUserOutputs([{ path, prepare, expectedVersion }], proof)
}

/** Generated fresh outputs retain absence authority even if a peer wins a name. */
export function publishNewUserOutput(
  path: string,
  bytes: Uint8Array,
  afterPublished?: () => void | Promise<void>,
): Promise<void> {
  return withFilePublication({ targetPath: path }, async () => {
    await atomicWriteFile(path, Buffer.from(bytes), { expectedVersion: null })
    await afterPublished?.()
  })
}

/** Loaded/selected ticket remains authoritative through assets, bytes and adoption. */
export function withPinnedAssetOutput<T>(
  options: {
    targetPath: string
    expectedVersion: Readonly<AtomicFileVersion> | null
    sourceDocumentPath?: string
    assertCurrent(): void
  },
  actual: () => Promise<T>,
): Promise<T> {
  const { targetPath, sourceDocumentPath } = options
  const expected =
    options.expectedVersion === null ? null : Object.freeze({ ...options.expectedVersion })
  options.assertCurrent()
  // A selected directory that vanished is never silently recreated by asset
  // preparation. All Save/SaveAs dialogs select an existing parent directory.
  if (!statSync(dirname(targetPath)).isDirectory())
    throw new Error('The selected output directory is unavailable.')
  return withFilePublication(
    {
      targetPath: join(dirname(targetPath), 'assets'),
      targetKind: 'directory',
      additionalTargetPaths: [targetPath, ...(sourceDocumentPath ? [sourceDocumentPath] : [])],
      additionalTargetNamespaces: sourceDocumentPath
        ? [{ path: join(dirname(sourceDocumentPath), 'assets'), kind: 'directory' }]
        : [],
    },
    async () => {
      const current = await readAtomicFileVersion(targetPath)
      if (
        expected === null
          ? current !== null
          : !current ||
            current.size !== expected.size ||
            current.mtimeMs !== expected.mtimeMs ||
            current.ctimeMs !== expected.ctimeMs ||
            current.ino !== expected.ino ||
            current.dev !== expected.dev ||
            (expected.sha256 !== undefined && current.sha256 !== expected.sha256)
      )
        throw new AtomicSaveConflictError()
      options.assertCurrent()
      return actual()
    },
  )
}

/** Own selected-target metadata BEFORE arbitrary prepare hooks/materializers. */
export function withSelectedUserOutput<T>(
  path: string,
  actual: (expected: Readonly<AtomicFileVersion> | null) => Promise<T>,
  proof: UserOutputSourceProof = {},
): Promise<T> {
  proof.assertCurrent?.()
  return withFilePublication({ targetPath: path, sourcePaths: proof.sourcePaths }, async () => {
    const observed = await readAtomicFileVersion(path)
    const expected = observed === null ? null : Object.freeze({ ...observed })
    proof.assertCurrent?.()
    return actual(expected)
  })
}
