// @vitest-environment node
import { build, stop } from 'esbuild'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { getSlideNotes, openPptx } from '@vantage/pptx-engine'
import {
  listDraftJournal,
  restoreDraftCopy,
} from '../../../packages/electron-utils/src/draft-journal'

it('restores a complete media-containing presentation after the owning Node editor process dies', async () => {
  const work = await mkdtemp(join(tmpdir(), 'vantage-slides-crash-'))
  const project = resolve(import.meta.dirname, '../../..')
  const normalDocuments = join(work, 'Documents')
  const recovery = join(work, 'recovery')
  const childPath = join(work, 'journal-owner.cjs')
  const importedImage = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS2kAAAAASUVORK5CYII=',
    'base64',
  )
  let child: ChildProcess | undefined
  let closed: Promise<unknown> | undefined
  try {
    await mkdir(normalDocuments)
    const module = (file: string) => JSON.stringify(join(project, file).replaceAll('\\', '/'))
    const source = `
      import JSZip from 'jszip';
      import {createBlankPptx,openPptx} from ${module('packages/pptx-engine/src/index.ts')};
      import {runTxn} from ${module('packages/pptx-ops/src/index.ts')};
      import {SlidesDraftController} from ${module('apps/slides/src/main/slides-draft-controller.ts')};
      import {freezeSlidesDraft,serializeSlidesDraft} from ${module('apps/slides/src/main/slides-draft-package.ts')};
      (async()=>{
        const zip=await JSZip.loadAsync(await createBlankPptx());
        const image=Buffer.from(${JSON.stringify(importedImage.toString('base64'))},'base64');
        zip.file('ppt/media/imported.png',image);
        zip.file('[Content_Types].xml',(await zip.file('[Content_Types].xml').async('string')).replace('</Types>','<Default Extension="png" ContentType="image/png"/></Types>'));
        zip.file('customXml/unknown-preserved.xml','<vendor-data preserve="true">original opaque payload</vendor-data>');
        const slide=await zip.file('ppt/slides/slide1.xml').async('string');
        const picture='<p:pic><p:nvPicPr><p:cNvPr id="42" name="Imported picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdPicture42"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="1000" y="1000"/><a:ext cx="100000" cy="100000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
        zip.file('ppt/slides/slide1.xml',slide.replace('</p:spTree>',picture+'</p:spTree>'));
        const rels=await zip.file('ppt/slides/_rels/slide1.xml.rels').async('string');
        zip.file('ppt/slides/_rels/slide1.xml.rels',rels.replace('</Relationships>','<Relationship Id="rIdPicture42" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/imported.png"/></Relationships>'));
        const opened=await openPptx(await zip.generateAsync({type:'uint8array'}));
        const result=runTxn(opened,{ops:[{op:'addElement',target:{slide:0},kind:'textbox',offset:{x:2000,y:2000,cx:2000000,cy:1000000},paragraphs:[{runs:[{text:'base text'}]}]}]});
        if(!result.applied)throw new Error(JSON.stringify(result.failures));
        const element=opened.deck.slides[0].elements.find(el=>el.type==='text'||el.type==='shape');
        const source={path:'',opened};
        const controller=new SlidesDraftController({recoveryRoot:()=>${JSON.stringify(recovery)},sourceFor:id=>id===1?source:undefined,revisionFor:()=> '1:0',isLive:id=>id===1,capture:(_id,pending)=>{const copy=freezeSlidesDraft(source,pending);return()=>serializeSlidesDraft(copy)}});
        const token=controller.activate(1,null);
        const written=await controller.snapshot(1,{token,sequence:1,expectedRevision:'1:0',documentPath:null,pending:{text:{kind:'text',slideIndex:0,sourceId:element.id,paragraphs:[{runs:[{text:'latest focused words'}]}]},notes:{slideIndex:0,text:'speaker notes draft',baseline:''}}});
        if(!written)throw new Error('The complete draft was not committed');
        process.stdout.write(JSON.stringify({ready:true,token})+'\\n');
        setInterval(()=>{},1000);
      })().catch(error=>{console.error(error);process.exitCode=1});
    `
    await build({
      stdin: { contents: source, resolveDir: project, loader: 'ts' },
      outfile: childPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      logLevel: 'silent',
      loader: { '.md': 'text' },
      plugins: [
        {
          name: 'raw-operation-docs',
          setup(builder) {
            builder.onResolve({ filter: /\.md\?raw$/ }, (args) => ({
              path: resolve(args.resolveDir, args.path.slice(0, -4)),
              namespace: 'raw-operation-docs',
            }))
            builder.onLoad({ filter: /.*/, namespace: 'raw-operation-docs' }, async (args) => ({
              contents: await readFile(args.path, 'utf8'),
              loader: 'text',
            }))
          },
        },
      ],
    })
    child = spawn(process.execPath, [childPath], {
      cwd: project,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--max-old-space-size=512' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    closed = new Promise((done) => child!.once('close', done))
    let output = '',
      diagnostic = ''
    child.stderr!.on('data', (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString('utf8')).slice(0, 8192)
    })
    const ready = await new Promise<{ ready: boolean; token: string }>((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Draft owner startup exceeded its test budget: ' + diagnostic)),
        120000,
      )
      child!.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child!.once('exit', () => {
        clearTimeout(timer)
        reject(new Error('Draft owner exited before commit: ' + diagnostic))
      })
      child!.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (output.length > 4096) {
          clearTimeout(timer)
          reject(new Error('Unexpected child output'))
          return
        }
        const end = output.indexOf('\n')
        if (end >= 0) {
          clearTimeout(timer)
          try {
            done(JSON.parse(output.slice(0, end)))
          } catch (error) {
            reject(error)
          }
        }
      })
    })
    expect(ready.ready).toBe(true)
    expect(ready.token).toMatch(/^[0-9a-f-]{36}$/)
    // The child runs only this Node script and starts no descendants.
    child.kill('SIGKILL')
    await closed
    const entries = await listDraftJournal(recovery)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: ready.token, module: 'slides', documentPath: null })
    expect(await readdir(normalDocuments)).toEqual([])
    const recoveredPath = join(work, 'Recovered presentation.pptx')
    await restoreDraftCopy(recovery, ready.token, recoveredPath)
    const reopened = await openPptx(await readFile(recoveredPath))
    expect(reopened.archive.readText('ppt/slides/slide1.xml')).toContain('latest focused words')
    expect(getSlideNotes(reopened.archive, reopened.deck.slides[0]!.path)).toBe(
      'speaker notes draft',
    )
    expect(Buffer.from(reopened.archive.readBytes('ppt/media/imported.png')!)).toEqual(
      importedImage,
    )
    expect(reopened.archive.readText('customXml/unknown-preserved.xml')).toContain(
      'original opaque payload',
    )
    await expect(restoreDraftCopy(recovery, ready.token, recoveredPath)).rejects.toThrow()
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (closed) await closed
    stop()
    const target = resolve(work)
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith('vantage-slides-crash-')
    )
      throw new Error('Unsafe fixture cleanup path')
    await rm(target, { recursive: true, force: true })
  }
}, 180000)
