import { describe, expect, it, vi } from 'vitest'
import { batchAuthoredCells, createAuthoredCell } from '../src/authored-cell'

describe('canonical authored cells', () => {
  it('defers projection across related fields and a source stamp, keeping canonical reads immediate', () => {
    const a = createAuthoredCell('old', (commit) => commit()),
      b = createAuthoredCell(0, (commit) => commit())
    let source = 'A'
    const represented: unknown[] = []
    const project = () => represented.push([source, a.getSnapshot(), b.getSnapshot()])
    a.subscribe(project)
    b.subscribe(project)
    batchAuthoredCells(() => {
      a.set('new')
      expect(a.getSnapshot()).toBe('new')
      expect(represented).toEqual([])
      batchAuthoredCells(() => {
        b.set(1)
        source = 'B'
      })
      expect(represented).toEqual([])
    })
    expect(represented).toEqual([['B', 'new', 1]])
  })
  it('rejects an asynchronous batch instead of claiming its continuation was atomic', () => {
    expect(() => batchAuthoredCells(() => Promise.resolve())).toThrow('must be synchronous')
  })
  it('evaluates functional updates once in submission order before rendering', () => {
    const cell = createAuthoredCell<string[]>([], (commit) => commit())
    const project = vi.fn(),
      unsubscribe = cell.subscribe(project)
    const append = vi.fn((prior: string[]) => [...prior, 'one'])
    cell.set(append)
    cell.set((prior) => [...prior, 'two'])
    expect(cell.getSnapshot()).toEqual(['one', 'two'])
    expect(append).toHaveBeenCalledTimes(1)
    expect(project).toHaveBeenCalledTimes(2)
    unsubscribe()
    cell.set(['three'])
    expect(project).toHaveBeenCalledTimes(2)
  })
  it('holds author actions, then applies one commit even if a scheduler replays its callback', () => {
    const queue: Array<() => void> = []
    const cell = createAuthoredCell(0, (commit) => queue.push(commit))
    const author = vi.fn((prior: number) => prior + 1)
    cell.set(author)
    expect(cell.getSnapshot()).toBe(0)
    expect(author).not.toHaveBeenCalled()
    queue[0]!()
    queue[0]!()
    expect(cell.getSnapshot()).toBe(1)
    expect(author).toHaveBeenCalledTimes(1)
  })
  it('a retired source can drop a queued commit without authoring or notifying', () => {
    const queue: Array<() => void> = []
    const cell = createAuthoredCell('A', (commit) => queue.push(commit)),
      listener = vi.fn()
    cell.subscribe(listener)
    cell.set('obsolete')
    queue.length = 0
    expect(cell.getSnapshot()).toBe('A')
    expect(listener).not.toHaveBeenCalled()
  })
})
