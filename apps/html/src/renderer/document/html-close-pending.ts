/** The panel's manual parser drops invalid pieces. Close refuses that loss before flushing. */
export function pendingCssCanBeCommitted(css:string,supports:(property:string,value:string)=>boolean):boolean{
  if(css.length>65536)return false
  for(const part of css.split(';')){
    if(!part.trim())continue
    const colon=part.indexOf(':');if(colon<=0)return false
    const property=part.slice(0,colon).trim().toLowerCase(),value=part.slice(colon+1).trim()
    if(!/^-?[a-z][a-z0-9-]*$/.test(property)||!value||/[{}]/.test(value)||!supports(property,value))return false
  }
  return true
}
