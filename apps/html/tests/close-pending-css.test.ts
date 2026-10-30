import {describe,it,expect} from 'vitest'
import {pendingCssCanBeCommitted} from '../src/renderer/document/html-close-pending'
const supports=(property:string,value:string)=>({color:['red','blue'],width:['2px'],'font-size':['12px']} as Record<string,string[]>)[property]?.includes(value)===true
describe('Close refuses pending CSS that the manual parser would drop',()=>{
 it('allows complete static declarations with ordinary whitespace',()=>expect(pendingCssCanBeCommitted(' COLOR: red; width: 2px; ',supports)).toBe(true))
 it.each(['color:','unfinished','color:red; broken','width: calc(','--variable: red','color:{red}','color:red; color:invalid'])('retains unsupported field %s',value=>expect(pendingCssCanBeCommitted(value,supports)).toBe(false))
 it('bounds pending encoded text before parsing',()=>expect(pendingCssCanBeCommitted(' '.repeat(65537),supports)).toBe(false))
})
