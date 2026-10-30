import { randomUUID } from 'node:crypto'
import type { CloseLeaseStamp } from '../../../../packages/electron-utils/src/close-lease'
import type { HtmlDraftAssetGrant } from './html-draft-assets'
const SOURCE_LIMIT = 16 * 1024 * 1024,
  INSTRUMENTATION_ALLOWANCE = 512 * 1024
export interface HtmlPreviewFrame {
  name: string
  url: string
  processId: number
  routingId: number
  frameTreeNodeId: number
  frameToken: string
}
export interface HtmlPreviewSnapshot {
  id: string
  owner: number
  source: string
  instrumented: string
  baseHref: string | null
  grant: HtmlDraftAssetGrant
  bytes: number
  retired: boolean
}
export interface HtmlPreviewProof {
  id: string
  owner: number
  requestId: string
  stamp: CloseLeaseStamp
  name: string
  frame: HtmlPreviewFrame | null
  snapshotId: string | null
  navigation: number
  phase: 'checking' | 'validated' | 'attested'
}
interface Owner {
  entries: Map<string, HtmlPreviewSnapshot>
  latest: string | null
  pinned: Set<string>
  navigation: number
  proof: HtmlPreviewProof | null
}
interface Options {
  urlFor(owner: number): string
  ownerLimit?: number
  globalLimit?: number
  entryLimit?: number
}
const sameFrame = (a: HtmlPreviewFrame | null, b: HtmlPreviewFrame | null) =>
  a === null
    ? b === null
    : !!b &&
      a.name === b.name &&
      a.url === b.url &&
      a.processId === b.processId &&
      a.routingId === b.routingId &&
      a.frameTreeNodeId === b.frameTreeNodeId &&
      a.frameToken === b.frameToken
/** Logical retained-source budgets, not a hard whole-process/RSS ceiling. */
export class HtmlPreviewSnapshots {
  private readonly owners = new Map<number, Owner>()
  constructor(private readonly options: Options) {}
  private owner(id: number): Owner {
    let state = this.owners.get(id)
    if (!state) {
      state = { entries: new Map(), latest: null, pinned: new Set(), navigation: 0, proof: null }
      this.owners.set(id, state)
    }
    return state
  }
  private count(): number {
    let bytes = 0
    for (const state of this.owners.values())
      for (const entry of state.entries.values()) bytes += entry.bytes
    return bytes
  }
  private kept(state: Owner, id: string): boolean {
    return state.pinned.has(id) || state.proof?.snapshotId === id
  }
  publish(
    owner: number,
    source: string,
    instrumented: string,
    baseHref: string | null,
    grant: HtmlDraftAssetGrant,
  ): { id: string; url: string } {
    if (
      typeof source !== 'string' ||
      typeof instrumented !== 'string' ||
      Buffer.byteLength(source, 'utf8') > SOURCE_LIMIT ||
      Buffer.byteLength(instrumented, 'utf8') > SOURCE_LIMIT + INSTRUMENTATION_ALLOWANCE
    )
      throw new Error('The preview exceeds the existing 16 MiB source budget.')
    const state = this.owner(owner),
      id = randomUUID(),
      entry: HtmlPreviewSnapshot = {
        id,
        owner,
        source,
        instrumented,
        baseHref,
        grant: { ...grant, files: grant.files.map((file) => ({ ...file })) },
        bytes: Buffer.byteLength(source, 'utf8') + Buffer.byteLength(instrumented, 'utf8'),
        retired: false,
      }
    const prior = [...state.entries.values()],
      keep = prior.filter((value) => this.kept(state, value.id)),
      bytes = keep.reduce((sum, value) => sum + value.bytes, entry.bytes),
      removed = prior.reduce((sum, value) => sum + value.bytes, 0)
    if (
      keep.length + 1 > (this.options.entryLimit ?? 4) ||
      bytes > (this.options.ownerLimit ?? 72 * 1024 * 1024) ||
      this.count() - removed + bytes > (this.options.globalLimit ?? 144 * 1024 * 1024)
    )
      throw new Error(
        'Preview source retention is full. The previous loaded preview is kept; use source-only editing or retry after it finishes loading.',
      )
    state.entries = new Map([...keep.map((value) => [value.id, value] as const), [id, entry]])
    state.latest = id
    const url = new URL(this.options.urlFor(owner))
    url.searchParams.set('snapshot', id)
    return { id, url: url.href }
  }
  idFromUrl(owner: number, url: string): string | null {
    try {
      const actual = new URL(url),
        base = new URL(this.options.urlFor(owner)),
        id = actual.searchParams.get('snapshot')
      return actual.protocol === base.protocol &&
        actual.host === base.host &&
        actual.pathname === base.pathname &&
        id &&
        /^[0-9a-f-]{36}$/.test(id)
        ? id
        : null
    } catch {
      return null
    }
  }
  read(owner: number, id: string): HtmlPreviewSnapshot | null {
    const value = this.owners.get(owner)?.entries.get(id)
    return value && !value.retired ? value : null
  }
  retire(owner: number, id: string): void {
    const state = this.owners.get(owner),
      entry = state?.entries.get(id)
    if (!state || !entry) return
    entry.retired = true
    if (state.latest === id) state.latest = null
    this.prune(state)
  }
  pinFrameUrls(owner: number, urls: readonly string[]): void {
    const state = this.owner(owner)
    state.pinned = new Set(
      urls
        .map((url) => this.idFromUrl(owner, url))
        .filter((id): id is string => !!id && state.entries.has(id)),
    )
    this.prune(state)
  }
  private prune(state: Owner): void {
    for (const id of state.entries.keys())
      if (id !== state.latest && !this.kept(state, id)) state.entries.delete(id)
  }
  navigate(owner: number): void {
    const state = this.owner(owner)
    state.navigation++
    if (!Number.isSafeInteger(state.navigation))
      throw new Error('Preview navigation identity overflow.')
    state.proof = null
    this.prune(state)
  }
  begin(
    owner: number,
    requestId: string,
    stamp: CloseLeaseStamp,
    name: string,
    frame: HtmlPreviewFrame | null,
  ): HtmlPreviewProof {
    const state = this.owner(owner)
    if (typeof name !== 'string' || !/^html-preview-[0-9a-f-]{36}$/.test(name))
      throw new Error('The owned preview frame identity is invalid.')
    const snapshotId = frame ? this.idFromUrl(owner, frame.url) : null
    if (frame && (!snapshotId || !this.read(owner, snapshotId)))
      throw new Error(
        'The actual loaded preview is foreign, redirected, retired or has no retained immutable source. Apply or discard its edits, or use source-only editing.',
      )
    const proof: HtmlPreviewProof = {
      id: randomUUID(),
      owner,
      requestId,
      stamp: { ...stamp },
      name,
      frame: frame ? { ...frame } : null,
      snapshotId,
      navigation: state.navigation,
      phase: 'checking',
    }
    state.proof = proof
    this.prune(state)
    return { ...proof, stamp: { ...proof.stamp }, frame: proof.frame ? { ...proof.frame } : null }
  }
  getProof(owner: number, id: string): HtmlPreviewProof | null {
    const proof = this.owners.get(owner)?.proof
    return proof?.id === id ? proof : null
  }
  snapshotFor(proof: HtmlPreviewProof): HtmlPreviewSnapshot | null {
    return proof.snapshotId ? this.read(proof.owner, proof.snapshotId) : null
  }
  matches(proof: HtmlPreviewProof, frame: HtmlPreviewFrame | null): boolean {
    const state = this.owners.get(proof.owner)
    return (
      !!state &&
      state.proof?.id === proof.id &&
      state.navigation === proof.navigation &&
      sameFrame(proof.frame, frame) &&
      (!proof.snapshotId || !!this.read(proof.owner, proof.snapshotId))
    )
  }
  validated(owner: number, id: string, frame: HtmlPreviewFrame | null): boolean {
    const proof = this.getProof(owner, id)
    if (!proof || proof.phase !== 'checking' || !this.matches(proof, frame)) return false
    proof.phase = 'validated'
    return true
  }
  attest(owner: number, requestId: string, id: string, frame: HtmlPreviewFrame | null): boolean {
    const proof = this.getProof(owner, id)
    if (
      !proof ||
      proof.requestId !== requestId ||
      !['validated', 'attested'].includes(proof.phase) ||
      !this.matches(proof, frame)
    )
      return false
    proof.phase = 'attested'
    return true
  }
  ready(
    owner: number,
    requestId: string,
    id: unknown,
    stamp: CloseLeaseStamp,
    frame: HtmlPreviewFrame | null,
  ): boolean {
    const proof = typeof id === 'string' ? this.getProof(owner, id) : null
    return (
      !!proof &&
      proof.phase === 'attested' &&
      proof.requestId === requestId &&
      proof.stamp.source === stamp.source &&
      proof.stamp.revision === stamp.revision &&
      this.matches(proof, frame)
    )
  }
  release(owner: number, requestId?: string): void {
    const state = this.owners.get(owner)
    if (!state || (requestId && state.proof?.requestId !== requestId)) return
    state.proof = null
    this.prune(state)
  }
  destroy(owner: number): void {
    this.owners.delete(owner)
  }
}
