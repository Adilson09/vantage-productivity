import type {ActionCtx} from './action-context'
import {slidesAuthored} from './slides-authored'
export function slidesActionApi(ctx:ActionCtx):typeof window.slidesApi{return ctx.api??window.slidesApi}
export async function slidesActionWork<Result>(ctx:ActionCtx,action:()=>Promise<Result>):Promise<Result>{const runtime=slidesAuthored();return runtime?runtime.work(ctx.closeScope??runtime.scope(),action):action()}
export async function slidesActionWait<Result>(ctx:ActionCtx,work:PromiseLike<Result>|Result):Promise<Result>{const runtime=slidesAuthored();return runtime?runtime.wait(ctx.closeScope??runtime.scope(),work):await work}
