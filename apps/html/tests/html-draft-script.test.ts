// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { assertStaticHtmlRecoveryScript } from '../src/main/html-draft-script'

describe('positive static-data JavaScript recovery boundary', () => {
  it('accepts primitive, plain-object, array, static-template and imported data exports', () => {
    const source =
      'import data from "./data.mjs"; const count=-2; const message=`static text`; export const config={data,count,message,values:[null,true,3,"value"]}; export default config; export { data as named };'
    expect(() => assertStaticHtmlRecoveryScript(source)).not.toThrow()
    expect(() =>
      assertStaticHtmlRecoveryScript(
        'export { data } from "./data.mjs"; export * from "./more.mjs"',
      ),
    ).not.toThrow()
  })
  it.each([
    'const img=document.images[0]; img["src"]="assets/other.png";',
    'Object.assign(img,{src:"assets/other.png"});',
    'const sound=new Audio("assets/sound.mp3");',
    'const alias=fetch; alias("assets/other.png");',
    'const alias=window.fetch;',
    'const data={ ["src"]:"assets/other.png" };',
    'const data={ get value(){ return "asset.png" } };',
    'const copy={...source};',
    'const fn=()=>"asset.png";',
    'function loader(){ return "asset.png" }',
    'if(true){load()}',
    'for(;;){}',
    'let mutable="data";',
    'const value=import("./local.mjs");',
    'const url=import.meta.url;',
    'const value=`dynamic ${location}`;',
    'const value=globalThis;',
    'const pattern=/fetch/;',
  ])('refuses uncertain runtime/resource script: %s', (source) => {
    expect(() => assertStaticHtmlRecoveryScript(source)).toThrow(/Scripted-page|static data/)
  })
  it('bounds parsed token/node depth without evaluating input', () => {
    expect(() =>
      assertStaticHtmlRecoveryScript('const data=' + '['.repeat(140) + '0' + ']'.repeat(140) + ';'),
    ).toThrow(/structure budget/)
    expect(() =>
      assertStaticHtmlRecoveryScript('const data=[' + '0,'.repeat(100001) + '];'),
    ).toThrow(/token budget|structure budget/)
  })
})
