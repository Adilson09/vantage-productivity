// @vitest-environment node
import {describe,expect,it} from 'vitest'
import {createBlankPptx,openPptx,savePptx,addPicture} from '@vantage/pptx-engine'
import {captureSlidesSave,adoptSlidesSave} from '../src/main/slides-save-snapshot'
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH9sAAAAASUVORK5CYII=','base64')
async function fixture(){const opened=await openPptx(await createBlankPptx());const slide=opened.deck.slides[0]!;const picture=addPicture(opened,slide,{bytes:png,ext:'png',offset:{x:0,y:0,cx:1000000,cy:1000000}});if(!picture)throw new Error('Picture fixture failed');return{opened,slide,picture}}
describe('actual inert ordinary Slides save package',()=>{
 it('serializes complete embedded picture bytes without mutating the live deck or archive',async()=>{const f=await fixture(),frozen=captureSlidesSave(f.opened),deck=structuredClone(f.opened.deck),entries=[...f.opened.archive.entries].map(([key,value])=>[key,Buffer.from(value)]);const bytes=await savePptx(frozen),reopened=await openPptx(bytes);expect(reopened.deck.slides[0]!.elements.some(element=>element.type==='picture')).toBe(true);expect([...reopened.archive.entries.keys()].some(path=>path.startsWith('ppt/media/'))).toBe(true);expect(f.opened.deck).toEqual(deck);expect([...f.opened.archive.entries].map(([key,value])=>[key,Buffer.from(value)])).toEqual(entries)})
 it('keeps later live edits dirty instead of adopting the earlier published revision',async()=>{const f=await fixture(),frozen=captureSlidesSave(f.opened);await savePptx(frozen);f.slide.structureDirty=true;expect(adoptSlidesSave(f.opened,frozen,'1','2')).toBe(false);expect(f.slide.structureDirty).toBe(true)})
 it('adopts the represented package while preserving stable IDs for a peer pending editor',async()=>{const f=await fixture(),id=f.picture.id,frozen=captureSlidesSave(f.opened);await savePptx(frozen);expect(adoptSlidesSave(f.opened,frozen,'1','1')).toBe(true);expect(f.opened.deck.slides[0]!.elements.some(element=>element.id===id)).toBe(true);expect(f.opened.deck.slides[0]!.structureDirty).not.toBe(true)})
})
