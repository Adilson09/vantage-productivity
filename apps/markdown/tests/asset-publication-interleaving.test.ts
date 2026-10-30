// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyImageIntoOwnedAssets as markdownCopy, writeImageIntoOwnedAssets as markdownWrite, prepareAssetsForSaveAs as markdownPrepare } from '../src/main/asset-lifecycle'
import { copyImageIntoOwnedAssets as htmlCopy, writeImageIntoOwnedAssets as htmlWrite, prepareAssetsForSaveAs as htmlPrepare } from '../../html/src/main/asset-lifecycle'
import { reserveFileMutation } from '../../../packages/electron-utils/src/file-publication-exclusion'
vi.mock('node:fs/promises', async importOriginal => { const real = await importOriginal<typeof import('node:fs/promises')>(); return { ...real, copyFile: vi.fn(real.copyFile) } })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const prefix = join(realpathSync(tmpdir()), 'vantage-owned-asset-publication-')
let dir: string
beforeEach(async () => { dir = mkdtempSync(prefix); const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'); vi.mocked(copyFile).mockImplementation(real.copyFile) })
afterEach(() => { if (!dir.startsWith(prefix)) throw new Error('Unexpected test root'); rmSync(dir, { recursive: true, force: true }) })
describe.each([{ family: 'Markdown', copy: markdownCopy, write: markdownWrite, prepare:markdownPrepare, ext: 'md' }, { family: 'HTML', copy: htmlCopy, write: htmlWrite, prepare:htmlPrepare, ext: 'html' }])('$family actual asset entrypoints', ({ copy, write, prepare, ext }) => {
  it('keeps actual image copy and manifest bookkeeping ahead of an enclosing folder move', async () => {
    const oldDir = join(dir, 'old'), newDir = join(dir, 'new'); mkdirSync(oldDir)
    const document = join(oldDir, `document.${ext}`), image = join(dir, 'source.png'); writeFileSync(document, 'document'); writeFileSync(image, 'actual selected image')
    const entered = deferred(), finish = deferred(), real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(copyFile).mockImplementation(async (from, to, mode) => { if (String(from) === image) { entered.resolve(); await finish.promise }; return real.copyFile(from, to, mode) })
    let currentPath = document
    const assertCurrent = () => { if (currentPath !== document) throw new Error('source moved') }
    const save = copy(document, image, { retainUnproven: true, assertCurrent })
    await entered.promise
    const mutation = reserveFileMutation([{ path: oldDir, kind: 'directory' }, { path: newDir, kind: 'directory' }])
    let moved = false
    const move = mutation.run(async () => { renameSync(oldDir, newDir); currentPath = join(newDir, `document.${ext}`); moved = true })
    expect(moved).toBe(false)
    finish.resolve(); const relative = await save; await move
    expect(relative).toBe('assets/source.png')
    expect(readFileSync(join(newDir, 'assets', 'source.png'), 'utf8')).toBe('actual selected image')
    expect(existsSync(join(newDir, 'assets', '.vantage-assets.json'))).toBe(true)
    expect(existsSync(oldDir)).toBe(false)
  })
  it('refuses a completed-move obsolete callback before ensureAssetsDir can recreate the old folder', async () => {
    const oldDir = join(dir, 'old'), newDir = join(dir, 'new'); mkdirSync(oldDir); renameSync(oldDir, newDir)
    await expect(write(join(oldDir, `document.${ext}`), 'image.png', Buffer.from('obsolete image'), { retainUnproven: true, assertCurrent: () => { throw new Error('loaded source moved') } })).rejects.toThrow('loaded source moved')
    expect(existsSync(oldDir)).toBe(false)
  })
  it('the actual SaveAs asset entrypoint holds destination copy and manifest through an enclosing move',async()=>{
    const sourceDir=join(dir,'source'),targetDir=join(dir,'target'),movedDir=join(dir,'moved')
    mkdirSync(sourceDir);mkdirSync(join(sourceDir,'assets'));mkdirSync(targetDir)
    const source=join(sourceDir,`source.${ext}`),target=join(targetDir,`target.${ext}`),image=join(sourceDir,'assets','source.png')
    const text=ext==='md'?'![](assets/source.png)':'<img src="assets/source.png">'
    writeFileSync(source,text);writeFileSync(image,'source bytes')
    const entered=deferred(),finish=deferred(),real=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(copyFile).mockImplementation(async(from,to,mode)=>{if(realpathSync.native(String(from))===realpathSync.native(image)){entered.resolve();await finish.promise};return real.copyFile(from,to,mode)})
    const job=prepare(source,target,text,['assets/source.png'],{retainUnproven:true,assertCurrent:()=>{if(!existsSync(source))throw new Error('source changed')}})
    await entered.promise
    const mutation=reserveFileMutation([{path:targetDir,kind:'directory'},{path:movedDir,kind:'directory'}])
    const move=mutation.run(async()=>{renameSync(targetDir,movedDir)})
    finish.resolve();const prepared=await job;await move
    expect(prepared.created).toHaveLength(1)
    expect(readFileSync(join(movedDir,'assets',prepared.created[0]!.name),'utf8')).toBe('source bytes')
    expect(existsSync(join(movedDir,'assets','.vantage-assets.json'))).toBe(true)
    expect(existsSync(targetDir)).toBe(false)
  })
})
