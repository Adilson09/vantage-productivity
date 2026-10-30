import { parentPort, workerData } from 'node:worker_threads'
import { materializeHtmlDraft } from './html-draft-assets'
import { HTML_DRAFT_MAX_BYTES } from '../shared/html-draft'
import type { HtmlDraftAssetGrant } from './html-draft-assets'

async function run(): Promise<void> {
  if (!parentPort) throw new Error('HTML recovery worker has no parent.')
  const request = workerData as { bytes?: unknown; grant?: HtmlDraftAssetGrant;purpose?:unknown }
  if (
    !(request?.bytes instanceof Uint8Array) ||
    request.bytes.byteLength > HTML_DRAFT_MAX_BYTES ||
    !request.grant||request.purpose!==undefined&&request.purpose!=='close-proof'
  )
    throw new Error('Invalid HTML recovery worker request.')
  const result = await materializeHtmlDraft(Buffer.from(request.bytes), request.grant,{reportExecutableSeals:request.purpose==='close-proof'})
  const bytes = new Uint8Array(result.bytes.length)
  bytes.set(result.bytes)
  parentPort.postMessage({ bytes: bytes.buffer, remoteReferences: result.remoteReferences,...(request.purpose==='close-proof'?{unsealedExecutableReferences:result.unsealedExecutableReferences}:{}) }, [
    bytes.buffer,
  ])
}
void run().catch((error: unknown) => {
  parentPort?.postMessage({
    error: (error instanceof Error ? error.message : 'HTML recovery failed.').slice(0, 1024),
  })
})
