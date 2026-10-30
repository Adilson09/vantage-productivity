// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { applyRecoveryPatches, rewriteRecoveryCss } from '../src/main/html-draft-css'
describe('bounded source-preserving recovery CSS rewriting', () => {
  it('rewrites actual import/image-set/escaped URL tokens and keeps comments and text', async () => {
    const calls: Array<[string, string]> = []
    const source =
      '/* url(fake.png) */ @import "base.css" layer(base); .x{content:"url(fake.png)";background:image-set("small.png" 1x, url(large.png) 2x);mask:u\\72l(icon.svg#symbol)}'
    const result = await rewriteRecoveryCss(source, async (value, kind) => {
      calls.push([value, kind])
      return 'captured:' + value
    })
    expect(calls).toEqual([
      ['base.css', 'style'],
      ['small.png', 'image'],
      ['large.png', 'other'],
      ['icon.svg#symbol', 'other'],
    ])
    expect(result).toContain('/* url(fake.png) */')
    expect(result).toContain('content:"url(fake.png)"')
    expect(result).toContain('layer(base)')
  })
  it('does not interpret at-rule conditions or namespaces as resource fetches', async () => {
    const calls: string[] = []
    await rewriteRecoveryCss(
      '@namespace svg url(http://www.w3.org/2000/svg); @supports(background:url(condition.png)){.x{background:url(actual.png)}}',
      async (value) => {
        calls.push(value)
        return value
      },
    )
    expect(calls).toEqual(['actual.png'])
  })
  it('fails an unfinished resource expression while preserving ordinary unfinished declarations', async () => {
    expect(await rewriteRecoveryCss('.x{color:re', async (value) => value)).toBe('.x{color:re')
    await expect(
      rewriteRecoveryCss('.x{background:url("unfinished.png"', async (value) => value),
    ).rejects.toThrow(/unfinished|malformed/i)
  })
  it('bounds UTF-8 output before joining and rejects conflicting source ranges', () => {
    expect(() => applyRecoveryPatches('a', [{ from: 0, to: 1, text: '界界' }], 5)).toThrow(
      /limit|MiB/,
    )
    expect(() =>
      applyRecoveryPatches('abc', [
        { from: 0, to: 2, text: 'x' },
        { from: 1, to: 3, text: 'y' },
      ]),
    ).toThrow(/Overlapping/)
    expect(() =>
      applyRecoveryPatches('abc', [
        { from: 0, to: 1, text: 'x' },
        { from: 0, to: 1, text: 'y' },
      ]),
    ).toThrow(/Ambiguous/)
    expect(
      applyRecoveryPatches('abc', [
        { from: 0, to: 1, text: 'x' },
        { from: 0, to: 1, text: 'x' },
      ]),
    ).toBe('xbc')
  })
})
