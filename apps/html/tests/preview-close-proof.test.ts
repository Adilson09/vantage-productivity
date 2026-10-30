import { describe, it, expect } from 'vitest'
import { HtmlPreviewSnapshots, type HtmlPreviewFrame } from '../src/main/html-preview-snapshots'
const name = 'html-preview-00000000-0000-4000-8000-000000000001',
  stamp = { source: 'renderer:1', revision: '7' },
  grant = { documentPath: null, directory: null, realDirectory: null, files: [] }
function fixture(
  options: ConstructorParameters<typeof HtmlPreviewSnapshots>[0] = {
    urlFor: (owner) => 'html-preview://view-' + owner + '/',
  },
) {
  const store = new HtmlPreviewSnapshots(options)
  const publish = (owner = 1, source = '<p>safe</p>') =>
    store.publish(owner, source, source, null, grant)
  const frame = (url: string): HtmlPreviewFrame => ({
    name,
    url,
    processId: 11,
    routingId: 22,
    frameTreeNodeId: 33,
    frameToken: 'frame-token',
  })
  return { store, publish, frame }
}
describe('immutable served-source and main navigation close proof', () => {
  it('retains the actual loaded source when current source removed a runtime script', () => {
    const f = fixture(),
      loaded = f.publish(1, '<script>window.runtime()</script>')
    f.store.pinFrameUrls(1, [loaded.url])
    const current = f.publish(1, '<p>script removed</p>'),
      proof = f.store.begin(1, 'request', stamp, name, f.frame(loaded.url))
    expect(f.store.snapshotFor(proof)?.source).toContain('window.runtime')
    expect(f.store.snapshotFor(proof)?.id).not.toBe(current.id)
  })
  it('invalidates navigation away and back to the identical token URL', () => {
    const f = fixture(),
      snapshot = f.publish(),
      frame = f.frame(snapshot.url)
    f.store.pinFrameUrls(1, [snapshot.url])
    const proof = f.store.begin(1, 'request', stamp, name, frame)
    expect(f.store.validated(1, proof.id, frame)).toBe(true)
    expect(f.store.attest(1, 'request', proof.id, frame)).toBe(true)
    expect(f.store.ready(1, 'request', proof.id, stamp, frame)).toBe(true)
    f.store.navigate(1)
    f.store.navigate(1)
    expect(f.store.ready(1, 'request', proof.id, stamp, frame)).toBe(false)
    expect(f.store.attest(1, 'request', proof.id, frame)).toBe(false)
  })
  it('refuses redirected or foreign frames before a new nonce can be issued', () => {
    const f = fixture(),
      snapshot = f.publish()
    expect(() =>
      f.store.begin(1, 'request', stamp, name, f.frame('https://foreign.invalid/')),
    ).toThrow('foreign')
    expect(() => f.store.begin(2, 'request', stamp, name, f.frame(snapshot.url))).toThrow('foreign')
  })
  it('rejects stale worker results after a newer proof replaces them', () => {
    const f = fixture(),
      snapshot = f.publish(),
      frame = f.frame(snapshot.url)
    f.store.pinFrameUrls(1, [snapshot.url])
    const old = f.store.begin(1, 'old', stamp, name, frame),
      current = f.store.begin(1, 'current', stamp, name, frame)
    expect(f.store.validated(1, old.id, frame)).toBe(false)
    f.store.release(1, 'old')
    expect(f.store.validated(1, current.id, frame)).toBe(true)
  })
  it('binds sender request, complete frame identity and authored revision at synchronous commit', () => {
    const f = fixture(),
      snapshot = f.publish(),
      frame = f.frame(snapshot.url)
    f.store.pinFrameUrls(1, [snapshot.url])
    const proof = f.store.begin(1, 'request', stamp, name, frame)
    f.store.validated(1, proof.id, frame)
    f.store.attest(1, 'request', proof.id, frame)
    expect(f.store.ready(1, 'other', proof.id, stamp, frame)).toBe(false)
    expect(f.store.ready(1, 'request', proof.id, { ...stamp, revision: '8' }, frame)).toBe(false)
    expect(
      f.store.ready(1, 'request', proof.id, stamp, { ...frame, frameToken: 'replacement' }),
    ).toBe(false)
    expect(f.store.ready(1, 'request', proof.id, stamp, { ...frame, frameTreeNodeId: 44 })).toBe(
      false,
    )
    expect(f.store.ready(1, 'request', proof.id, stamp, frame)).toBe(true)
  })
  it('requires actual frame absence for an explicit retired/source-only proof', () => {
    const f = fixture(),
      proof = f.store.begin(1, 'request', stamp, name, null),
      snapshot = f.publish()
    f.store.validated(1, proof.id, null)
    f.store.attest(1, 'request', proof.id, null)
    expect(f.store.ready(1, 'request', proof.id, stamp, null)).toBe(true)
    expect(f.store.ready(1, 'request', proof.id, stamp, f.frame(snapshot.url))).toBe(false)
  })
  it('does not accumulate unpinned per-keystroke versions', () => {
    const f = fixture({
      urlFor: (owner) => 'html-preview://view-' + owner + '/',
      ownerLimit: 64,
      globalLimit: 64,
    })
    let old = ''
    for (let i = 0; i < 100; i++) {
      const snapshot = f.publish(1, '<p>' + i + '</p>')
      if (old) expect(f.store.read(1, old)).toBeNull()
      old = snapshot.id
    }
    expect(f.store.read(1, old)).not.toBeNull()
  })
  it('preserves the last good loaded snapshot on quota failure', () => {
    const f = fixture({
        urlFor: (owner) => 'html-preview://view-' + owner + '/',
        ownerLimit: 30,
        globalLimit: 30,
      }),
      snapshot = f.publish(1, '1234567890')
    f.store.pinFrameUrls(1, [snapshot.url])
    expect(() => f.publish(1, 'abcdefghij')).toThrow('retention is full')
    expect(f.store.read(1, snapshot.id)?.source).toBe('1234567890')
  })
  it('uses exact retirement and never lets a stale response reactivate or delete a newer source', () => {
    const f = fixture(),
      old = f.publish(),
      current = f.publish(1, '<p>new</p>')
    f.store.retire(1, old.id)
    expect(f.store.read(1, old.id)).toBeNull()
    expect(f.store.read(1, current.id)?.source).toBe('<p>new</p>')
    expect(() => f.store.begin(1, 'request', stamp, name, f.frame(old.url))).toThrow('retired')
  })
  it('reclaims owner retention on destruction and enforces the existing source budget first', () => {
    const f = fixture({
        urlFor: (owner) => 'html-preview://view-' + owner + '/',
        ownerLimit: 30,
        globalLimit: 30,
      }),
      snapshot = f.publish(1, '1234567890')
    expect(() => f.publish(2, '1234567890')).toThrow('retention is full')
    f.store.destroy(1)
    expect(f.publish(2, '1234567890').id).toBeTruthy()
    expect(() => f.publish(2, 'x'.repeat(16 * 1024 * 1024 + 1))).toThrow('16 MiB')
    expect(f.store.read(1, snapshot.id)).toBeNull()
  })
})
